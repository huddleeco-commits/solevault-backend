/**
 * Competitors API Routes
 *
 * CRUD operations for competitor tracking.
 * Used by admin dashboard to monitor nearby competitors.
 */

const express = require('express');
const router = express.Router();

// GET /api/admin/competitors - List all tracked competitors
router.get('/', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json([]);
    }

    const result = await pool.query(`
      SELECT * FROM competitors
      ORDER BY threat_level DESC, distance ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching competitors:', error);
    res.json([]);
  }
});

// GET /api/admin/competitors/:id - Get single competitor
router.get('/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(404).json({ error: 'Competitor not found' });
    }

    const result = await pool.query(
      'SELECT * FROM competitors WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Competitor not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching competitor:', error);
    res.status(500).json({ error: 'Failed to fetch competitor' });
  }
});

// POST /api/admin/competitors - Add new competitor
router.post('/', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const {
      name,
      address,
      distance,
      threat_level = 'medium',
      rating,
      review_count,
      price_level,
      avg_price,
      website,
      notes
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const result = await pool.query(`
      INSERT INTO competitors (
        name, address, distance, threat_level, rating, review_count,
        price_level, avg_price, website, notes, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING *
    `, [name, address, distance, threat_level, rating, review_count, price_level, avg_price, website, notes]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating competitor:', error);
    res.status(500).json({ error: 'Failed to create competitor' });
  }
});

// PUT /api/admin/competitors/:id - Update competitor
router.put('/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const {
      name,
      address,
      distance,
      threat_level,
      rating,
      review_count,
      price_level,
      avg_price,
      website,
      notes
    } = req.body;

    const result = await pool.query(`
      UPDATE competitors SET
        name = COALESCE($1, name),
        address = COALESCE($2, address),
        distance = COALESCE($3, distance),
        threat_level = COALESCE($4, threat_level),
        rating = COALESCE($5, rating),
        review_count = COALESCE($6, review_count),
        price_level = COALESCE($7, price_level),
        avg_price = COALESCE($8, avg_price),
        website = COALESCE($9, website),
        notes = COALESCE($10, notes),
        updated_at = NOW()
      WHERE id = $11
      RETURNING *
    `, [name, address, distance, threat_level, rating, review_count, price_level, avg_price, website, notes, req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Competitor not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating competitor:', error);
    res.status(500).json({ error: 'Failed to update competitor' });
  }
});

// DELETE /api/admin/competitors/:id - Remove competitor
router.delete('/:id', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const result = await pool.query(
      'DELETE FROM competitors WHERE id = $1 RETURNING id',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Competitor not found' });
    }

    res.json({ success: true, deleted: req.params.id });
  } catch (error) {
    console.error('Error deleting competitor:', error);
    res.status(500).json({ error: 'Failed to delete competitor' });
  }
});

// POST /api/admin/competitors/:id/analyze - Trigger AI analysis
router.post('/:id/analyze', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }

    // Update last_analyzed timestamp
    await pool.query(
      'UPDATE competitors SET last_analyzed = NOW() WHERE id = $1',
      [req.params.id]
    );

    // In production, this would trigger actual AI analysis
    res.json({
      success: true,
      message: 'Analysis queued',
      competitor_id: req.params.id
    });
  } catch (error) {
    console.error('Error triggering analysis:', error);
    res.status(500).json({ error: 'Failed to trigger analysis' });
  }
});

module.exports = router;
