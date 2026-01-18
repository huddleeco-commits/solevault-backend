const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticateToken } = require('../middleware/auth');

// Middleware to extract userId from JWT token
const extractUserId = (req, res, next) => {
  req.userId = req.user?.id || req.user?.userId || req.user?.sub;

  if (!req.userId) {
    return res.status(401).json({ success: false, error: 'User ID not found in token' });
  }

  next();
};

// Combine middlewares
const auth = [authenticateToken, extractUserId];

// Get all collections for user
router.get('/', auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.*, 
        COUNT(cc.card_id) as card_count,
        COALESCE(SUM(cards.ebay_low), 0) as total_value
      FROM collections c
      LEFT JOIN collection_cards cc ON c.id = cc.collection_id
      LEFT JOIN cards ON cc.card_id = cards.id
      WHERE c.user_id = $1
      GROUP BY c.id
      ORDER BY c.created_at DESC`,
      [req.userId]
    );
    
    res.json({ success: true, collections: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to get collections' });
  }
});

// Get cards in a specific collection
router.get('/:id/cards', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit) : null;
    
    // Verify ownership
    const collectionCheck = await db.query(
      'SELECT id FROM collections WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );
    
    if (collectionCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Collection not found' });
    }
    
    // 🔥 SELECT ALL RELEVANT COLUMNS (based on actual schema)
    let query = `
      SELECT 
        c.id, c.user_id, c.sport, c.player, c.team, c.year, c.set_name,
        c.card_number, c.parallel, c.is_graded, c.grading_company, c.grade,
        c.cert_number, c.front_image_url, c.front_image_thumb, 
        c.back_image_url, c.back_image_thumb,
        c.ebay_avg, c.ebay_low, c.ebay_high, c.ebay_sample_size,
        c.sportscardspro_raw, c.sportscardspro_psa10, c.sportscardspro_psa9,
        c.sportscardspro_psa8, c.sportscardspro_psa7, c.sportscardspro_bgs10,
        c.sportscardspro_cgc10, c.sportscardspro_sgc10,
        c.asking_price, c.listing_price, c.listing_status, c.sold_price,
        c.for_sale, c.is_public, c.short_id, c.public_views,
        c.ebay_listing_url,
        c.acquisition_type, c.purchase_price, c.pack_price, c.cards_in_pack,
        c.estimated_profit, c.profit_margin, c.sold_date, c.buyer_paid_shipping,
        c.net_payout, c.total_fees,
        c.grading_review_status, c.grading_review_notes,
        c.created_at, c.updated_at,
        cc.added_at as added_to_collection
      FROM cards c
      JOIN collection_cards cc ON c.id = cc.card_id
      WHERE cc.collection_id = $1
      ORDER BY cc.added_at DESC
    `;
    
    const params = [id];
    
    if (limit) {
      query += ` LIMIT $2`;
      params.push(limit);
    }

    const result = await db.query(query, params);

    res.json({ success: true, cards: result.rows, total: result.rows.length });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to get cards' });
  }
});

// Create new collection
router.post('/', auth, async (req, res) => {
  try {
    const { name, description, color } = req.body;
    
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Collection name is required' });
    }
    
    const result = await db.query(
      `INSERT INTO collections (user_id, name, description, color)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.userId, name.trim(), description || null, color || '#6366f1']
    );
    
    res.json({ success: true, collection: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to create collection' });
  }
});

// Update collection
router.patch('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, color, is_public } = req.body;
    
    // Verify ownership
    const collectionCheck = await db.query(
      'SELECT * FROM collections WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );
    
    if (collectionCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Collection not found' });
    }
    
    const result = await db.query(
      `UPDATE collections 
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           color = COALESCE($3, color),
           is_public = COALESCE($4, is_public),
           updated_at = NOW()
       WHERE id = $5 AND user_id = $6
       RETURNING *`,
      [name, description, color, is_public, id, req.userId]
    );
    
    res.json({ success: true, collection: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update collection' });
  }
});

// Delete collection
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verify ownership
    const collectionCheck = await db.query(
      'SELECT * FROM collections WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );
    
    if (collectionCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Collection not found' });
    }
    
    await db.query('DELETE FROM collections WHERE id = $1', [id]);
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete collection' });
  }
});

// Add cards to collection
router.post('/:id/cards', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { cardIds } = req.body; // Array of card IDs
    
    if (!Array.isArray(cardIds) || cardIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Card IDs array required' });
    }
    
    // Verify ownership of collection
    const collectionCheck = await db.query(
      'SELECT * FROM collections WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );
    
    if (collectionCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Collection not found' });
    }
    
    // Verify ownership of all cards
    const cardsCheck = await db.query(
      'SELECT id FROM cards WHERE id = ANY($1) AND user_id = $2',
      [cardIds, req.userId]
    );
    
    if (cardsCheck.rows.length !== cardIds.length) {
      return res.status(403).json({ success: false, error: 'Some cards not found or not owned by user' });
    }
    
    // Add cards to collection (use INSERT ON CONFLICT to avoid duplicates)
    const values = cardIds.map((cardId, index) => `($1, $${index + 2})`).join(',');
    const params = [id, ...cardIds];
    
    await db.query(
      `INSERT INTO collection_cards (collection_id, card_id)
       VALUES ${values}
       ON CONFLICT (collection_id, card_id) DO NOTHING`,
      params
    );
    
    res.json({ success: true, added: cardIds.length });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to add cards to collection' });
  }
});

// Remove cards from collection
router.delete('/:id/cards', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { cardIds } = req.body;
    
    if (!Array.isArray(cardIds) || cardIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Card IDs array required' });
    }
    
    // Verify ownership
    const collectionCheck = await db.query(
      'SELECT * FROM collections WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );
    
    if (collectionCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Collection not found' });
    }
    
    await db.query(
      'DELETE FROM collection_cards WHERE collection_id = $1 AND card_id = ANY($2)',
      [id, cardIds]
    );
    
    res.json({ success: true, removed: cardIds.length });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to remove cards from collection' });
  }
});

// Export collection to eBay CSV
router.post('/:id/export-ebay', auth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verify ownership and get cards
    const result = await db.query(
      `SELECT cards.* 
       FROM cards
       JOIN collection_cards cc ON cards.id = cc.card_id
       JOIN collections c ON cc.collection_id = c.id
       WHERE c.id = $1 AND c.user_id = $2`,
      [id, req.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Collection not found or empty' });
    }
    
    // Generate eBay CSV (reuse existing logic from your eBay export)
    const cards = result.rows;
    
    // TODO: Use your existing eBay CSV generation logic here
    // For now, return the cards
    res.json({ success: true, cards: cards.length, cards });

  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to export collection' });
  }
});

module.exports = router;