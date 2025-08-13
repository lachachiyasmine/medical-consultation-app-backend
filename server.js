// Load environment variables
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// ====================
// 🔐 Security Middleware
// ====================
app.use(helmet()); // Adds security headers

// Limit repeated requests to public APIs
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
});
app.use(limiter);

// ====================
// 🌍 CORS Configuration
// ====================
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : [];

app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (like mobile apps or curl)
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) === -1) {
        return callback(
          new Error('CORS policy: Access denied from this origin'),
          false
        );
      }
      return callback(null, true);
    },
    credentials: true,
  })
);

// Middleware to parse JSON requests
app.use(express.json());

// ====================
// 📂 Routes
// ====================
const authRouter = require('./routes/auth'); // Authentication routes
const doctorsRouter = require('./routes/doctors');
const appointmentsRouter = require('./routes/appointments');
const specialtiesRouter = require('./routes/specialties');
// You can add: notifications, reviews, payments when ready

app.use('/api/auth', authRouter);
app.use('/api/doctors', doctorsRouter);
app.use('/api/appointments', appointmentsRouter);
app.use('/api/specialties', specialtiesRouter);

// ====================
// 🩺 Health Check Route
// ====================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    environment: process.env.NODE_ENV || 'development',
    timestamp: Date.now(),
  });
});

// ====================
// 🚀 Start Server
// For local development only - Vercel requires module export
// ====================
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`✅ Server running locally on port ${PORT}`);
  });
}

module.exports = app; // This export is required for Vercel serverless deployment
