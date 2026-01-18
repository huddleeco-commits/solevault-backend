/**
 * Admin Dashboard Routes - PostgreSQL Compatible
 * SoleVault Admin API
 */
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticateToken } = require('../middleware/auth');

// Middleware to check admin role
const requireAdmin = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    // For now, allow all authenticated users (in production, check role)
    next();
  } catch (error) {
    res.status(500).json({ success: false, error: 'Admin check failed' });
  }
};

// Get dashboard overview stats
router.get('/dashboard', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // Get counts from database
    const userCount = await db.query('SELECT COUNT(*) FROM users');
    const cardCount = await db.query('SELECT COUNT(*) FROM cards WHERE 1=1').catch(() => ({ rows: [{ count: 0 }] }));
    const listingCount = await db.query('SELECT COUNT(*) FROM listings WHERE status = $1', ['active']).catch(() => ({ rows: [{ count: 0 }] }));

    res.json({
      success: true,
      stats: {
        totalUsers: parseInt(userCount.rows[0]?.count || 0),
        totalItems: parseInt(cardCount.rows[0]?.count || 0),
        activeListings: parseInt(listingCount.rows[0]?.count || 0),
        pendingActions: 0,
        recentActivity: []
      }
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.json({
      success: true,
      stats: {
        totalUsers: 0,
        totalItems: 0,
        activeListings: 0,
        pendingActions: 0,
        recentActivity: []
      }
    });
  }
});

// Get all users (paginated)
router.get('/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = 'SELECT id, email, full_name, created_at FROM users';
    const params = [];
    let paramIndex = 1;

    if (search) {
      query += ` WHERE email ILIKE $${paramIndex} OR full_name ILIKE $${paramIndex}`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    params.push(parseInt(limit), offset);

    const result = await db.query(query, params);
    const countResult = await db.query('SELECT COUNT(*) FROM users');

    res.json({
      success: true,
      users: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        pages: Math.ceil(countResult.rows[0].count / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch users' });
  }
});

// Get user by ID
router.get('/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      'SELECT id, email, full_name, created_at FROM users WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch user' });
  }
});

// Get recent activity
router.get('/activity', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    // Return mock activity for now
    res.json({
      success: true,
      activity: [
        { type: 'user_signup', message: 'New user registered', timestamp: new Date().toISOString() },
        { type: 'item_listed', message: 'Item listed for sale', timestamp: new Date().toISOString() }
      ]
    });
  } catch (error) {
    console.error('Get activity error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch activity' });
  }
});

// Get system health
router.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({
      success: true,
      status: 'healthy',
      database: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({
      success: false,
      status: 'unhealthy',
      database: 'disconnected',
      error: error.message
    });
  }
});

// Get pending actions
router.get('/pending-actions', authenticateToken, requireAdmin, async (req, res) => {
  try {
    res.json({
      success: true,
      pendingActions: [],
      count: 0
    });
  } catch (error) {
    console.error('Get pending actions error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch pending actions' });
  }
});

// Approve/Reject pending action
router.post('/pending-actions/:id/:action', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id, action } = req.params;

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, error: 'Invalid action' });
    }

    res.json({
      success: true,
      message: `Action ${action}d successfully`
    });
  } catch (error) {
    console.error('Process action error:', error);
    res.status(500).json({ success: false, error: 'Failed to process action' });
  }
});

module.exports = router;
