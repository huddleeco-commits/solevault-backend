/**
 * Admin API Module
 *
 * Comprehensive admin endpoints for:
 * - Competitors tracking
 * - Customer CRM
 * - Order management
 * - Analytics/metrics
 * - Inventory management
 * - Staging/Content editing
 *
 * All routes are prefixed with /api/admin
 * All routes require authentication (except health check)
 * CORS restricted to allowed origins
 */

const express = require('express');
const router = express.Router();
const cors = require('cors');

// CORS configuration for admin API
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (same-origin, mobile apps, curl)
    if (!origin) return callback(null, true);

    const allowedOrigins = process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
      : [process.env.FRONTEND_URL, process.env.ADMIN_URL].filter(Boolean);

    // In development, allow localhost
    if (process.env.NODE_ENV !== 'production') {
      allowedOrigins.push('http://localhost:3000', 'http://localhost:5173', 'http://localhost:4173');
    }

    if (allowedOrigins.includes(origin) || allowedOrigins.length === 0) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  maxAge: 86400 // 24 hours
};

// Apply CORS to all admin routes
router.use(cors(corsOptions));

// Import auth middleware
const { authenticateToken, isAdmin } = require('../auth/middleware/auth');

// Import route modules
const competitorsRoutes = require('./routes/competitors');
const customersRoutes = require('./routes/customers');
const ordersRoutes = require('./routes/orders');
const analyticsRoutes = require('./routes/analytics');
const inventoryRoutes = require('./routes/inventory');
const stagingRoutes = require('./routes/staging');

// Health check for admin API (no auth required)
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    module: 'admin-api',
    timestamp: new Date().toISOString()
  });
});

// Apply authentication middleware to all admin routes
router.use(authenticateToken);
router.use(isAdmin);

// Mount routes (all protected by auth middleware above)
router.use('/competitors', competitorsRoutes);
router.use('/customers', customersRoutes);
router.use('/orders', ordersRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/staging', stagingRoutes);

module.exports = router;
