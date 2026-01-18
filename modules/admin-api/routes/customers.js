/**
 * Customers API Routes
 *
 * CRM operations for customer management.
 * Includes segments, activity tracking, and communications.
 */

const express = require('express');
const router = express.Router();

// GET /api/admin/customers - List all customers with pagination
router.get('/', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json({ customers: [], total: 0 });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const segment = req.query.segment;
    const search = req.query.search;

    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (segment) {
      whereClause += ` AND segment = $${paramIndex}`;
      params.push(segment);
      paramIndex++;
    }

    if (search) {
      whereClause += ` AND (full_name ILIKE $${paramIndex} OR email ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM customers ${whereClause}`,
      params
    );

    params.push(limit, offset);
    const result = await pool.query(`
      SELECT * FROM customers
      ${whereClause}
      ORDER BY total_spent DESC, created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `, params);

    res.json({
      customers: result.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit
    });
  } catch (error) {
    console.error('Error fetching customers:', error);
    res.json({ customers: [], total: 0 });
  }
});

// GET /api/admin/customers/segments - Get customer segments summary
router.get('/segments', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json({
        segments: [
          { id: 'vip', name: 'VIP', count: 0, criteria: 'Top 10% by spend' },
          { id: 'loyal', name: 'Loyal', count: 0, criteria: '5+ orders' },
          { id: 'at_risk', name: 'At Risk', count: 0, criteria: 'No order in 30+ days' },
          { id: 'new', name: 'New', count: 0, criteria: 'First order in last 30 days' }
        ]
      });
    }

    const result = await pool.query(`
      SELECT
        segment,
        COUNT(*) as count,
        AVG(total_spent) as avg_spent,
        AVG(order_count) as avg_orders
      FROM customers
      GROUP BY segment
    `);

    const segments = [
      { id: 'vip', name: 'VIP', criteria: 'Top 10% by spend' },
      { id: 'loyal', name: 'Loyal', criteria: '5+ orders' },
      { id: 'at_risk', name: 'At Risk', criteria: 'No order in 30+ days' },
      { id: 'new', name: 'New', criteria: 'First order in last 30 days' }
    ].map(seg => {
      const data = result.rows.find(r => r.segment === seg.id);
      return {
        ...seg,
        count: data ? parseInt(data.count) : 0,
        avgSpent: data ? parseFloat(data.avg_spent) : 0,
        avgOrders: data ? parseFloat(data.avg_orders) : 0
      };
    });

    res.json({ segments });
  } catch (error) {
    console.error('Error fetching segments:', error);
    res.json({ segments: [] });
  }
});

// GET /api/admin/customers/at-risk - Get at-risk customers
router.get('/at-risk', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json([]);
    }

    const result = await pool.query(`
      SELECT * FROM customers
      WHERE last_order_at < NOW() - INTERVAL '30 days'
        AND order_count > 1
      ORDER BY total_spent DESC
      LIMIT 20
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching at-risk customers:', error);
    res.json([]);
  }
});

// GET /api/admin/customers/top - Get top customers
router.get('/top', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json([]);
    }

    const limit = parseInt(req.query.limit) || 10;

    const result = await pool.query(`
      SELECT * FROM customers
      ORDER BY total_spent DESC
      LIMIT $1
    `, [limit]);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching top customers:', error);
    res.json([]);
  }
});

// GET /api/admin/customers/:id - Get single customer
router.get('/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const result = await pool.query(
      'SELECT * FROM customers WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching customer:', error);
    res.status(500).json({ error: 'Failed to fetch customer' });
  }
});

// GET /api/admin/customers/:id/orders - Get customer's orders
router.get('/:id/orders', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json([]);
    }

    const result = await pool.query(`
      SELECT * FROM orders
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [req.params.id]);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching customer orders:', error);
    res.json([]);
  }
});

// GET /api/admin/customers/:id/communications - Get customer communications
router.get('/:id/communications', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json([]);
    }

    const result = await pool.query(`
      SELECT * FROM customer_communications
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [req.params.id]);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching communications:', error);
    res.json([]);
  }
});

// POST /api/admin/customers - Create customer
router.post('/', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const { full_name, email, phone, segment = 'new', notes } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const result = await pool.query(`
      INSERT INTO customers (full_name, email, phone, segment, notes, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING *
    `, [full_name, email, phone, segment, notes]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating customer:', error);
    res.status(500).json({ error: 'Failed to create customer' });
  }
});

// PUT /api/admin/customers/:id - Update customer
router.put('/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const { full_name, email, phone, segment, notes } = req.body;

    const result = await pool.query(`
      UPDATE customers SET
        full_name = COALESCE($1, full_name),
        email = COALESCE($2, email),
        phone = COALESCE($3, phone),
        segment = COALESCE($4, segment),
        notes = COALESCE($5, notes),
        updated_at = NOW()
      WHERE id = $6
      RETURNING *
    `, [full_name, email, phone, segment, notes, req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating customer:', error);
    res.status(500).json({ error: 'Failed to update customer' });
  }
});

// POST /api/admin/customers/:id/communicate - Send communication
router.post('/:id/communicate', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const { type, subject, content } = req.body;

    const result = await pool.query(`
      INSERT INTO customer_communications (customer_id, type, subject, content, sent_at)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING *
    `, [req.params.id, type, subject, content]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error sending communication:', error);
    res.status(500).json({ error: 'Failed to send communication' });
  }
});

module.exports = router;
