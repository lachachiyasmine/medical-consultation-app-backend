const express = require('express');
const Joi = require('joi');
const { query, transaction } = require('../config/database');
const { authenticateToken, requireDoctor, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// Get all doctors with filters
router.get('/', optionalAuth, async (req, res) => {
  try {
    const {
      specialty,
      location,
      consultationMode,
      minRating,
      maxFee,
      page = 1,
      limit = 10,
      sortBy = 'rating',
      sortOrder = 'desc',
      search
    } = req.query;

    // Validate query parameters
    const validationSchema = Joi.object({
      specialty: Joi.string().optional(),
      location: Joi.string().optional(),
      consultationMode: Joi.string().valid('ONLINE', 'OFFLINE').optional(),
      minRating: Joi.number().min(0).max(5).optional(),
      maxFee: Joi.number().min(0).optional(),
      page: Joi.number().integer().min(1).default(1),
      limit: Joi.number().integer().min(1).max(50).default(10),
      sortBy: Joi.string().valid('rating', 'fee', 'experience', 'name').default('rating'),
      sortOrder: Joi.string().valid('asc', 'desc').default('desc'),
      search: Joi.string().min(2).optional()
    });

    const { error, value } = validationSchema.validate(req.query);
    if (error) {
      return res.status(400).json({
        error: 'Validation Error',
        message: error.details[0].message
      });
    }

    const {
      specialty: specialtyFilter,
      location: locationFilter,
      consultationMode: modeFilter,
      minRating: minRatingFilter,
      maxFee: maxFeeFilter,
      page: pageNum,
      limit: pageLimit,
      sortBy: sortField,
      sortOrder: sortDir,
      search: searchQuery
    } = value;

    // Build WHERE conditions
    let whereConditions = [];
    let queryParams = [];
    let paramIndex = 1;

    // Base conditions
    whereConditions.push('d.is_available = true');
    whereConditions.push('u.is_active = true');

    // Specialty filter
    if (specialtyFilter) {
      whereConditions.push(`s.name ILIKE $${paramIndex}`);
      queryParams.push(`%${specialtyFilter}%`);
      paramIndex++;
    }

    // Location filter
    if (locationFilter) {
      whereConditions.push(`d.practice_address ILIKE $${paramIndex}`);
      queryParams.push(`%${locationFilter}%`);
      paramIndex++;
    }

    // Consultation mode filter
    if (modeFilter) {
      whereConditions.push(`$${paramIndex} = ANY(d.consultation_modes)`);
      queryParams.push(modeFilter);
      paramIndex++;
    }

    // Rating filter
    if (minRatingFilter) {
      whereConditions.push(`d.rating >= $${paramIndex}`);
      queryParams.push(minRatingFilter);
      paramIndex++;
    }

    // Fee filter
    if (maxFeeFilter) {
      whereConditions.push(`d.consultation_fee <= $${paramIndex}`);
      queryParams.push(maxFeeFilter);
      paramIndex++;
    }

    // Search filter
    if (searchQuery) {
      whereConditions.push(`(
        LOWER(u.first_name || ' ' || u.last_name) LIKE $${paramIndex} OR
        LOWER(d.sub_specialty) LIKE $${paramIndex} OR
        LOWER(s.name) LIKE $${paramIndex}
      )`);
      queryParams.push(`%${searchQuery.toLowerCase()}%`);
      paramIndex++;
    }

    // Build ORDER BY clause
    let orderBy = '';
    switch (sortField) {
      case 'rating':
        orderBy = `d.rating ${sortDir.toUpperCase()}, d.review_count DESC`;
        break;
      case 'fee':
        orderBy = `d.consultation_fee ${sortDir.toUpperCase()}`;
        break;
      case 'experience':
        orderBy = `d.experience_years ${sortDir.toUpperCase()}`;
        break;
      case 'name':
        orderBy = `u.first_name ${sortDir.toUpperCase()}, u.last_name ${sortDir.toUpperCase()}`;
        break;
      default:
        orderBy = 'd.rating DESC, d.review_count DESC';
    }

    // Calculate offset
    const offset = (pageNum - 1) * pageLimit;

    // Main query
    const doctorsQuery = `
      SELECT 
        d.id,
        u.first_name,
        u.last_name,
        u.email,
        s.name as specialty,
        d.sub_specialty,
        d.experience_years,
        d.qualifications,
        d.bio,
        d.consultation_fee,
        d.rating,
        d.review_count,
        d.practice_address,
        d.coordinates_lat,
        d.coordinates_lng,
        d.languages,
        d.insurance_accepted,
        d.consultation_modes,
        d.is_verified,
        (
          SELECT json_agg(
            json_build_object(
              'degree', de.degree,
              'institution', de.institution,
              'year', de.year_completed
            )
          )
          FROM doctor_education de
          WHERE de.doctor_id = d.id
        ) as education,
        (
          SELECT json_agg(
            json_build_object(
              'certification', dc.certification,
              'issuingBody', dc.issuing_body,
              'issueDate', dc.issue_date,
              'expiryDate', dc.expiry_date
            )
          )
          FROM doctor_certifications dc
          WHERE dc.doctor_id = d.id
        ) as certifications
      FROM doctors d
      JOIN users u ON d.user_id = u.id
      JOIN specialties s ON d.specialty_id = s.id
      WHERE ${whereConditions.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    queryParams.push(pageLimit, offset);

    // Count query for pagination
    const countQuery = `
      SELECT COUNT(*) as total
      FROM doctors d
      JOIN users u ON d.user_id = u.id
      JOIN specialties s ON d.specialty_id = s.id
      WHERE ${whereConditions.join(' AND ')}
    `;

    const countParams = queryParams.slice(0, -2); // Remove limit and offset

    // Execute queries
    const [doctorsResult, countResult] = await Promise.all([
      query(doctorsQuery, queryParams),
      query(countQuery, countParams)
    ]);

    const doctors = doctorsResult.rows.map(doctor => ({
      id: doctor.id,
      name: `Dr. ${doctor.first_name} ${doctor.last_name}`,
      email: doctor.email,
      specialty: doctor.specialty,
      subSpecialty: doctor.sub_specialty,
      experience: `${doctor.experience_years} ans`,
      qualifications: doctor.qualifications,
      bio: doctor.bio,
      consultationFee: parseFloat(doctor.consultation_fee),
      rating: parseFloat(doctor.rating),
      reviewCount: doctor.review_count,
      practiceAddress: doctor.practice_address,
      coordinates: doctor.coordinates_lat && doctor.coordinates_lng ? {
        lat: parseFloat(doctor.coordinates_lat),
        lng: parseFloat(doctor.coordinates_lng)
      } : null,
      languages: doctor.languages || [],
      insuranceAccepted: doctor.insurance_accepted || [],
      consultationModes: doctor.consultation_modes || [],
      isVerified: doctor.is_verified,
      education: doctor.education || [],
      certifications: doctor.certifications || []
    }));

    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / pageLimit);

    res.json({
      data: {
        doctors,
        pagination: {
          currentPage: pageNum,
          itemsPerPage: pageLimit,
          totalItems: total,
          totalPages,
          hasNextPage: pageNum < totalPages,
          hasPreviousPage: pageNum > 1
        },
        filters: {
          specialty: specialtyFilter,
          location: locationFilter,
          consultationMode: modeFilter,
          minRating: minRatingFilter,
          maxFee: maxFeeFilter,
          search: searchQuery
        }
      }
    });
  } catch (error) {
    console.error('Get doctors error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch doctors'
    });
  }
});

// Get doctor by ID
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const doctorId = req.params.id;

    // Validate doctor ID
    const idValidation = Joi.number().integer().positive().validate(doctorId);
    if (idValidation.error) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Invalid doctor ID'
      });
    }

    const doctorResult = await query(`
      SELECT 
        d.*,
        u.first_name,
        u.last_name,
        u.email,
        u.phone,
        s.name as specialty,
        s.icon as specialty_icon,
        (
          SELECT json_agg(
            json_build_object(
              'degree', de.degree,
              'institution', de.institution,
              'year', de.year_completed
            )
          )
          FROM doctor_education de
          WHERE de.doctor_id = d.id
        ) as education,
        (
          SELECT json_agg(
            json_build_object(
              'certification', dc.certification,
              'issuingBody', dc.issuing_body,
              'issueDate', dc.issue_date,
              'expiryDate', dc.expiry_date
            )
          )
          FROM doctor_certifications dc
          WHERE dc.doctor_id = d.id
        ) as certifications,
        (
          SELECT json_agg(
            json_build_object(
              'dayOfWeek', da.day_of_week,
              'startTime', da.start_time,
              'endTime', da.end_time,
              'isAvailable', da.is_available
            )
          )
          FROM doctor_availability da
          WHERE da.doctor_id = d.id
          ORDER BY da.day_of_week
        ) as availability
      FROM doctors d
      JOIN users u ON d.user_id = u.id
      JOIN specialties s ON d.specialty_id = s.id
      WHERE d.id = $1 AND d.is_available = true AND u.is_active = true
    `, [doctorId]);

    if (doctorResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Doctor not found'
      });
    }

    const doctor = doctorResult.rows[0];

    // Get available time slots for the next 7 days
    const slotsResult = await query(`
      SELECT 
        slot_date,
        slot_time,
        duration_minutes,
        consultation_mode,
        is_booked
      FROM doctor_time_slots
      WHERE doctor_id = $1 
        AND slot_date >= CURRENT_DATE 
        AND slot_date <= CURRENT_DATE + INTERVAL '7 days'
        AND is_booked = false
      ORDER BY slot_date, slot_time
      LIMIT 20
    `, [doctorId]);

    const availableSlots = slotsResult.rows.map(slot => `${slot.slot_date} ${slot.slot_time}`);

    res.json({
      data: {
        id: doctor.id,
        name: `Dr. ${doctor.first_name} ${doctor.last_name}`,
        email: doctor.email,
        phone: doctor.phone,
        specialty: doctor.specialty,
        specialtyIcon: doctor.specialty_icon,
        subSpecialty: doctor.sub_specialty,
        experience: `${doctor.experience_years} ans`,
        qualifications: doctor.qualifications,
        bio: doctor.bio,
        consultationFee: parseFloat(doctor.consultation_fee),
        rating: parseFloat(doctor.rating),
        reviewCount: doctor.review_count,
        practiceAddress: doctor.practice_address,
        coordinates: doctor.coordinates_lat && doctor.coordinates_lng ? {
          lat: parseFloat(doctor.coordinates_lat),
          lng: parseFloat(doctor.coordinates_lng)
        } : null,
        languages: doctor.languages || [],
        insuranceAccepted: doctor.insurance_accepted || [],
        consultationModes: doctor.consultation_modes || [],
        isVerified: doctor.is_verified,
        education: doctor.education || [],
        certifications: doctor.certifications || [],
        availability: doctor.availability || [],
        availableSlots,
        nextAvailable: availableSlots.length > 0 ? availableSlots[0] : null
      }
    });
  } catch (error) {
    console.error('Get doctor details error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch doctor details'
    });
  }
});

// Create or update doctor profile (for doctors only)
router.post('/profile', authenticateToken, requireDoctor, async (req, res) => {
  try {
    const validationSchema = Joi.object({
      bio: Joi.string().max(500).optional(),
      practiceAddress: Joi.string().max(200).optional(),
      coordinates: Joi.object({
        lat: Joi.number().min(-90).max(90).required(),
        lng: Joi.number().min(-180).max(180).required()
      }).optional(),
      languages: Joi.array().items(Joi.string()).optional(),
      insuranceAccepted: Joi.array().items(Joi.string()).optional(),
      consultationModes: Joi.array().items(Joi.string().valid('ONLINE', 'OFFLINE')).optional()
    });

    const { error, value } = validationSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation Error',
        message: error.details[0].message
      });
    }

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (value.bio !== undefined) {
      updates.push(`bio = $${paramIndex}`);
      params.push(value.bio);
      paramIndex++;
    }

    if (value.practiceAddress !== undefined) {
      updates.push(`practice_address = $${paramIndex}`);
      params.push(value.practiceAddress);
      paramIndex++;
    }

    if (value.coordinates) {
      updates.push(`coordinates_lat = $${paramIndex}`);
      params.push(value.coordinates.lat);
      paramIndex++;
      updates.push(`coordinates_lng = $${paramIndex}`);
      params.push(value.coordinates.lng);
      paramIndex++;
    }

    if (value.languages) {
      updates.push(`languages = $${paramIndex}`);
      params.push(value.languages);
      paramIndex++;
    }

    if (value.insuranceAccepted) {
      updates.push(`insurance_accepted = $${paramIndex}`);
      params.push(value.insuranceAccepted);
      paramIndex++;
    }

    if (value.consultationModes) {
      updates.push(`consultation_modes = $${paramIndex}`);
      params.push(value.consultationModes);
      paramIndex++;
    }

    if (updates.length === 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'No valid fields to update'
      });
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    params.push(req.doctor.id);

    const updateQuery = `
      UPDATE doctors 
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const result = await query(updateQuery, params);

    res.json({
      message: 'Doctor profile updated successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Update doctor profile error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update doctor profile'
    });
  }
});

module.exports = router;