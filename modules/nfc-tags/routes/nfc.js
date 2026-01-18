const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticateToken } = require('../middleware/auth');

// ==========================================
// REGISTER NFC TAG TO CARD
// ==========================================
router.post('/register-tag', authenticateToken, async (req, res) => {
  try {
    const { nfc_uid, card_id } = req.body;
    const userId = req.user.userId;
    
    if (!nfc_uid || !card_id) {
      return res.status(400).json({ 
        success: false, 
        error: 'NFC UID and card ID required' 
      });
    }
    
    // Verify user owns the card
    const cardCheck = await db.query(
      'SELECT id FROM cards WHERE id = ? AND user_id = ?',
      [card_id, userId]
    );
    
    if (cardCheck.rows.length === 0) {
      return res.status(403).json({ 
        success: false, 
        error: 'Card not found or not owned by user' 
      });
    }
    
    // Check if NFC tag already exists
    const existingTag = await db.query(
      'SELECT * FROM nfc_tags WHERE nfc_uid = ?',
      [nfc_uid]
    );
    
    if (existingTag.rows.length > 0) {
      // Update existing tag
      await db.query(
        'UPDATE nfc_tags SET card_id = ?, user_id = ? WHERE nfc_uid = ?',
        [card_id, userId, nfc_uid]
      );
      
      console.log(`✅ Updated NFC tag ${nfc_uid} -> card ${card_id}`);
    } else {
      // Create new tag
      await db.query(
        'INSERT INTO nfc_tags (nfc_uid, card_id, user_id) VALUES (?, ?, ?)',
        [nfc_uid, card_id, userId]
      );
      
      console.log(`✅ Created NFC tag ${nfc_uid} -> card ${card_id}`);
    }
    
    res.json({ 
      success: true, 
      message: 'NFC tag registered successfully',
      nfc_uid,
      card_id
    });
    
  } catch (error) {
    console.error('Register NFC tag error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to register NFC tag' 
    });
  }
});

// ==========================================
// GET CARD BY NFC TAP
// ==========================================
router.get('/scan/:nfc_uid', async (req, res) => {
  try {
    const { nfc_uid } = req.params;
    
    console.log(`📱 NFC scan detected: ${nfc_uid}`);
    
    // Look up NFC tag
    const tagResult = await db.query(
      'SELECT * FROM nfc_tags WHERE nfc_uid = ?',
      [nfc_uid]
    );
    
    if (tagResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'NFC tag not registered' 
      });
    }
    
    const tag = tagResult.rows[0];
    
    // Get full card details
    const cardResult = await db.query(`
      SELECT 
        id, user_id, player, year, set_name, card_number, parallel, team, sport,
        front_image_url, back_image_url, front_image_thumb, back_image_thumb,
        is_graded, grading_company, grade, cert_number,
        is_autographed, numbered, serial_number, numbered_to,
        asking_price, ebay_avg, ebay_low, ebay_high, ebay_sample_size,
        listing_status, created_at
      FROM cards 
      WHERE id = ?
    `, [tag.card_id]);
    
    if (cardResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Card not found' 
      });
    }
    
    const card = cardResult.rows[0];
    
    // Log the scan
    await db.query(
      'INSERT INTO nfc_scan_logs (user_id, card_id, nfc_tag_id, device_type) VALUES (?, ?, ?, ?)',
      [card.user_id, card.id, tag.id, 'unknown']
    );
    
    // Update last scanned timestamp
    await db.query(
      'UPDATE nfc_tags SET last_scanned = NOW() WHERE id = ?',
      [tag.id]
    );
    
    console.log(`✅ Card found: ${card.player} - ${card.year} ${card.set_name}`);
    
    res.json({ 
      success: true, 
      card,
      nfc_tag: {
        uid: tag.nfc_uid,
        registered_at: tag.created_at,
        last_scanned: new Date()
      }
    });
    
  } catch (error) {
    console.error('NFC scan error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to scan NFC tag' 
    });
  }
});

// ==========================================
// GET PUBLIC CARD BY SHORT ID (No Auth Required)
// ==========================================
router.get('/card/:shortId', async (req, res) => {
  try {
    const { shortId } = req.params;
    
    console.log(`🔍 Public card request: ${shortId}`);
    
    // Get card details with owner info
    const cardResult = await db.query(`
      SELECT 
        c.id, c.user_id, c.player, c.year, c.set_name, c.card_number, 
        c.parallel, c.team, c.sport, c.short_id,
        c.front_image_url, c.back_image_url, 
        c.front_image_thumb, c.back_image_thumb,
        c.is_graded, c.grading_company, c.grade, c.cert_number,
        c.is_autographed, c.numbered, c.serial_number, c.numbered_to,
        c.condition, c.asking_price, c.for_sale, c.price_type,
        c.owner_notes, c.trade_interests,
        c.ebay_avg, c.ebay_low, c.ebay_high, c.ebay_sample_size,
        c.ebay_listing_url, c.listing_status,
        c.is_public, c.hide_owner_info,
        c.created_at,
        u.full_name, u.email
      FROM cards c
      LEFT JOIN users u ON c.user_id = u.id
      WHERE c.short_id = $1 AND c.is_public = true
    `, [shortId]);
    
    if (cardResult.rows.length === 0) {
      console.log(`❌ Card not found or not public: ${shortId}`);
      return res.status(404).json({ 
        success: false, 
        error: 'Card not found or not public' 
      });
    }
    
    const card = cardResult.rows[0];
    
    // Update view count (skip if columns don't exist)
    // await db.query(
    //   'UPDATE cards SET views = COALESCE(views, 0) + 1, last_viewed = NOW() WHERE id = ?',
    //   [card.id]
    // );
    
    // Build owner object
    const owner = {
      username: card.full_name || card.email?.split('@')[0] || 'user',
      email: card.hide_owner_info ? null : card.email
    };
    
    // Build cert link if graded
    let certLink = null;
    if (card.is_graded && card.cert_number) {
      if (card.grading_company === 'PSA') {
        certLink = `https://www.psacard.com/cert/${card.cert_number}`;
      } else if (card.grading_company === 'BGS' || card.grading_company === 'Beckett') {
        certLink = `https://www.beckett.com/grading/card-lookup`;
      } else if (card.grading_company === 'SGC') {
        certLink = `https://www.sgccard.com/cert-verification/`;
      }
    }
    
    // Clean up response
    const response = {
      ...card,
      owner,
      certLink,
      owner_theme: 'purple'
    };
    
    // Remove sensitive fields
    delete response.user_id;
    delete response.full_name;
    delete response.email;
    
    console.log(`✅ Public card loaded: ${card.player} - ${card.year} ${card.set_name}`);
    
    res.json({ 
      success: true, 
      card: response
    });
    
  } catch (error) {
    console.error('Get public card error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to load card' 
    });
  }
});

// ==========================================
// GET ALL NFC TAGS FOR USER
// ==========================================
router.get('/tags', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const result = await db.query(`
      SELECT 
        nt.id, nt.nfc_uid, nt.card_id, nt.created_at, nt.last_scanned,
        c.player, c.year, c.set_name, c.front_image_thumb
      FROM nfc_tags nt
      JOIN cards c ON nt.card_id = c.id
      WHERE nt.user_id = ?
      ORDER BY nt.created_at DESC
    `, [userId]);
    
    res.json({ 
      success: true, 
      tags: result.rows 
    });
    
  } catch (error) {
    console.error('Get NFC tags error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get NFC tags' 
    });
  }
});

// ==========================================
// DELETE NFC TAG
// ==========================================
router.delete('/tags/:nfc_uid', authenticateToken, async (req, res) => {
  try {
    const { nfc_uid } = req.params;
    const userId = req.user.userId;
    
    // Verify ownership
    const checkResult = await db.query(
      'SELECT id FROM nfc_tags WHERE nfc_uid = ? AND user_id = ?',
      [nfc_uid, userId]
    );
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'NFC tag not found or not owned by user' 
      });
    }
    
    await db.query(
      'DELETE FROM nfc_tags WHERE nfc_uid = ? AND user_id = ?',
      [nfc_uid, userId]
    );
    
    console.log(`✅ Deleted NFC tag ${nfc_uid}`);
    
    res.json({ 
      success: true, 
      message: 'NFC tag deleted' 
    });
    
  } catch (error) {
    console.error('Delete NFC tag error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete NFC tag' 
    });
  }
});

// ==========================================
// BULK REGISTER NFC TAGS
// ==========================================
router.post('/bulk-register', authenticateToken, async (req, res) => {
  try {
    const { tags } = req.body; // Array of { nfc_uid, card_id }
    const userId = req.user.userId;
    
    if (!Array.isArray(tags) || tags.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Tags array required' 
      });
    }
    
    const results = [];
    
    for (const tag of tags) {
      try {
        // Verify card ownership
        const cardCheck = await db.query(
          'SELECT id FROM cards WHERE id = ? AND user_id = ?',
          [tag.card_id, userId]
        );
        
        if (cardCheck.rows.length === 0) {
          results.push({ 
            nfc_uid: tag.nfc_uid, 
            success: false, 
            error: 'Card not found' 
          });
          continue;
        }
        
        // Register tag
        await db.query(
          'INSERT INTO nfc_tags (nfc_uid, card_id, user_id) VALUES (?, ?, ?) ON CONFLICT (nfc_uid) DO UPDATE SET card_id = ?, user_id = ?',
          [tag.nfc_uid, tag.card_id, userId, tag.card_id, userId]
        );
        
        results.push({ 
          nfc_uid: tag.nfc_uid, 
          card_id: tag.card_id,
          success: true 
        });
        
      } catch (error) {
        results.push({ 
          nfc_uid: tag.nfc_uid, 
          success: false, 
          error: error.message 
        });
      }
    }
    
    const successCount = results.filter(r => r.success).length;
    
    console.log(`✅ Bulk registered ${successCount}/${tags.length} NFC tags`);
    
    res.json({ 
      success: true, 
      registered: successCount,
      total: tags.length,
      results 
    });
    
  } catch (error) {
    console.error('Bulk register error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to bulk register tags' 
    });
  }
});

module.exports = router;