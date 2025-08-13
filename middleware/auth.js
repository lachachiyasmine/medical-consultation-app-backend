const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

// Middleware to authenticate JWT tokens
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Access token is required'
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Get fresh user data from database
    const userResult = await query(
      'SELECT id, email, first_name, last_name, role, is_active FROM users WHERE id = $1',
      [decoded.id]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid token - user not found'
      });
    }

    const user = userResult.rows[0];

    if (!user.is_active) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Account has been deactivated'
      });
    }

    // Attach user info to request
    req.user = {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      role: user.role,
      isActive: user.is_active
    };

    next();
  } catch (error) {
    console.error('JWT verification error:', error);
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Token has expired'
      });
    }
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid token'
      });
    }

    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Token verification failed'
    });
  }
};

// Middleware to authorize specific roles
const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required'
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Forbidden',
        message: `Access denied. Required roles: ${allowedRoles.join(', ')}`
      });
    }

    next();
  };
};

// Middleware specifically for doctor endpoints
const requireDoctor = async (req, res, next) => {
  if (!req.user || req.user.role !== 'doctor') {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Doctor access required'
    });
  }

  try {
    // Get doctor profile
    const doctorResult = await query(
      'SELECT id, is_available, is_verified FROM doctors WHERE user_id = $1',
      [req.user.id]
    );

    if (doctorResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Doctor profile not found'
      });
    }

    const doctor = doctorResult.rows[0];

    if (!doctor.is_available) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Doctor profile is not available'
      });
    }

    // Attach doctor info to request
    req.doctor = {
      id: doctor.id,
      isAvailable: doctor.is_available,
      isVerified: doctor.is_verified
    };

    next();
  } catch (error) {
    console.error('Doctor verification error:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to verify doctor status'
    });
  }
};

// Middleware to check if user is patient
const requirePatient = (req, res, next) => {
  if (!req.user || req.user.role !== 'patient') {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Patient access required'
    });
  }
  next();
};

// Middleware to check if user is admin
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Admin access required'
    });
  }
  next();
};

// Middleware to check resource ownership
const requireOwnership = (resourceUserIdField = 'user_id') => {
  return (req, res, next) => {
    const resourceUserId = req.body[resourceUserIdField] || req.params[resourceUserIdField];
    
    if (!req.user) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required'
      });
    }

    // Admin can access any resource
    if (req.user.role === 'admin') {
      return next();
    }

    // User can only access their own resources
    if (parseInt(resourceUserId) !== req.user.id) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You can only access your own resources'
      });
    }

    next();
  };
};

// Optional authentication middleware (for endpoints that work with or without auth)
const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return next(); // Continue without authentication
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const userResult = await query(
      'SELECT id, email, first_name, last_name, role, is_active FROM users WHERE id = $1',
      [decoded.id]
    );

    if (userResult.rows.length > 0 && userResult.rows[0].is_active) {
      const user = userResult.rows[0];
      req.user = {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        isActive: user.is_active
      };
    }
  } catch (error) {
    // Silently continue without authentication if token is invalid
    console.warn('Optional auth failed:', error.message);
  }

  next();
};

module.exports = {
  authenticateToken,
  authorize,
  requireDoctor,
  requirePatient,
  requireAdmin,
  requireOwnership,
  optionalAuth
};