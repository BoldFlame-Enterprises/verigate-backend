import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import slowDown from 'express-slow-down';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

import { connectDB } from './config/database';
import { connectRedis } from './config/redis';
import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import eventRoutes from './routes/events';
import accessRoutes from './routes/access';
import areaRoutes from './routes/areas';
import qrRoutes from './routes/qr';
import scanRoutes from './routes/scan';
import adminRoutes from './routes/admin';
import syncRoutes from './routes/sync';
import analyticsRoutes from './routes/analytics';
import notificationRoutes from './routes/notifications';
import incidentRoutes from './routes/incidents';
import { errorHandler } from './middleware/errorHandler';
import { authenticateToken } from './middleware/auth';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Trust proxy for rate limiting
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

// Compression middleware
app.use(compression());

// CORS configuration
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests from localhost during development
    if (!origin || origin.includes('localhost') || origin.includes('127.0.0.1')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  message: {
    error: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Speed limiting for additional protection
const speedLimiter = slowDown({
  windowMs: 15 * 60 * 1000, // 15 minutes
  delayAfter: 50, // allow 50 requests per windowMs without delay
  delayMs: 500, // add 500ms delay per request after delayAfter
});

app.use(limiter);
app.use(speedLimiter);

// Logging
app.use(morgan('combined'));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', authenticateToken, userRoutes);
app.use('/api/events', authenticateToken, eventRoutes);
app.use('/api/access', authenticateToken, accessRoutes);
app.use('/api/areas', authenticateToken, areaRoutes);
app.use('/api/qr', authenticateToken, qrRoutes);
app.use('/api/scan', authenticateToken, scanRoutes);
app.use('/api/admin', authenticateToken, adminRoutes);
app.use('/api/sync', authenticateToken, syncRoutes);
app.use('/api/analytics', authenticateToken, analyticsRoutes);
app.use('/api/notifications', authenticateToken, notificationRoutes);
app.use('/api/incidents', authenticateToken, incidentRoutes);

// The web dashboard (verigate-dashboard) is a separate Vite app run on its
// own port during development and deployed independently in production; this
// API server does not serve it statically. Any unmatched route is a 404.
app.use((req, res) => {
  res.status(404).json({ error: `Not found - ${req.originalUrl}` });
});

// Error handling middleware
app.use(errorHandler);

// Initialize database and start server
async function startServer(): Promise<void> {
  try {
    await connectDB();
    await connectRedis();
    
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 Admin dashboard: http://localhost:${PORT}`);
      console.log(`🔗 API base URL: http://localhost:${PORT}/api`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  process.exit(0);
});

startServer();
