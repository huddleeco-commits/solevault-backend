/**
 * Staging/Content Editor API Routes
 *
 * Handles draft content, publishing, and content history
 * for the site preview/staging editor feature.
 */

const express = require('express');
const router = express.Router();

// GET /api/admin/staging/content - Get all staged content
router.get('/content', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json({ drafts: [], production: [] });
    }

    const draftsResult = await pool.query(`
      SELECT id, selector, element_type, content, styles, status, created_at, updated_at
      FROM staging_content
      ORDER BY updated_at DESC
    `);

    const productionResult = await pool.query(`
      SELECT id, selector, element_type, content, styles, published_at
      FROM production_content
      ORDER BY published_at DESC
    `);

    res.json({
      drafts: draftsResult.rows,
      production: productionResult.rows
    });
  } catch (error) {
    console.error('Error fetching staged content:', error);
    res.status(500).json({ error: 'Failed to fetch content' });
  }
});

// POST /api/admin/staging/save - Save draft content
router.post('/save', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const { edits } = req.body;

    if (!edits || !Array.isArray(edits)) {
      return res.status(400).json({ error: 'Invalid edits format' });
    }

    const savedEdits = [];

    for (const edit of edits) {
      const { selector, element_type, content, styles } = edit;

      if (!selector || !element_type) {
        continue;
      }

      // Upsert staging content
      const result = await pool.query(`
        INSERT INTO staging_content (selector, element_type, content, styles, status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'draft', NOW(), NOW())
        ON CONFLICT (selector)
        DO UPDATE SET
          content = EXCLUDED.content,
          styles = EXCLUDED.styles,
          status = 'draft',
          updated_at = NOW()
        RETURNING *
      `, [selector, element_type, content || '', JSON.stringify(styles || {})]);

      savedEdits.push(result.rows[0]);
    }

    res.json({
      success: true,
      savedCount: savedEdits.length,
      edits: savedEdits
    });
  } catch (error) {
    console.error('Error saving draft content:', error);
    res.status(500).json({ error: 'Failed to save draft' });
  }
});

// POST /api/admin/staging/publish - Publish drafts to production
router.post('/publish', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const { selectors } = req.body;
    const userId = req.user?.id || null;

    // If specific selectors provided, publish only those
    // Otherwise publish all drafts
    let whereClause = "status = 'draft'";
    let params = [];

    if (selectors && Array.isArray(selectors) && selectors.length > 0) {
      whereClause = "selector = ANY($1) AND status = 'draft'";
      params = [selectors];
    }

    // Get drafts to publish
    const draftsResult = await pool.query(`
      SELECT selector, element_type, content, styles
      FROM staging_content
      WHERE ${whereClause}
    `, params);

    if (draftsResult.rows.length === 0) {
      return res.json({ success: true, publishedCount: 0, message: 'No drafts to publish' });
    }

    const published = [];

    // Move each draft to production
    for (const draft of draftsResult.rows) {
      // Add to content history
      await pool.query(`
        INSERT INTO content_history (selector, element_type, content, styles, action, published_by, created_at)
        VALUES ($1, $2, $3, $4, 'publish', $5, NOW())
      `, [draft.selector, draft.element_type, draft.content, JSON.stringify(draft.styles), userId]);

      // Upsert to production_content
      await pool.query(`
        INSERT INTO production_content (selector, element_type, content, styles, published_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (selector)
        DO UPDATE SET
          content = EXCLUDED.content,
          styles = EXCLUDED.styles,
          published_at = NOW()
      `, [draft.selector, draft.element_type, draft.content, JSON.stringify(draft.styles)]);

      // Update staging_content status
      await pool.query(`
        UPDATE staging_content SET status = 'published', updated_at = NOW()
        WHERE selector = $1
      `, [draft.selector]);

      published.push(draft.selector);
    }

    res.json({
      success: true,
      publishedCount: published.length,
      published
    });
  } catch (error) {
    console.error('Error publishing content:', error);
    res.status(500).json({ error: 'Failed to publish content' });
  }
});

// GET /api/admin/staging/preview - Get production content for injection
router.get('/preview', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json({ overrides: [], theme: null });
    }

    const mode = req.query.mode || 'production';

    let contentResult;
    if (mode === 'draft') {
      // Include draft content for preview
      contentResult = await pool.query(`
        SELECT selector, element_type, content, styles
        FROM staging_content
        WHERE status = 'draft'
        UNION
        SELECT selector, element_type, content, styles
        FROM production_content
        WHERE selector NOT IN (SELECT selector FROM staging_content WHERE status = 'draft')
      `);
    } else {
      // Production only
      contentResult = await pool.query(`
        SELECT selector, element_type, content, styles
        FROM production_content
      `);
    }

    // Get theme settings
    const themeResult = await pool.query(`
      SELECT theme_name, primary_color, secondary_color, accent_color, font_family
      FROM site_theme
      WHERE is_draft = $1
      ORDER BY updated_at DESC
      LIMIT 1
    `, [mode === 'draft']);

    res.json({
      overrides: contentResult.rows,
      theme: themeResult.rows[0] || null
    });
  } catch (error) {
    console.error('Error fetching preview content:', error);
    res.json({ overrides: [], theme: null });
  }
});

// DELETE /api/admin/staging/discard - Discard draft changes
router.delete('/discard', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const { selectors } = req.body;

    let whereClause = "status = 'draft'";
    let params = [];

    if (selectors && Array.isArray(selectors) && selectors.length > 0) {
      whereClause = "selector = ANY($1) AND status = 'draft'";
      params = [selectors];
    }

    const result = await pool.query(`
      DELETE FROM staging_content
      WHERE ${whereClause}
      RETURNING selector
    `, params);

    res.json({
      success: true,
      discardedCount: result.rows.length,
      discarded: result.rows.map(r => r.selector)
    });
  } catch (error) {
    console.error('Error discarding drafts:', error);
    res.status(500).json({ error: 'Failed to discard drafts' });
  }
});

// GET /api/admin/staging/history - Get content change history
router.get('/history', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json([]);
    }

    const { selector, limit = 20 } = req.query;

    let query = `
      SELECT ch.*, u.full_name as published_by_name
      FROM content_history ch
      LEFT JOIN users u ON ch.published_by = u.id
    `;
    let params = [];

    if (selector) {
      query += ` WHERE ch.selector = $1`;
      params.push(selector);
    }

    query += ` ORDER BY ch.created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching history:', error);
    res.json([]);
  }
});

// POST /api/admin/staging/revert - Revert to a previous version
router.post('/revert', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const { historyId } = req.body;
    const userId = req.user?.id || null;

    if (!historyId) {
      return res.status(400).json({ error: 'History ID required' });
    }

    // Get the history entry
    const historyResult = await pool.query(`
      SELECT selector, element_type, content, styles
      FROM content_history
      WHERE id = $1
    `, [historyId]);

    if (historyResult.rows.length === 0) {
      return res.status(404).json({ error: 'History entry not found' });
    }

    const entry = historyResult.rows[0];

    // Create revert history entry
    await pool.query(`
      INSERT INTO content_history (selector, element_type, content, styles, action, published_by, created_at)
      VALUES ($1, $2, $3, $4, 'revert', $5, NOW())
    `, [entry.selector, entry.element_type, entry.content, JSON.stringify(entry.styles), userId]);

    // Update production content
    await pool.query(`
      UPDATE production_content
      SET content = $1, styles = $2, published_at = NOW()
      WHERE selector = $3
    `, [entry.content, JSON.stringify(entry.styles), entry.selector]);

    // Remove any pending draft for this selector
    await pool.query(`
      DELETE FROM staging_content WHERE selector = $1
    `, [entry.selector]);

    res.json({
      success: true,
      reverted: entry.selector
    });
  } catch (error) {
    console.error('Error reverting content:', error);
    res.status(500).json({ error: 'Failed to revert content' });
  }
});

// POST /api/admin/staging/theme - Save theme settings
router.post('/theme', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const { primary_color, secondary_color, accent_color, font_family, is_draft = true } = req.body;

    // Upsert theme (only one row per draft status)
    await pool.query(`
      INSERT INTO site_theme (theme_name, primary_color, secondary_color, accent_color, font_family, is_draft, created_at, updated_at)
      VALUES ('default', $1, $2, $3, $4, $5, NOW(), NOW())
      ON CONFLICT (id) WHERE id = (SELECT id FROM site_theme WHERE is_draft = $5 LIMIT 1)
      DO UPDATE SET
        primary_color = EXCLUDED.primary_color,
        secondary_color = EXCLUDED.secondary_color,
        accent_color = EXCLUDED.accent_color,
        font_family = EXCLUDED.font_family,
        updated_at = NOW()
    `, [primary_color, secondary_color, accent_color, font_family, is_draft]);

    res.json({ success: true });
  } catch (error) {
    console.error('Error saving theme:', error);
    res.status(500).json({ error: 'Failed to save theme' });
  }
});

// GET /api/admin/staging/theme - Get current theme
router.get('/theme', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json({ draft: null, production: null });
    }

    const draftResult = await pool.query(`
      SELECT theme_name, primary_color, secondary_color, accent_color, font_family
      FROM site_theme
      WHERE is_draft = true
      ORDER BY updated_at DESC
      LIMIT 1
    `);

    const productionResult = await pool.query(`
      SELECT theme_name, primary_color, secondary_color, accent_color, font_family
      FROM site_theme
      WHERE is_draft = false
      ORDER BY updated_at DESC
      LIMIT 1
    `);

    res.json({
      draft: draftResult.rows[0] || null,
      production: productionResult.rows[0] || null
    });
  } catch (error) {
    console.error('Error fetching theme:', error);
    res.json({ draft: null, production: null });
  }
});

module.exports = router;
