const express = require('express');
const Joi = require('joi');
const { query } = require('../config/database');
const { optionalAuth } = require('../middleware/auth');

const router = express.Router();

// Get all specialties
router.get('/', optionalAuth, async (req, res) => {
  try {
    const specialtiesResult = await query(`
      SELECT 
        s.*,
        COUNT(d.id) as doctor_count
      FROM specialties s
      LEFT JOIN doctors d ON s.id = d.specialty_id AND d.is_available = true
      GROUP BY s.id
      ORDER BY s.name
    `);

    const specialties = specialtiesResult.rows.map(specialty => ({
      id: specialty.id,
      name: specialty.name,
      icon: specialty.icon,
      description: specialty.description,
      count: parseInt(specialty.doctor_count) || 0
    }));

    res.json({
      data: specialties
    });
  } catch (error) {
    console.error('Get specialties error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch specialties'
    });
  }
});

// Get specialty by ID with doctors
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const specialtyId = req.params.id;

    // Validate specialty ID
    const idValidation = Joi.number().integer().positive().validate(specialtyId);
    if (idValidation.error) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Invalid specialty ID'
      });
    }

    // Get specialty details
    const specialtyResult = await query(
      'SELECT * FROM specialties WHERE id = $1',
      [specialtyId]
    );

    if (specialtyResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Specialty not found'
      });
    }

    // Get doctors in this specialty
    const doctorsResult = await query(`
      SELECT 
        d.id,
        u.first_name,
        u.last_name,
        d.sub_specialty,
        d.experience_years,
        d.consultation_fee,
        d.rating,
        d.review_count,
        d.practice_address,
        d.consultation_modes,
        d.is_available
      FROM doctors d
      JOIN users u ON d.user_id = u.id
      WHERE d.specialty_id = $1 AND d.is_available = true AND u.is_active = true
      ORDER BY d.rating DESC, d.review_count DESC
    `, [specialtyId]);

    const specialty = specialtyResult.rows[0];
    const doctors = doctorsResult.rows.map(doctor => ({
      id: doctor.id,
      name: `Dr. ${doctor.first_name} ${doctor.last_name}`,
      subSpecialty: doctor.sub_specialty,
      experience: doctor.experience_years,
      consultationFee: parseFloat(doctor.consultation_fee),
      rating: parseFloat(doctor.rating),
      reviewCount: doctor.review_count,
      address: doctor.practice_address,
      consultationModes: doctor.consultation_modes,
      isAvailable: doctor.is_available
    }));

    res.json({
      data: {
        specialty: {
          id: specialty.id,
          name: specialty.name,
          icon: specialty.icon,
          description: specialty.description
        },
        doctors,
        doctorCount: doctors.length
      }
    });
  } catch (error) {
    console.error('Get specialty details error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch specialty details'
    });
  }
});

// Search specialties
router.get('/search', optionalAuth, async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.trim().length < 2) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Search query must be at least 2 characters long'
      });
    }

    const searchQuery = `%${q.trim().toLowerCase()}%`;

    const specialtiesResult = await query(`
      SELECT 
        s.*,
        COUNT(d.id) as doctor_count
      FROM specialties s
      LEFT JOIN doctors d ON s.id = d.specialty_id AND d.is_available = true
      WHERE LOWER(s.name) LIKE $1 OR LOWER(s.description) LIKE $1
      GROUP BY s.id
      ORDER BY s.name
      LIMIT 10
    `, [searchQuery]);

    const specialties = specialtiesResult.rows.map(specialty => ({
      id: specialty.id,
      name: specialty.name,
      icon: specialty.icon,
      description: specialty.description,
      count: parseInt(specialty.doctor_count) || 0
    }));

    res.json({
      data: specialties,
      query: q.trim()
    });
  } catch (error) {
    console.error('Search specialties error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to search specialties'
    });
  }
});

module.exports = router;