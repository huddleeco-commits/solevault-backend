/**
 * Orders API Routes
 *
 * Order management including fulfillment, returns, and status updates.
 */

const express = require('express');
const router = express.Router();

// GET /api/admin/orders - List all orders with pagination
router.get('/', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json({ orders: [], total: 0 });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const status = req.query.status;
    const search = req.query.search;

    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (status) {
      whereClause += ` AND o.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (search) {
      whereClause += ` AND (o.order_number ILIKE $${paramIndex} OR c.email ILIKE $${paramIndex} OR c.full_name ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM orders o LEFT JOIN customers c ON o.customer_id = c.id ${whereClause}`,
      params
    );

    params.push(limit, offset);
    const result = await pool.query(`
      SELECT
        o.*,
        c.full_name as customer_name,
        c.email as customer_email
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      ${whereClause}
      ORDER BY o.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `, params);

    res.json({
      orders: result.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.json({ orders: [], total: 0 });
  }
});

// GET /api/admin/orders/stats - Get order statistics
router.get('/stats', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json({
        total: 0,
        pending: 0,
        processing: 0,
        shipped: 0,
        delivered: 0,
        cancelled: 0,
        revenue: 0
      });
    }

    const result = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'processing') as processing,
        COUNT(*) FILTER (WHERE status = 'shipped') as shipped,
        COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
        COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
        COALESCE(SUM(total) FILTER (WHERE status != 'cancelled'), 0) as revenue
      FROM orders
    `);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching order stats:', error);
    res.json({ total: 0, pending: 0, processing: 0, shipped: 0, delivered: 0, cancelled: 0, revenue: 0 });
  }
});

// GET /api/admin/orders/returns - Get returns/refunds
router.get('/returns', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json([]);
    }

    const result = await pool.query(`
      SELECT
        r.*,
        o.order_number,
        c.full_name as customer_name,
        c.email as customer_email
      FROM order_returns r
      JOIN orders o ON r.order_id = o.id
      LEFT JOIN customers c ON o.customer_id = c.id
      ORDER BY r.created_at DESC
      LIMIT 50
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching returns:', error);
    res.json([]);
  }
});

// GET /api/admin/orders/fulfillment - Get orders needing fulfillment
router.get('/fulfillment', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json([]);
    }

    const result = await pool.query(`
      SELECT
        o.*,
        c.full_name as customer_name,
        c.email as customer_email
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      WHERE o.status IN ('pending', 'processing')
      ORDER BY o.created_at ASC
      LIMIT 50
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching fulfillment queue:', error);
    res.json([]);
  }
});

// GET /api/admin/orders/:id - Get single order
router.get('/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const result = await pool.query(`
      SELECT
        o.*,
        c.full_name as customer_name,
        c.email as customer_email,
        c.phone as customer_phone
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      WHERE o.id = $1
    `, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// PUT /api/admin/orders/:id/status - Update order status
router.put('/:id/status', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const { status, tracking_number, notes } = req.body;

    const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const result = await pool.query(`
      UPDATE orders SET
        status = $1,
        tracking_number = COALESCE($2, tracking_number),
        notes = COALESCE($3, notes),
        updated_at = NOW(),
        shipped_at = CASE WHEN $1 = 'shipped' THEN NOW() ELSE shipped_at END,
        delivered_at = CASE WHEN $1 = 'delivered' THEN NOW() ELSE delivered_at END
      WHERE id = $4
      RETURNING *
    `, [status, tracking_number, notes, req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

// POST /api/admin/orders/:id/return - Create return request
router.post('/:id/return', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const { reason, items, refund_amount, notes } = req.body;

    const result = await pool.query(`
      INSERT INTO order_returns (order_id, reason, items, refund_amount, notes, status, created_at)
      VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
      RETURNING *
    `, [req.params.id, reason, JSON.stringify(items), refund_amount, notes]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating return:', error);
    res.status(500).json({ error: 'Failed to create return' });
  }
});

// PUT /api/admin/orders/returns/:id - Update return status
router.put('/returns/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const { status, refund_amount, notes } = req.body;

    const result = await pool.query(`
      UPDATE order_returns SET
        status = COALESCE($1, status),
        refund_amount = COALESCE($2, refund_amount),
        notes = COALESCE($3, notes),
        processed_at = CASE WHEN $1 IN ('approved', 'rejected') THEN NOW() ELSE processed_at END
      WHERE id = $4
      RETURNING *
    `, [status, refund_amount, notes, req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Return not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating return:', error);
    res.status(500).json({ error: 'Failed to update return' });
  }
});

module.exports = router;
