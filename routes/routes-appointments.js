const express = require('express');
const Joi = require('joi');
const { query, transaction } = require('../config/database');
const { authenticateToken, requirePatient, requireDoctor } = require('../middleware/auth');

const router = express.Router();

// Book appointment (patients only)
router.post('/', authenticateToken, requirePatient, async (req, res) => {
  try {
    const validationSchema = Joi.object({
      doctorId: Joi.number().integer().positive().required(),
      appointmentDate: Joi.date().min('now').required(),
      appointmentTime: Joi.string().pattern(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).required(),
      consultationMode: Joi.string().valid('ONLINE', 'OFFLINE').required(),
      reasonForVisit: Joi.string().max(500).optional()
    });

    const { error, value } = validationSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation Error',
        message: error.details[0].message
      });
    }

    const { doctorId, appointmentDate, appointmentTime, consultationMode, reasonForVisit } = value;

    await transaction(async (client) => {
      // Check if doctor exists and is available
      const doctorResult = await client.query(`
        SELECT d.*, u.first_name, u.last_name, u.email
        FROM doctors d
        JOIN users u ON d.user_id = u.id
        WHERE d.id = $1 AND d.is_available = true AND u.is_active = true
      `, [doctorId]);

      if (doctorResult.rows.length === 0) {
        throw new Error('Doctor not found or not available');
      }

      const doctor = doctorResult.rows[0];

      // Check if consultation mode is supported
      if (!doctor.consultation_modes.includes(consultationMode)) {
        throw new Error(`Doctor does not support ${consultationMode} consultations`);
      }

      // Check if time slot is available
      const slotResult = await client.query(`
        SELECT id FROM doctor_time_slots
        WHERE doctor_id = $1 
          AND slot_date = $2 
          AND slot_time = $3 
          AND is_booked = false
      `, [doctorId, appointmentDate, appointmentTime]);

      if (slotResult.rows.length === 0) {
        throw new Error('Selected time slot is not available');
      }

      const slotId = slotResult.rows[0].id;

      // Create appointment
      const appointmentResult = await client.query(`
        INSERT INTO appointments (
          patient_id, doctor_id, slot_id, appointment_date, appointment_time,
          consultation_mode, reason_for_visit, consultation_fee, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'scheduled')
        RETURNING *
      `, [
        req.user.id,
        doctorId,
        slotId,
        appointmentDate,
        appointmentTime,
        consultationMode,
        reasonForVisit,
        doctor.consultation_fee
      ]);

      // Mark time slot as booked
      await client.query(`
        UPDATE doctor_time_slots 
        SET is_booked = true 
        WHERE id = $1
      `, [slotId]);

      // Create notifications for both patient and doctor
      const appointment = appointmentResult.rows[0];
      const appointmentDateTime = new Date(`${appointmentDate} ${appointmentTime}`);
      
      await client.query(`
        INSERT INTO notifications (user_id, type, title, message, related_appointment_id)
        VALUES 
        ($1, 'confirmation', 'Rendez-vous confirmé', 'Votre rendez-vous avec Dr. ${doctor.first_name} ${doctor.last_name} le ${appointmentDateTime.toLocaleDateString('fr-FR')} à ${appointmentTime} a été confirmé.', $2),
        ($3, 'new_appointment', 'Nouveau rendez-vous', 'Vous avez un nouveau rendez-vous avec ${req.user.firstName} ${req.user.lastName} le ${appointmentDateTime.toLocaleDateString('fr-FR')} à ${appointmentTime}.', $2)
      `, [req.user.id, appointment.id, doctor.user_id]);

      res.status(201).json({
        message: 'Appointment booked successfully',
        data: {
          id: appointment.id,
          doctorName: `Dr. ${doctor.first_name} ${doctor.last_name}`,
          appointmentDate: appointment.appointment_date,
          appointmentTime: appointment.appointment_time,
          consultationMode: appointment.consultation_mode,
          status: appointment.status,
          consultationFee: parseFloat(appointment.consultation_fee)
        }
      });
    });
  } catch (error) {
    console.error('Book appointment error:', error);
    
    if (error.message.includes('not found') || 
        error.message.includes('not available') ||
        error.message.includes('not support')) {
      return res.status(400).json({
        error: 'Bad Request',
        message: error.message
      });
    }
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to book appointment'
    });
  }
});

// Get user's appointments
router.get('/', authenticateToken, async (req, res) => {
  try {
    const {
      status,
      upcoming,
      page = 1,
      limit = 10
    } = req.query;

    const validationSchema = Joi.object({
      status: Joi.string().valid('scheduled', 'confirmed', 'completed', 'cancelled', 'no_show').optional(),
      upcoming: Joi.boolean().optional(),
      page: Joi.number().integer().min(1).default(1),
      limit: Joi.number().integer().min(1).max(50).default(10)
    });

    const { error, value } = validationSchema.validate(req.query);
    if (error) {
      return res.status(400).json({
        error: 'Validation Error',
        message: error.details[0].message
      });
    }

    let whereConditions = [];
    let queryParams = [];
    let paramIndex = 1;

    // User role-based filtering
    if (req.user.role === 'patient') {
      whereConditions.push(`a.patient_id = $${paramIndex}`);
      queryParams.push(req.user.id);
      paramIndex++;
    } else if (req.user.role === 'doctor') {
      whereConditions.push(`d.user_id = $${paramIndex}`);
      queryParams.push(req.user.id);
      paramIndex++;
    }

    // Status filter
    if (value.status) {
      whereConditions.push(`a.status = $${paramIndex}`);
      queryParams.push(value.status);
      paramIndex++;
    }

    // Upcoming appointments filter
    if (value.upcoming) {
      whereConditions.push(`a.appointment_date >= CURRENT_DATE`);
    }

    const offset = (value.page - 1) * value.limit;

    const appointmentsQuery = `
      SELECT 
        a.*,
        u_patient.first_name as patient_first_name,
        u_patient.last_name as patient_last_name,
        u_patient.email as patient_email,
        u_doctor.first_name as doctor_first_name,
        u_doctor.last_name as doctor_last_name,
        u_doctor.email as doctor_email,
        s.name as specialty,
        d.practice_address
      FROM appointments a
      JOIN users u_patient ON a.patient_id = u_patient.id
      JOIN doctors d ON a.doctor_id = d.id
      JOIN users u_doctor ON d.user_id = u_doctor.id
      JOIN specialties s ON d.specialty_id = s.id
      WHERE ${whereConditions.join(' AND ')}
      ORDER BY a.appointment_date DESC, a.appointment_time DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    queryParams.push(value.limit, offset);

    // Count query
    const countQuery = `
      SELECT COUNT(*) as total
      FROM appointments a
      JOIN doctors d ON a.doctor_id = d.id
      WHERE ${whereConditions.join(' AND ')}
    `;

    const countParams = queryParams.slice(0, -2); // Remove limit and offset

    const [appointmentsResult, countResult] = await Promise.all([
      query(appointmentsQuery, queryParams),
      query(countQuery, countParams)
    ]);

    const appointments = appointmentsResult.rows.map(appointment => ({
      id: appointment.id,
      patientName: `${appointment.patient_first_name} ${appointment.patient_last_name}`,
      patientEmail: appointment.patient_email,
      doctorName: `Dr. ${appointment.doctor_first_name} ${appointment.doctor_last_name}`,
      doctorEmail: appointment.doctor_email,
      specialty: appointment.specialty,
      appointmentDate: appointment.appointment_date,
      appointmentTime: appointment.appointment_time,
      consultationMode: appointment.consultation_mode,
      status: appointment.status,
      reasonForVisit: appointment.reason_for_visit,
      consultationFee: parseFloat(appointment.consultation_fee),
      practiceAddress: appointment.practice_address,
      createdAt: appointment.created_at
    }));

    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / value.limit);

    res.json({
      data: {
        appointments,
        pagination: {
          currentPage: value.page,
          itemsPerPage: value.limit,
          totalItems: total,
          totalPages,
          hasNextPage: value.page < totalPages,
          hasPreviousPage: value.page > 1
        }
      }
    });
  } catch (error) {
    console.error('Get appointments error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch appointments'
    });
  }
});

// Get specific appointment
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const appointmentId = req.params.id;

    const appointmentResult = await query(`
      SELECT 
        a.*,
        u_patient.first_name as patient_first_name,
        u_patient.last_name as patient_last_name,
        u_patient.email as patient_email,
        u_patient.phone as patient_phone,
        u_doctor.first_name as doctor_first_name,
        u_doctor.last_name as doctor_last_name,
        u_doctor.email as doctor_email,
        s.name as specialty,
        d.practice_address,
        d.coordinates_lat,
        d.coordinates_lng
      FROM appointments a
      JOIN users u_patient ON a.patient_id = u_patient.id
      JOIN doctors d ON a.doctor_id = d.id
      JOIN users u_doctor ON d.user_id = u_doctor.id
      JOIN specialties s ON d.specialty_id = s.id
      WHERE a.id = $1
    `, [appointmentId]);

    if (appointmentResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Appointment not found'
      });
    }

    const appointment = appointmentResult.rows[0];

    // Check access permissions
    const hasAccess = 
      (req.user.role === 'patient' && appointment.patient_id === req.user.id) ||
      (req.user.role === 'doctor' && appointment.doctor_id === req.doctor?.id) ||
      req.user.role === 'admin';

    if (!hasAccess) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have permission to view this appointment'
      });
    }

    res.json({
      data: {
        id: appointment.id,
        patientName: `${appointment.patient_first_name} ${appointment.patient_last_name}`,
        patientEmail: appointment.patient_email,
        patientPhone: appointment.patient_phone,
        doctorName: `Dr. ${appointment.doctor_first_name} ${appointment.doctor_last_name}`,
        doctorEmail: appointment.doctor_email,
        specialty: appointment.specialty,
        appointmentDate: appointment.appointment_date,
        appointmentTime: appointment.appointment_time,
        consultationMode: appointment.consultation_mode,
        status: appointment.status,
        reasonForVisit: appointment.reason_for_visit,
        notes: appointment.notes,
        prescription: appointment.prescription,
        consultationFee: parseFloat(appointment.consultation_fee),
        paymentStatus: appointment.payment_status,
        practiceAddress: appointment.practice_address,
        coordinates: appointment.coordinates_lat && appointment.coordinates_lng ? {
          lat: parseFloat(appointment.coordinates_lat),
          lng: parseFloat(appointment.coordinates_lng)
        } : null,
        meetingLink: appointment.meeting_link,
        createdAt: appointment.created_at,
        updatedAt: appointment.updated_at
      }
    });
  } catch (error) {
    console.error('Get appointment details error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch appointment details'
    });
  }
});

// Update appointment status (doctors only)
router.put('/:id/status', authenticateToken, requireDoctor, async (req, res) => {
  try {
    const appointmentId = req.params.id;
    
    const validationSchema = Joi.object({
      status: Joi.string().valid('confirmed', 'completed', 'cancelled', 'no_show').required(),
      notes: Joi.string().max(1000).optional(),
      prescription: Joi.string().max(1000).optional()
    });

    const { error, value } = validationSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation Error',
        message: error.details[0].message
      });
    }

    // Check if appointment belongs to this doctor
    const appointmentResult = await query(`
      SELECT a.*, d.user_id as doctor_user_id
      FROM appointments a
      JOIN doctors d ON a.doctor_id = d.id
      WHERE a.id = $1
    `, [appointmentId]);

    if (appointmentResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Appointment not found'
      });
    }

    const appointment = appointmentResult.rows[0];

    if (appointment.doctor_user_id !== req.user.id) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You can only update your own appointments'
      });
    }

    // Update appointment
    const updateFields = ['status = $2', 'updated_at = CURRENT_TIMESTAMP'];
    const params = [appointmentId, value.status];
    let paramIndex = 3;

    if (value.notes) {
      updateFields.push(`notes = $${paramIndex}`);
      params.push(value.notes);
      paramIndex++;
    }

    if (value.prescription) {
      updateFields.push(`prescription = $${paramIndex}`);
      params.push(value.prescription);
      paramIndex++;
    }

    const updateQuery = `
      UPDATE appointments 
      SET ${updateFields.join(', ')}
      WHERE id = $1
      RETURNING *
    `;

    const result = await query(updateQuery, params);

    // Create notification for patient
    let notificationMessage = '';
    switch (value.status) {
      case 'confirmed':
        notificationMessage = 'Votre rendez-vous a été confirmé par le médecin.';
        break;
      case 'completed':
        notificationMessage = 'Votre consultation a été marquée comme terminée.';
        break;
      case 'cancelled':
        notificationMessage = 'Votre rendez-vous a été annulé par le médecin.';
        break;
      case 'no_show':
        notificationMessage = 'Vous avez manqué votre rendez-vous.';
        break;
    }

    await query(`
      INSERT INTO notifications (user_id, type, title, message, related_appointment_id)
      VALUES ($1, 'status_update', 'Mise à jour du rendez-vous', $2, $3)
    `, [appointment.patient_id, notificationMessage, appointmentId]);

    res.json({
      message: 'Appointment status updated successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Update appointment status error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update appointment status'
    });
  }
});

// Cancel appointment
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const appointmentId = req.params.id;

    await transaction(async (client) => {
      // Get appointment details
      const appointmentResult = await client.query(`
        SELECT a.*, d.user_id as doctor_user_id
        FROM appointments a
        JOIN doctors d ON a.doctor_id = d.id
        WHERE a.id = $1
      `, [appointmentId]);

      if (appointmentResult.rows.length === 0) {
        throw new Error('Appointment not found');
      }

      const appointment = appointmentResult.rows[0];

      // Check permissions
      const canCancel = 
        (req.user.role === 'patient' && appointment.patient_id === req.user.id) ||
        (req.user.role === 'doctor' && appointment.doctor_user_id === req.user.id) ||
        req.user.role === 'admin';

      if (!canCancel) {
        throw new Error('You do not have permission to cancel this appointment');
      }

      // Can only cancel scheduled or confirmed appointments
      if (!['scheduled', 'confirmed'].includes(appointment.status)) {
        throw new Error('Cannot cancel appointment with current status');
      }

      // Update appointment status
      await client.query(`
        UPDATE appointments 
        SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [appointmentId]);

      // Free up the time slot
      await client.query(`
        UPDATE doctor_time_slots 
        SET is_booked = false 
        WHERE id = $1
      `, [appointment.slot_id]);

      // Create notifications
      const cancelledBy = req.user.role === 'patient' ? 'patient' : 'doctor';
      
      if (req.user.role === 'patient') {
        await client.query(`
          INSERT INTO notifications (user_id, type, title, message, related_appointment_id)
          VALUES ($1, 'cancellation', 'Rendez-vous annulé', 'Un patient a annulé son rendez-vous.', $2)
        `, [appointment.doctor_user_id, appointmentId]);
      } else {
        await client.query(`
          INSERT INTO notifications (user_id, type, title, message, related_appointment_id)
          VALUES ($1, 'cancellation', 'Rendez-vous annulé', 'Votre rendez-vous a été annulé par le médecin.', $2)
        `, [appointment.patient_id, appointmentId]);
      }

      res.json({
        message: 'Appointment cancelled successfully'
      });
    });
  } catch (error) {
    console.error('Cancel appointment error:', error);
    
    if (error.message.includes('not found') || 
        error.message.includes('permission') ||
        error.message.includes('Cannot cancel')) {
      return res.status(400).json({
        error: 'Bad Request',
        message: error.message
      });
    }
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to cancel appointment'
    });
  }
});

module.exports = router;