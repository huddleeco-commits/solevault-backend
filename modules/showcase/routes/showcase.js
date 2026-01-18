const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticateToken } = require('../middleware/auth');

// ============================================
// TIER LIMITS
// ============================================
const SHOWCASE_LIMITS = {
  free: 1,
  power: 3,
  dealer: 999,
  // Legacy tiers get unlimited
  starter: 999,
  pro: 999,
  premium: 999
};

// ============================================
// GET: User's showcases list (authenticated) - MUST BE FIRST!
// ============================================
router.get('/user/list', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const showcasesResult = await db.query(`
      SELECT 
        s.*,
        COUNT(sc.card_id) as card_count
      FROM showcases s
      LEFT JOIN showcase_cards sc ON sc.showcase_id = s.id
      WHERE s.user_id = $1
      GROUP BY s.id
      ORDER BY s.is_default DESC, s.display_order ASC, s.created_at ASC
    `, [userId]);
    
    // Get user's tier for limit checking
    const userResult = await db.query('SELECT subscription_tier FROM users WHERE id = $1', [userId]);
    const tier = userResult.rows[0]?.subscription_tier || 'free';
    const limit = SHOWCASE_LIMITS[tier] || SHOWCASE_LIMITS.free;
    
    res.json({
      success: true,
      showcases: showcasesResult.rows,
      limit: limit,
      canCreateMore: showcasesResult.rows.length < limit
    });
    
  } catch (error) {
    console.error('Get showcases list error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to load showcases' 
    });
  }
});

// ============================================
// GET: Card to Public Showcase mapping (for Card Locations dashboard)
// ⚠️ MUST BE BEFORE /:username ROUTE!
// ============================================
router.get('/card-mappings', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Get all public showcases for this user with their cards
    const result = await db.query(`
      SELECT 
        sc.card_id,
        s.id as showcase_id,
        s.name as showcase_name,
        s.slug as showcase_slug,
        s.theme as showcase_theme
      FROM showcase_cards sc
      JOIN showcases s ON sc.showcase_id = s.id
      WHERE s.user_id = $1 AND s.is_active = true
      ORDER BY sc.card_id, s.display_order
    `, [userId]);
    
    // Build card -> showcases mapping
    const cardShowcaseMap = {};
    result.rows.forEach(row => {
      if (!cardShowcaseMap[row.card_id]) {
        cardShowcaseMap[row.card_id] = [];
      }
      cardShowcaseMap[row.card_id].push({
        id: row.showcase_id,
        name: row.showcase_name,
        slug: row.showcase_slug,
        theme: row.showcase_theme
      });
    });
    
    // Count stats
    const totalMappings = result.rows.length;
    const cardsInShowcases = Object.keys(cardShowcaseMap).length;
    const cardsInMultiple = Object.values(cardShowcaseMap).filter(arr => arr.length > 1).length;
    
    res.json({
      success: true,
      cardShowcaseMap: cardShowcaseMap,
      stats: {
        totalMappings,
        cardsInShowcases,
        cardsInMultiple
      }
    });
    
  } catch (error) {
    console.error('Get card showcase mappings error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to load showcase mappings' 
    });
  }
});

// ============================================
// POST: Create new showcase
// ============================================
router.post('/create', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { name, description, theme, layout, bio, bannerUrl, socialLinks } = req.body;
    
    // Check user's tier and showcase limit
    const userResult = await db.query('SELECT subscription_tier FROM users WHERE id = $1', [userId]);
    const tier = userResult.rows[0]?.subscription_tier || 'free';
    const limit = SHOWCASE_LIMITS[tier] || SHOWCASE_LIMITS.free;
    
    // Count existing showcases
    const countResult = await db.query('SELECT COUNT(*) as count FROM showcases WHERE user_id = $1', [userId]);
    const currentCount = parseInt(countResult.rows[0].count);
    
    if (currentCount >= limit) {
      return res.status(403).json({
        success: false,
        error: `Your ${tier} plan allows ${limit} showcase${limit > 1 ? 's' : ''}. Upgrade to create more!`,
        limit: limit,
        current: currentCount
      });
    }
    
    // Generate slug
    const baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let slug = baseSlug;
    let counter = 1;
    
    // Ensure unique slug
    while (true) {
      const existingSlug = await db.query(
        'SELECT id FROM showcases WHERE user_id = $1 AND slug = $2',
        [userId, slug]
      );
      if (existingSlug.rows.length === 0) break;
      slug = `${baseSlug}-${counter}`;
      counter++;
    }
    
    // Create showcase
    const showcaseResult = await db.query(`
      INSERT INTO showcases (
        user_id, name, slug, description,
        theme, layout, bio, banner_url, social_links,
        is_default, display_order
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
      RETURNING *
    `, [
      userId,
      name,
      slug,
      description || null,
      theme || 'purple',
      layout || 'grid',
      bio || null,
      bannerUrl || null,
      JSON.stringify(socialLinks || {}),
      currentCount === 0, // First showcase is default
      currentCount // Display order
    ]);
    
    res.json({
      success: true,
      showcase: showcaseResult.rows[0],
      message: 'Showcase created successfully!'
    });
    
  } catch (error) {
    console.error('Create showcase error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create showcase' 
    });
  }
});

// ============================================
// PATCH: Set default showcase
// ============================================
router.patch('/:showcaseId/set-default', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const showcaseId = req.params.showcaseId;
    
    // Verify ownership
    const showcaseCheck = await db.query(
      'SELECT id FROM showcases WHERE id = $1 AND user_id = $2',
      [showcaseId, userId]
    );
    
    if (showcaseCheck.rows.length === 0) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized'
      });
    }
    
    // Unset all defaults for this user
    await db.query(
      'UPDATE showcases SET is_default = false WHERE user_id = $1',
      [userId]
    );
    
    // Set new default
    await db.query(
      'UPDATE showcases SET is_default = true WHERE id = $1',
      [showcaseId]
    );
    
    res.json({
      success: true,
      message: 'Default showcase updated'
    });
    
  } catch (error) {
    console.error('Set default showcase error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to set default showcase' 
    });
  }
});

// ============================================
// PATCH: Update showcase
// ============================================
router.patch('/:showcaseId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const showcaseId = req.params.showcaseId;
    const { name, description, theme, layout, bio, bannerUrl, socialLinks } = req.body;
    
    // Verify ownership
    const ownerCheck = await db.query(
      'SELECT id FROM showcases WHERE id = $1 AND user_id = $2',
      [showcaseId, userId]
    );
    
    if (ownerCheck.rows.length === 0) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized'
      });
    }
    
    // Update showcase
    const updateResult = await db.query(`
      UPDATE showcases SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        theme = COALESCE($3, theme),
        layout = COALESCE($4, layout),
        bio = COALESCE($5, bio),
        banner_url = COALESCE($6, banner_url),
        social_links = COALESCE($7::jsonb, social_links),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
      RETURNING *
    `, [name, description, theme, layout, bio, bannerUrl, JSON.stringify(socialLinks), showcaseId]);
    
    res.json({
      success: true,
      showcase: updateResult.rows[0]
    });
    
  } catch (error) {
    console.error('Update showcase error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update showcase' 
    });
  }
});

// ============================================
// DELETE: Delete showcase
// ============================================
router.delete('/:showcaseId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const showcaseId = req.params.showcaseId;
    
    // Verify ownership
    const showcaseCheck = await db.query(
      'SELECT is_default FROM showcases WHERE id = $1 AND user_id = $2',
      [showcaseId, userId]
    );
    
    if (showcaseCheck.rows.length === 0) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized'
      });
    }
    
    const isDefault = showcaseCheck.rows[0].is_default;
    
    // Don't allow deleting default showcase if it's the only one
    if (isDefault) {
      const countResult = await db.query(
        'SELECT COUNT(*) as count FROM showcases WHERE user_id = $1',
        [userId]
      );
      if (parseInt(countResult.rows[0].count) === 1) {
        return res.status(400).json({
          success: false,
          error: 'Cannot delete your only showcase'
        });
      }
      
      // Set another showcase as default
      await db.query(`
        UPDATE showcases SET is_default = true
        WHERE user_id = $1 AND id != $2
        ORDER BY created_at ASC
        LIMIT 1
      `, [userId, showcaseId]);
    }
    
    // Delete showcase (CASCADE will delete showcase_cards entries)
    await db.query('DELETE FROM showcases WHERE id = $1', [showcaseId]);
    
    res.json({
      success: true,
      message: 'Showcase deleted successfully'
    });
    
  } catch (error) {
    console.error('Delete showcase error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete showcase' 
    });
  }
});

// ============================================
// GET: Get cards in a showcase
// ============================================
router.get('/:showcaseId/cards', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const showcaseId = req.params.showcaseId;
    
    // Verify ownership
    const showcaseCheck = await db.query(
      'SELECT id FROM showcases WHERE id = $1 AND user_id = $2',
      [showcaseId, userId]
    );
    
    if (showcaseCheck.rows.length === 0) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized'
      });
    }
    
    // Get cards in this showcase
    const cardsResult = await db.query(`
      SELECT c.*, sc.display_order
      FROM showcase_cards sc
      JOIN cards c ON c.id = sc.card_id
      WHERE sc.showcase_id = $1
      ORDER BY sc.display_order ASC, sc.added_at DESC
    `, [showcaseId]);
    
    res.json({
      success: true,
      cards: cardsResult.rows
    });
    
  } catch (error) {
    console.error('Get showcase cards error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to load showcase cards' 
    });
  }
});

// ============================================
// POST: Add cards to showcase
// ============================================
router.post('/:showcaseId/cards', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const showcaseId = req.params.showcaseId;
    const { cardIds } = req.body;
    
    console.log('🎯 ADD TO SHOWCASE:', { userId, showcaseId, cardIds });
    
    // Verify ownership of showcase
    const showcaseCheck = await db.query(
      'SELECT id FROM showcases WHERE id = $1 AND user_id = $2',
      [showcaseId, userId]
    );
    
    if (showcaseCheck.rows.length === 0) {
      console.log('❌ Showcase not found or unauthorized');
      return res.status(403).json({
        success: false,
        error: 'Unauthorized'
      });
    }
    
    console.log('✅ Showcase verified:', showcaseCheck.rows[0]);
    
    // Add cards to showcase
    let addedCount = 0;
    for (let i = 0; i < cardIds.length; i++) {
      const cardId = cardIds[i];
      
      // Verify card ownership
      const cardCheck = await db.query(
        'SELECT id FROM cards WHERE id = $1 AND user_id = $2',
        [cardId, userId]
      );
      
      if (cardCheck.rows.length > 0) {
        console.log(`✅ Adding card ${cardId} to showcase ${showcaseId}`);
        
        const result = await db.query(`
          INSERT INTO showcase_cards (showcase_id, card_id, display_order)
          VALUES ($1, $2, $3)
          ON CONFLICT (showcase_id, card_id) DO NOTHING
          RETURNING *
        `, [showcaseId, cardId, i]);
        
        console.log(`✅ Insert result:`, result.rows[0]);
        
        // 🔥 ALSO SET CARD AS PUBLIC with short_id for individual card page
        const shortId = require('crypto').randomBytes(4).toString('hex');
        await db.query(`
          UPDATE cards 
          SET is_public = true, 
              short_id = COALESCE(short_id, $1)
          WHERE id = $2 AND short_id IS NULL
        `, [shortId, cardId]);
        
        // If card already had short_id, just make sure it's public
        await db.query(`
          UPDATE cards SET is_public = true WHERE id = $1
        `, [cardId]);
        
        console.log(`✅ Card ${cardId} set to public with short_id`);
        
        addedCount++;
      } else {
        console.log(`❌ Card ${cardId} not found or not owned by user`);
      }
    }
    
    console.log(`🎉 Added ${addedCount} cards to showcase ${showcaseId}`);
    
    res.json({
      success: true,
      addedCount: addedCount,
      message: `Added ${addedCount} card${addedCount !== 1 ? 's' : ''} to showcase`
    });
    
  } catch (error) {
    console.error('Add cards to showcase error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to add cards to showcase' 
    });
  }
});

// ============================================
// DELETE: Remove card from showcase
// ============================================
router.delete('/:showcaseId/cards/:cardId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { showcaseId, cardId } = req.params;
    
    // Verify ownership
    const showcaseCheck = await db.query(
      'SELECT id FROM showcases WHERE id = $1 AND user_id = $2',
      [showcaseId, userId]
    );
    
    if (showcaseCheck.rows.length === 0) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized'
      });
    }
    
    // Remove card from showcase
    await db.query(
      'DELETE FROM showcase_cards WHERE showcase_id = $1 AND card_id = $2',
      [showcaseId, cardId]
    );
    
    res.json({
      success: true,
      message: 'Card removed from showcase'
    });
    
  } catch (error) {
    console.error('Remove card from showcase error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to remove card from showcase' 
    });
  }
});

// ============================================
// LEGACY: Update showcase settings (backwards compatible)
// ============================================
router.patch('/settings', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { theme, layout, bio, bannerUrl, socialLinks } = req.body;

    // Update default showcase
    await db.query(`
      UPDATE showcases SET
        theme = $1,
        layout = $2,
        bio = $3,
        banner_url = $4,
        social_links = $5::jsonb,
        updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $6 AND is_default = true
    `, [theme, layout, bio, bannerUrl, JSON.stringify(socialLinks), userId]);

    res.json({ 
      success: true,
      message: 'Showcase settings updated'
    });
  } catch (error) {
    console.error('Failed to update showcase settings:', error);
    res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

// ============================================
// LEGACY: Vendor marketplace setup (keep for backwards compat)
// ============================================
router.post('/vendor-setup', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { profile, displaySettings, selectedCards } = req.body;

    // Store vendor profile
    await db.query(`
      UPDATE users 
      SET 
        vendor_profile = $1::jsonb,
        vendor_display_settings = $2::jsonb,
        vendor_enabled = true,
        vendor_setup_date = CURRENT_TIMESTAMP
      WHERE id = $3
    `, [JSON.stringify(profile), JSON.stringify(displaySettings), userId]);

    // Mark selected cards as vendor display items
    if (selectedCards && selectedCards.length > 0) {
      const placeholders = selectedCards.map((_, i) => `$${i + 2}`).join(',');
      await db.query(`
        UPDATE cards 
        SET vendor_display = true 
        WHERE user_id = $1 AND id IN (${placeholders})
      `, [userId, ...selectedCards]);
    }

    res.json({ 
      success: true, 
      message: 'Vendor marketplace setup complete',
      vendorUrl: `/vendor/${profile.businessName.toLowerCase().replace(/\s/g, '')}`
    });

  } catch (error) {
    console.error('Vendor setup error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to save vendor setup' 
    });
  }
});

// ============================================
// GET: Public showcase - Default (username only)
// ⚠️ MUST BE AFTER ALL OTHER SPECIFIC ROUTES!
// ============================================
router.get('/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const { 
      page = 1, 
      limit = 50,
      search = '',
      sport = '',
      is_graded = '',
      grading_company = '',
      year = '',
      for_sale = '',
      parallel = '',
      min_price = '',
      max_price = ''
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Get user info
    const userResult = await db.query(`
      SELECT id, email, full_name, subscription_tier
      FROM users 
      WHERE LOWER(full_name) = LOWER($1) 
         OR LOWER(email) = LOWER($2)
         OR LOWER(SPLIT_PART(email, '@', 1)) = LOWER($3)
      LIMIT 1
    `, [username, username, username]);
    
    if (!userResult.rows || userResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    const user = userResult.rows[0];
    
    // Get default showcase
    const showcaseResult = await db.query(`
      SELECT * FROM showcases
      WHERE user_id = $1 AND is_default = true AND is_active = true
      ORDER BY created_at ASC
      LIMIT 1
    `, [user.id]);
    
    if (showcaseResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No public showcase found'
      });
    }
    
    const showcase = showcaseResult.rows[0];
    
    // Build WHERE clause with filters
    let whereConditions = ['sc.showcase_id = $1'];
    let queryParams = [showcase.id];
    let paramIndex = 2;

    if (search) {
      whereConditions.push(`(
        c.player ILIKE $${paramIndex} OR 
        c.set_name ILIKE $${paramIndex} OR 
        c.team ILIKE $${paramIndex} OR
        c.card_number::text ILIKE $${paramIndex} OR
        c.parallel ILIKE $${paramIndex}
      )`);
      queryParams.push(`%${search}%`);
      paramIndex++;
    }

    if (sport) {
      whereConditions.push(`c.sport = $${paramIndex}`);
      queryParams.push(sport);
      paramIndex++;
    }

    if (is_graded === 'true') {
      whereConditions.push(`c.is_graded = true`);
    } else if (is_graded === 'false') {
      whereConditions.push(`c.is_graded = false`);
    }

    if (grading_company) {
      whereConditions.push(`c.grading_company = $${paramIndex}`);
      queryParams.push(grading_company);
      paramIndex++;
    }

    if (year) {
      whereConditions.push(`c.year = $${paramIndex}`);
      queryParams.push(year);
      paramIndex++;
    }

    if (for_sale === 'true') {
      whereConditions.push(`c.for_sale = true`);
    }

    if (parallel && parallel !== 'Base') {
      whereConditions.push(`c.parallel = $${paramIndex}`);
      queryParams.push(parallel);
      paramIndex++;
    } else if (parallel === 'Base') {
      whereConditions.push(`(c.parallel = 'Base' OR c.parallel IS NULL)`);
    }

    if (min_price) {
      whereConditions.push(`(
        (c.listing_price >= $${paramIndex} AND c.listing_price IS NOT NULL) OR 
        (c.asking_price >= $${paramIndex} AND c.asking_price IS NOT NULL)
      )`);
      queryParams.push(parseFloat(min_price));
      paramIndex++;
    }
    if (max_price) {
      whereConditions.push(`(
        (c.listing_price <= $${paramIndex} AND c.listing_price IS NOT NULL) OR 
        (c.asking_price <= $${paramIndex} AND c.asking_price IS NOT NULL)
      )`);
      queryParams.push(parseFloat(max_price));
      paramIndex++;
    }

    const whereClause = 'WHERE ' + whereConditions.join(' AND ');

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM showcase_cards sc
      JOIN cards c ON c.id = sc.card_id
      ${whereClause}
    `;
    const countResult = await db.query(countQuery, queryParams);
    const totalCards = parseInt(countResult.rows[0].total);

    // Get paginated cards
    queryParams.push(parseInt(limit), offset);
    const cardsQuery = `
      SELECT 
        c.id,
        c.short_id,
        c.player,
        c.year,
        c.set_name,
        c.card_number,
        c.team,
        c.sport,
        c.parallel,
        c.front_image_url,
        c.is_graded,
        c.grading_company,
        c.grade,
        c.for_sale,
        c.asking_price,
        c.listing_price,
        c.ebay_listing_url,
        c.listing_status,
        c.public_views as views,
        sc.display_order
      FROM showcase_cards sc
      JOIN cards c ON c.id = sc.card_id
      ${whereClause}
      ORDER BY sc.display_order ASC, sc.added_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    
    const cardsResult = await db.query(cardsQuery, queryParams);
    
    // Get filter options
    const sportsResult = await db.query(
      `SELECT DISTINCT c.sport FROM showcase_cards sc JOIN cards c ON c.id = sc.card_id WHERE sc.showcase_id = $1 AND c.sport IS NOT NULL ORDER BY c.sport`,
      [showcase.id]
    );
    
    const gradingCompaniesResult = await db.query(
      `SELECT DISTINCT c.grading_company FROM showcase_cards sc JOIN cards c ON c.id = sc.card_id WHERE sc.showcase_id = $1 AND c.is_graded = true AND c.grading_company IS NOT NULL ORDER BY c.grading_company`,
      [showcase.id]
    );
    
    const yearsResult = await db.query(
      `SELECT DISTINCT c.year FROM showcase_cards sc JOIN cards c ON c.id = sc.card_id WHERE sc.showcase_id = $1 AND c.year IS NOT NULL ORDER BY c.year DESC`,
      [showcase.id]
    );
    
    const parallelsResult = await db.query(
      `SELECT DISTINCT c.parallel FROM showcase_cards sc JOIN cards c ON c.id = sc.card_id WHERE sc.showcase_id = $1 AND c.parallel IS NOT NULL ORDER BY c.parallel`,
      [showcase.id]
    );
    
    // Get all showcases for switcher
    const allShowcasesResult = await db.query(`
      SELECT id, name, slug, description
      FROM showcases
      WHERE user_id = $1 AND is_active = true
      ORDER BY display_order ASC, created_at ASC
    `, [user.id]);
    
    res.json({
      success: true,
      user: {
        username: user.full_name || user.email.split('@')[0],
        display_name: user.full_name,
        theme: showcase.theme,
        banner: showcase.banner_url,
        bio: showcase.bio,
        social: showcase.social_links
      },
      showcase: {
        id: showcase.id,
        name: showcase.name,
        slug: showcase.slug,
        description: showcase.description,
        theme: showcase.theme || 'purple',
        layout: showcase.layout || 'grid',
        is_default: showcase.is_default
      },
      showcases: allShowcasesResult.rows,
      cards: cardsResult.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCards,
        totalPages: Math.ceil(totalCards / parseInt(limit)),
        hasMore: offset + cardsResult.rows.length < totalCards
      },
      filterOptions: {
        sports: sportsResult.rows.map(r => r.sport),
        gradingCompanies: gradingCompaniesResult.rows.map(r => r.grading_company),
        years: yearsResult.rows.map(r => r.year),
        parallels: parallelsResult.rows.map(r => r.parallel)
      }
    });
    
  } catch (error) {
    console.error('Get showcase error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to load showcase' 
    });
  }
});

// ============================================
// GET: Public showcase - Specific showcase by slug
// ============================================
router.get('/:username/:showcaseSlug', async (req, res) => {
  try {
    const { username, showcaseSlug } = req.params;
    const { 
      page = 1, 
      limit = 50,
      search = '',
      sport = '',
      is_graded = '',
      grading_company = '',
      year = '',
      for_sale = '',
      parallel = '',
      min_price = '',
      max_price = ''
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Get user info
    const userResult = await db.query(`
      SELECT id, email, full_name, subscription_tier
      FROM users 
      WHERE LOWER(full_name) = LOWER($1) 
         OR LOWER(email) = LOWER($2)
         OR LOWER(SPLIT_PART(email, '@', 1)) = LOWER($3)
      LIMIT 1
    `, [username, username, username]);
    
    if (!userResult.rows || userResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    const user = userResult.rows[0];
    
    // Get specific showcase by slug
    const showcaseResult = await db.query(`
      SELECT * FROM showcases
      WHERE user_id = $1 AND slug = $2 AND is_active = true
    `, [user.id, showcaseSlug]);
    
    if (showcaseResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Showcase not found'
      });
    }
    
    const showcase = showcaseResult.rows[0];
    
    // Build WHERE clause with filters
    let whereConditions = ['sc.showcase_id = $1'];
    let queryParams = [showcase.id];
    let paramIndex = 2;

    if (search) {
      whereConditions.push(`(
        c.player ILIKE $${paramIndex} OR 
        c.set_name ILIKE $${paramIndex} OR 
        c.team ILIKE $${paramIndex} OR
        c.card_number::text ILIKE $${paramIndex} OR
        c.parallel ILIKE $${paramIndex}
      )`);
      queryParams.push(`%${search}%`);
      paramIndex++;
    }

    if (sport) {
      whereConditions.push(`c.sport = $${paramIndex}`);
      queryParams.push(sport);
      paramIndex++;
    }

    if (is_graded === 'true') {
      whereConditions.push(`c.is_graded = true`);
    } else if (is_graded === 'false') {
      whereConditions.push(`c.is_graded = false`);
    }

    if (grading_company) {
      whereConditions.push(`c.grading_company = $${paramIndex}`);
      queryParams.push(grading_company);
      paramIndex++;
    }

    if (year) {
      whereConditions.push(`c.year = $${paramIndex}`);
      queryParams.push(year);
      paramIndex++;
    }

    if (for_sale === 'true') {
      whereConditions.push(`c.for_sale = true`);
    }

    if (parallel && parallel !== 'Base') {
      whereConditions.push(`c.parallel = $${paramIndex}`);
      queryParams.push(parallel);
      paramIndex++;
    } else if (parallel === 'Base') {
      whereConditions.push(`(c.parallel = 'Base' OR c.parallel IS NULL)`);
    }

    if (min_price) {
      whereConditions.push(`(
        (c.listing_price >= $${paramIndex} AND c.listing_price IS NOT NULL) OR 
        (c.asking_price >= $${paramIndex} AND c.asking_price IS NOT NULL)
      )`);
      queryParams.push(parseFloat(min_price));
      paramIndex++;
    }
    if (max_price) {
      whereConditions.push(`(
        (c.listing_price <= $${paramIndex} AND c.listing_price IS NOT NULL) OR 
        (c.asking_price <= $${paramIndex} AND c.asking_price IS NOT NULL)
      )`);
      queryParams.push(parseFloat(max_price));
      paramIndex++;
    }

    const whereClause = 'WHERE ' + whereConditions.join(' AND ');

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM showcase_cards sc
      JOIN cards c ON c.id = sc.card_id
      ${whereClause}
    `;
    const countResult = await db.query(countQuery, queryParams);
    const totalCards = parseInt(countResult.rows[0].total);

    // Get paginated cards
    queryParams.push(parseInt(limit), offset);
    const cardsQuery = `
      SELECT 
        c.id,
        c.short_id,
        c.player,
        c.year,
        c.set_name,
        c.card_number,
        c.team,
        c.sport,
        c.parallel,
        c.front_image_url,
        c.is_graded,
        c.grading_company,
        c.grade,
        c.for_sale,
        c.asking_price,
        c.listing_price,
        c.ebay_listing_url,
        c.listing_status,
        c.public_views as views,
        sc.display_order
      FROM showcase_cards sc
      JOIN cards c ON c.id = sc.card_id
      ${whereClause}
      ORDER BY sc.display_order ASC, sc.added_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    
    const cardsResult = await db.query(cardsQuery, queryParams);
    
    // Get filter options
    const sportsResult = await db.query(
      `SELECT DISTINCT c.sport FROM showcase_cards sc JOIN cards c ON c.id = sc.card_id WHERE sc.showcase_id = $1 AND c.sport IS NOT NULL ORDER BY c.sport`,
      [showcase.id]
    );
    
    const gradingCompaniesResult = await db.query(
      `SELECT DISTINCT c.grading_company FROM showcase_cards sc JOIN cards c ON c.id = sc.card_id WHERE sc.showcase_id = $1 AND c.is_graded = true AND c.grading_company IS NOT NULL ORDER BY c.grading_company`,
      [showcase.id]
    );
    
    const yearsResult = await db.query(
      `SELECT DISTINCT c.year FROM showcase_cards sc JOIN cards c ON c.id = sc.card_id WHERE sc.showcase_id = $1 AND c.year IS NOT NULL ORDER BY c.year DESC`,
      [showcase.id]
    );
    
    const parallelsResult = await db.query(
      `SELECT DISTINCT c.parallel FROM showcase_cards sc JOIN cards c ON c.id = sc.card_id WHERE sc.showcase_id = $1 AND c.parallel IS NOT NULL ORDER BY c.parallel`,
      [showcase.id]
    );
    
    // Get all showcases for switcher
    const allShowcasesResult = await db.query(`
      SELECT id, name, slug, description
      FROM showcases
      WHERE user_id = $1 AND is_active = true
      ORDER BY display_order ASC, created_at ASC
    `, [user.id]);
    
    res.json({
      success: true,
      user: {
        username: user.full_name || user.email.split('@')[0],
        display_name: user.full_name,
        theme: showcase.theme,
        banner: showcase.banner_url,
        bio: showcase.bio,
        social: showcase.social_links
      },
      showcase: {
        id: showcase.id,
        name: showcase.name,
        slug: showcase.slug,
        description: showcase.description,
        theme: showcase.theme || 'purple',
        layout: showcase.layout || 'grid',
        is_default: showcase.is_default
      },
      showcases: allShowcasesResult.rows,
      cards: cardsResult.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCards,
        totalPages: Math.ceil(totalCards / parseInt(limit)),
        hasMore: offset + cardsResult.rows.length < totalCards
      },
      filterOptions: {
        sports: sportsResult.rows.map(r => r.sport),
        gradingCompanies: gradingCompaniesResult.rows.map(r => r.grading_company),
        years: yearsResult.rows.map(r => r.year),
        parallels: parallelsResult.rows.map(r => r.parallel)
      }
    });
    
  } catch (error) {
    console.error('Get showcase error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to load showcase' 
    });
  }
});

module.exports = router;