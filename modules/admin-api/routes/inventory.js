/**
 * Inventory API Routes
 *
 * Product/inventory management including stock levels, alerts, and categories.
 */

const express = require('express');
const router = express.Router();

// GET /api/admin/inventory - List all products/inventory
router.get('/', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json({ items: [], total: 0 });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const category = req.query.category;
    const search = req.query.search;
    const lowStock = req.query.lowStock === 'true';

    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (category) {
      whereClause += ` AND category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    if (search) {
      whereClause += ` AND (name ILIKE $${paramIndex} OR sku ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (lowStock) {
      whereClause += ` AND quantity <= low_stock_threshold`;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM products ${whereClause}`,
      params
    );

    params.push(limit, offset);
    const result = await pool.query(`
      SELECT * FROM products
      ${whereClause}
      ORDER BY
        CASE WHEN quantity <= low_stock_threshold THEN 0 ELSE 1 END,
        name ASC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `, params);

    res.json({
      items: result.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit
    });
  } catch (error) {
    console.error('Error fetching inventory:', error);
    res.json({ items: [], total: 0 });
  }
});

// GET /api/admin/inventory/stats - Inventory statistics
router.get('/stats', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json({
        totalItems: 0,
        totalValue: 0,
        lowStock: 0,
        outOfStock: 0
      });
    }

    const result = await pool.query(`
      SELECT
        COUNT(*) as total_items,
        COALESCE(SUM(quantity * price), 0) as total_value,
        COUNT(*) FILTER (WHERE quantity <= low_stock_threshold AND quantity > 0) as low_stock,
        COUNT(*) FILTER (WHERE quantity = 0) as out_of_stock
      FROM products
      WHERE active = true
    `);

    res.json({
      totalItems: parseInt(result.rows[0].total_items),
      totalValue: parseFloat(result.rows[0].total_value),
      lowStock: parseInt(result.rows[0].low_stock),
      outOfStock: parseInt(result.rows[0].out_of_stock)
    });
  } catch (error) {
    console.error('Error fetching inventory stats:', error);
    res.json({ totalItems: 0, totalValue: 0, lowStock: 0, outOfStock: 0 });
  }
});

// GET /api/admin/inventory/alerts - Low stock and out of stock alerts
router.get('/alerts', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json([]);
    }

    const result = await pool.query(`
      SELECT
        id,
        name,
        sku,
        quantity,
        low_stock_threshold,
        CASE
          WHEN quantity = 0 THEN 'out_of_stock'
          WHEN quantity <= low_stock_threshold THEN 'low_stock'
        END as alert_type,
        price,
        category
      FROM products
      WHERE quantity <= low_stock_threshold
        AND active = true
      ORDER BY
        CASE WHEN quantity = 0 THEN 0 ELSE 1 END,
        quantity ASC
      LIMIT 50
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching inventory alerts:', error);
    res.json([]);
  }
});

// GET /api/admin/inventory/categories - Get categories with counts
router.get('/categories', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json([]);
    }

    const result = await pool.query(`
      SELECT
        category,
        COUNT(*) as count,
        SUM(quantity) as total_stock,
        COALESCE(SUM(quantity * price), 0) as total_value
      FROM products
      WHERE active = true
      GROUP BY category
      ORDER BY count DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.json([]);
  }
});

// GET /api/admin/inventory/:id - Get single product
router.get('/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const result = await pool.query(
      'SELECT * FROM products WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching product:', error);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// POST /api/admin/inventory - Create product
router.post('/', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const {
      name,
      sku,
      description,
      price,
      cost,
      quantity = 0,
      low_stock_threshold = 10,
      category,
      image_url
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const result = await pool.query(`
      INSERT INTO products (
        name, sku, description, price, cost, quantity,
        low_stock_threshold, category, image_url, active, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, NOW())
      RETURNING *
    `, [name, sku, description, price, cost, quantity, low_stock_threshold, category, image_url]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating product:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'SKU already exists' });
    }
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// PUT /api/admin/inventory/:id - Update product
router.put('/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const {
      name,
      sku,
      description,
      price,
      cost,
      quantity,
      low_stock_threshold,
      category,
      image_url,
      active
    } = req.body;

    const result = await pool.query(`
      UPDATE products SET
        name = COALESCE($1, name),
        sku = COALESCE($2, sku),
        description = COALESCE($3, description),
        price = COALESCE($4, price),
        cost = COALESCE($5, cost),
        quantity = COALESCE($6, quantity),
        low_stock_threshold = COALESCE($7, low_stock_threshold),
        category = COALESCE($8, category),
        image_url = COALESCE($9, image_url),
        active = COALESCE($10, active),
        updated_at = NOW()
      WHERE id = $11
      RETURNING *
    `, [name, sku, description, price, cost, quantity, low_stock_threshold, category, image_url, active, req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// PUT /api/admin/inventory/:id/stock - Adjust stock level
router.put('/:id/stock', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const { adjustment, reason } = req.body;

    if (typeof adjustment !== 'number') {
      return res.status(400).json({ error: 'Adjustment must be a number' });
    }

    // Update stock
    const result = await pool.query(`
      UPDATE products SET
        quantity = quantity + $1,
        updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [adjustment, req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Log the movement
    await pool.query(`
      INSERT INTO inventory_movements (product_id, adjustment, reason, created_at)
      VALUES ($1, $2, $3, NOW())
    `, [req.params.id, adjustment, reason]);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error adjusting stock:', error);
    res.status(500).json({ error: 'Failed to adjust stock' });
  }
});

// DELETE /api/admin/inventory/:id - Delete product (soft delete)
router.delete('/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const result = await pool.query(`
      UPDATE products SET active = false, updated_at = NOW()
      WHERE id = $1
      RETURNING id
    `, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({ success: true, deleted: req.params.id });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// GET /api/admin/inventory/:id/movements - Get stock movement history
router.get('/:id/movements', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json([]);
    }

    const result = await pool.query(`
      SELECT * FROM inventory_movements
      WHERE product_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [req.params.id]);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching movements:', error);
    res.json([]);
  }
});

module.exports = router;
