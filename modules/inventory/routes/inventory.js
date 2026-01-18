/**
 * Inventory Routes - PostgreSQL Compatible
 * SoleVault Inventory Management API
 */
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticateToken } = require('../middleware/auth');

// Get user's inventory
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { page = 1, limit = 50, sort = 'created_at', order = 'DESC' } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const validSorts = ['created_at', 'name', 'brand', 'price'];
    const sortColumn = validSorts.includes(sort) ? sort : 'created_at';
    const sortOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const result = await db.query(
      `SELECT * FROM cards WHERE user_id = $1 ORDER BY ${sortColumn} ${sortOrder} LIMIT $2 OFFSET $3`,
      [userId, parseInt(limit), offset]
    ).catch(() => ({ rows: [] }));

    const countResult = await db.query(
      'SELECT COUNT(*) FROM cards WHERE user_id = $1',
      [userId]
    ).catch(() => ({ rows: [{ count: 0 }] }));

    res.json({
      success: true,
      items: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        pages: Math.ceil(countResult.rows[0].count / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get inventory error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch inventory' });
  }
});

// Get single item
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const result = await db.query(
      'SELECT * FROM cards WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Item not found' });
    }

    res.json({ success: true, item: result.rows[0] });
  } catch (error) {
    console.error('Get item error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch item' });
  }
});

// Add new item to inventory
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const {
      name, brand, model, size, condition,
      price, description, front_image_url, back_image_url,
      sku, colorway, release_date
    } = req.body;

    if (!name || !brand) {
      return res.status(400).json({ success: false, error: 'Name and brand required' });
    }

    const result = await db.query(
      `INSERT INTO cards (user_id, name, brand, model, size, condition, price, description, front_image_url, back_image_url, sku, colorway, release_date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
       RETURNING *`,
      [userId, name, brand, model, size, condition, parseFloat(price) || 0, description, front_image_url, back_image_url, sku, colorway, release_date]
    );

    res.json({ success: true, item: result.rows[0] });
  } catch (error) {
    console.error('Add item error:', error);
    res.status(500).json({ success: false, error: 'Failed to add item' });
  }
});

// Update item
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;
    const updates = req.body;

    // Verify ownership
    const existing = await db.query(
      'SELECT id FROM cards WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Item not found or not owned' });
    }

    // Build update query
    const allowedFields = ['name', 'brand', 'model', 'size', 'condition', 'price', 'description', 'front_image_url', 'back_image_url', 'sku', 'colorway', 'for_sale'];
    const fields = [];
    const values = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        fields.push(`${key} = $${paramIndex++}`);
        values.push(key === 'price' ? parseFloat(value) : value);
      }
    }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }

    values.push(id);
    const result = await db.query(
      `UPDATE cards SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    res.json({ success: true, item: result.rows[0] });
  } catch (error) {
    console.error('Update item error:', error);
    res.status(500).json({ success: false, error: 'Failed to update item' });
  }
});

// Delete item
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const result = await db.query(
      'DELETE FROM cards WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Item not found or not owned' });
    }

    res.json({ success: true, message: 'Item deleted' });
  } catch (error) {
    console.error('Delete item error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete item' });
  }
});

// Get inventory stats
router.get('/stats/summary', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const totalItems = await db.query(
      'SELECT COUNT(*) FROM cards WHERE user_id = $1',
      [userId]
    ).catch(() => ({ rows: [{ count: 0 }] }));

    const totalValue = await db.query(
      'SELECT COALESCE(SUM(price), 0) as total FROM cards WHERE user_id = $1',
      [userId]
    ).catch(() => ({ rows: [{ total: 0 }] }));

    const forSale = await db.query(
      'SELECT COUNT(*) FROM cards WHERE user_id = $1 AND for_sale = true',
      [userId]
    ).catch(() => ({ rows: [{ count: 0 }] }));

    res.json({
      success: true,
      stats: {
        totalItems: parseInt(totalItems.rows[0].count),
        totalValue: parseFloat(totalValue.rows[0].total),
        forSale: parseInt(forSale.rows[0].count)
      }
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.json({ success: true, stats: { totalItems: 0, totalValue: 0, forSale: 0 } });
  }
});

// Bulk operations
router.post('/bulk/delete', authenticateToken, async (req, res) => {
  try {
    const { ids } = req.body;
    const userId = req.user.userId;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: 'Item IDs required' });
    }

    const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ');
    const result = await db.query(
      `DELETE FROM cards WHERE user_id = $1 AND id IN (${placeholders}) RETURNING id`,
      [userId, ...ids]
    );

    res.json({
      success: true,
      deleted: result.rows.length,
      message: `${result.rows.length} items deleted`
    });
  } catch (error) {
    console.error('Bulk delete error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete items' });
  }
});

module.exports = router;
