/**
 * Marketplace Routes - PostgreSQL Compatible
 * SoleVault Marketplace API
 */
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticateToken } = require('../middleware/auth');
const Card = require('../models/Card');
const Listing = require('../models/Listing');

// Rate limiting middleware (simplified)
const rateLimit = (maxRequests, windowMs) => {
  const requests = new Map();
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const windowStart = now - windowMs;

    if (!requests.has(key)) {
      requests.set(key, []);
    }

    const userRequests = requests.get(key).filter(t => t > windowStart);

    if (userRequests.length >= maxRequests) {
      return res.status(429).json({ success: false, error: 'Too many requests' });
    }

    userRequests.push(now);
    requests.set(key, userRequests);
    next();
  };
};

// Get marketplace listings
router.get('/listings', rateLimit(100, 15 * 60 * 1000), async (req, res) => {
  try {
    const { page = 1, limit = 20, category, minPrice, maxPrice, sort = 'newest' } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Build query
    let query = `
      SELECT l.*, c.name as item_name, c.brand, c.model, c.front_image_url,
             u.full_name as seller_name
      FROM listings l
      LEFT JOIN cards c ON l.card_id = c.id
      LEFT JOIN users u ON l.seller_id = u.id
      WHERE l.status = 'active'
    `;
    const params = [];
    let paramIndex = 1;

    if (category) {
      query += ` AND c.brand = $${paramIndex++}`;
      params.push(category);
    }
    if (minPrice) {
      query += ` AND l.price >= $${paramIndex++}`;
      params.push(parseFloat(minPrice));
    }
    if (maxPrice) {
      query += ` AND l.price <= $${paramIndex++}`;
      params.push(parseFloat(maxPrice));
    }

    // Sort
    switch (sort) {
      case 'price_low':
        query += ' ORDER BY l.price ASC';
        break;
      case 'price_high':
        query += ' ORDER BY l.price DESC';
        break;
      case 'oldest':
        query += ' ORDER BY l.created_at ASC';
        break;
      default:
        query += ' ORDER BY l.created_at DESC';
    }

    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    params.push(parseInt(limit), offset);

    const result = await db.query(query, params).catch(() => ({ rows: [] }));

    res.json({
      success: true,
      listings: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    console.error('Get listings error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch listings' });
  }
});

// Get single listing
router.get('/listings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const listing = await Listing.findById(id);

    if (!listing) {
      return res.status(404).json({ success: false, error: 'Listing not found' });
    }

    res.json({ success: true, listing });
  } catch (error) {
    console.error('Get listing error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch listing' });
  }
});

// Create new listing
router.post('/listings', authenticateToken, rateLimit(10, 15 * 60 * 1000), async (req, res) => {
  try {
    const { card_id, price, description } = req.body;
    const seller_id = req.user.userId;

    if (!card_id || !price) {
      return res.status(400).json({ success: false, error: 'Card ID and price required' });
    }

    // Verify card belongs to user
    const card = await Card.findById(card_id);
    if (!card || card.user_id !== seller_id) {
      return res.status(403).json({ success: false, error: 'Card not found or not owned' });
    }

    const listing = await Listing.create({
      card_id,
      seller_id,
      price: parseFloat(price),
      description
    });

    res.json({ success: true, listing });
  } catch (error) {
    console.error('Create listing error:', error);
    res.status(500).json({ success: false, error: 'Failed to create listing' });
  }
});

// Update listing
router.put('/listings/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { price, description, status } = req.body;

    const listing = await Listing.findById(id);
    if (!listing || listing.seller_id !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    const updates = {};
    if (price) updates.price = parseFloat(price);
    if (description) updates.description = description;
    if (status) updates.status = status;

    const result = await db.query(
      'UPDATE listings SET price = COALESCE($1, price), description = COALESCE($2, description), status = COALESCE($3, status), updated_at = NOW() WHERE id = $4 RETURNING *',
      [updates.price, updates.description, updates.status, id]
    );

    res.json({ success: true, listing: result.rows[0] });
  } catch (error) {
    console.error('Update listing error:', error);
    res.status(500).json({ success: false, error: 'Failed to update listing' });
  }
});

// Delete listing
router.delete('/listings/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const listing = await Listing.findById(id);
    if (!listing || listing.seller_id !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    await Listing.delete(id);
    res.json({ success: true, message: 'Listing deleted' });
  } catch (error) {
    console.error('Delete listing error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete listing' });
  }
});

// Get user's collection
router.get('/collection', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { page = 1, limit = 20 } = req.query;

    const cards = await Card.findByUserId(userId, {
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit)
    });

    res.json({
      success: true,
      items: cards,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    console.error('Get collection error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch collection' });
  }
});

// Add item to collection
router.post('/collection', authenticateToken, async (req, res) => {
  try {
    const { name, brand, model, size, condition, price, description, front_image_url, back_image_url } = req.body;
    const user_id = req.user.userId;

    const card = await Card.create({
      user_id,
      name,
      brand,
      model,
      size,
      condition,
      price: parseFloat(price) || 0,
      description,
      front_image_url,
      back_image_url
    });

    res.json({ success: true, item: card });
  } catch (error) {
    console.error('Add to collection error:', error);
    res.status(500).json({ success: false, error: 'Failed to add item' });
  }
});

// Get marketplace stats
router.get('/stats', async (req, res) => {
  try {
    const activeListings = await db.query("SELECT COUNT(*) FROM listings WHERE status = 'active'").catch(() => ({ rows: [{ count: 0 }] }));
    const totalItems = await db.query('SELECT COUNT(*) FROM cards').catch(() => ({ rows: [{ count: 0 }] }));

    res.json({
      success: true,
      stats: {
        activeListings: parseInt(activeListings.rows[0].count),
        totalItems: parseInt(totalItems.rows[0].count),
        recentSales: 0
      }
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.json({ success: true, stats: { activeListings: 0, totalItems: 0, recentSales: 0 } });
  }
});

module.exports = router;
