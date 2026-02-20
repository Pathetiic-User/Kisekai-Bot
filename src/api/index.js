const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const authMiddleware = require('./middleware/auth');

// Multer setup
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Create Express app
const app = express();

// Trust proxy
app.set('trust proxy', 1);

// Security middlewares
app.use(helmet());
app.use(express.json());
app.use(cookieParser());

// CORS
app.use(cors({
  origin: function(origin, callback) {
    const allowedOrigins = [
      'http://localhost:8080',
      'http://localhost:3000',
      'https://kisekai-dashboard.vercel.app',
      process.env.FRONTEND_URL,
      process.env.DASHBOARD_URL
    ].filter(Boolean);
    
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1000,
  message: { error: 'Muitas requisições, tente novamente mais tarde.' }
});

// Health check (before auth)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Apply auth middleware to all API routes
app.use('/api/', limiter, authMiddleware);

module.exports = { app, upload };