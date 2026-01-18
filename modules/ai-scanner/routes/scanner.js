const express = require('express');
const router = express.Router();
const axios = require('axios');
const { authenticateToken } = require('../middleware/auth');
const claudeScanner = require('../services/claude-scanner');
const db = require('../database/db');
const { uploadImage } = require('../services/cloudinary');
const { lookupCardInDatabase } = require('../services/cardDatabaseLookup');

/**
 * Extract clean parallel name from product name
 * Input: "Shaquille O'Neal [Red Ice] #290"
 * Output: "Red Ice"
 */
function extractCleanParallel(text) {
  if (!text) return null;
  
  // Extract text between square brackets
  const match = text.match(/\[([^\]]+)\]/);
  if (match) {
    return match[1].trim();
  }
  
  // If no brackets, return as-is (might already be clean)
  return text;
}

// Demo scan rate limiting - server-side IP-based
const demoScanLimits = new Map(); // In-memory store: IP -> { date, count }

// AI scan card images (REQUIRES AUTH) - PLATFORM SCANS
router.post('/scan', authenticateToken, async (req, res) => {
    try {
        const { frontImage, backImage } = req.body;

        if (!frontImage) {
            return res.status(400).json({ 
                success: false, 
                error: 'Front image is required' 
            });
        }

        // CHECK SCAN LIMIT BEFORE PROCESSING
        const userResult = await db.query(
            'SELECT subscription_tier, scans_used, usage_reset_date FROM users WHERE id = $1',
            [req.user.userId]
        );
        const user = userResult.rows[0];
        
        const limits = {
            free: 100,
            power: 500,
            dealer: 1500,
            // Legacy tiers get unlimited
            starter: 999999,
            pro: 999999,
            premium: 999999
        };
        
        const tier = user?.subscription_tier || 'free';
        const limit = limits[tier] || 100;
        let used = user?.scans_used || 0;
        
        // CHECK IF RESET DATE HAS PASSED - Reset counter if new month
        const resetDate = user?.usage_reset_date ? new Date(user.usage_reset_date) : null;
        const now = new Date();
        
        if (!resetDate || now > resetDate) {
            const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
            await db.query(
                'UPDATE users SET scans_used = 0, usage_reset_date = $1 WHERE id = $2',
                [nextReset, req.user.userId]
            );
            used = 0;
            console.log(`🔄 Reset scan counter for user ${req.user.userId}, next reset: ${nextReset.toISOString()}`);
        }
        
        // Check if user is admin for unlimited scans
const adminCheck = await db.query('SELECT is_admin FROM users WHERE id = $1', [req.user.userId]);
const isAdmin = adminCheck.rows[0]?.is_admin;

if (!isAdmin && used >= limit) {
    return res.status(403).json({
        success: false,
        error: 'SCAN_LIMIT_REACHED',
        message: `You've reached your ${tier} plan limit of ${limit} scans. Please upgrade to continue scanning.`,
        limit: limit,
        used: used,
        tier: tier
    });
}

// Log for admins
if (isAdmin) {
    console.log(`✅ Admin scan: User ${req.user.userId} has used ${used} scans (unlimited)`);
}

        console.log('Starting AI card scan for user:', req.user.userId);

        // Call Claude Vision API
        const result = await claudeScanner.scanCard(frontImage, backImage);

        // 🔥 DATABASE LOOKUP: Get correct parallel, team, sport
        if (result.success && result.card) {
            const dbLookup = await lookupCardInDatabase(result.card);
            
            if (dbLookup.found) {
                console.log('✅ Database match found - using accurate data');
                // Merge database data with AI data (keep AI's grade/cert)
                result.card = {
                    ...result.card, // Keep AI's is_graded, grade, cert_number, etc.
                    // Keep AI's parallel - it detected the visual characteristics
                    // parallel: dbLookup.card.parallel, // ← DON'T OVERRIDE AI's PARALLEL
                    sport: dbLookup.card.sport, // ← CORRECT FROM DB
                    // DON'T override set_name - AI's version is cleaner (e.g., "Donruss Elite" vs "Basketball Cards 2023 Donruss Elite")
                    // Add database pricing if available
                    sportscardspro_raw: dbLookup.card.sportscardspro_raw,
                    sportscardspro_psa7: dbLookup.card.sportscardspro_psa7,
                    sportscardspro_psa8: dbLookup.card.sportscardspro_psa8,
                    sportscardspro_psa9: dbLookup.card.sportscardspro_psa9,
                    sportscardspro_psa10: dbLookup.card.sportscardspro_psa10,
                    sportscardspro_bgs10: dbLookup.card.sportscardspro_bgs10,
                    sportscardspro_cgc10: dbLookup.card.sportscardspro_cgc10,
                    sportscardspro_sgc10: dbLookup.card.sportscardspro_sgc10,
                    // Mark as database-sourced
                    parallel_source: 'database',
                    database_match: true
                };
            } else {
                console.log('⚠️  No database match - using AI data');
                result.card.parallel_source = 'ai';
                result.card.database_match = false;
            }
        }

        // Store processed images in result
        if (result.success && result.card) {
            // Upload to Cloudinary and get URLs
            const timestamp = Date.now();
            const cardId = `card_${timestamp}`;
            
            // Upload images to Cloudinary with proper user folder structure
            const frontUrl = await uploadImage(
                result.processedFrontImage || frontImage, 
                cardId,
                req.user.userId,
                'front'
            );
            const backUrl = backImage ? await uploadImage(
                result.processedBackImage || backImage, 
                cardId,
                req.user.userId,
                'back'
            ) : null;
            
            result.card.front_image_url = frontUrl;
            result.card.back_image_url = backUrl;
        }

        // Track API usage with cost and tokens - PLATFORM SOURCE
        const scanTimestamp = new Date().toISOString();
        const dateOnly = scanTimestamp.split('T')[0];
        
        try {
            // Calculate cost from token usage
            const apiCost = result.usage ? calculateCost(result.usage) : 0;
            const tokenCount = result.usage ? result.usage.total_tokens : 0;
            const imageCount = backImage ? 2 : 1;
            
            // Store card data WITH IMAGE URLS for admin viewing
            const cardDataWithImages = result.card ? {
                ...result.card,
                // Add the Cloudinary URLs so admin can see images
                front_image: result.card.front_image_url,
                back_image: result.card.back_image_url
            } : null;
            
            // Store each scan individually (no aggregation) - USING ? for db.js conversion
            await db.query(`
                INSERT INTO api_usage (
                    user_id, 
                    api_name, 
                    call_date, 
                    call_count,
                    api_cost,
                    token_count,
                    scan_source,
                    image_count,
                    scan_timestamp,
                    card_data
                )
                VALUES (?, ?, ?, 1, ?, ?, 'platform', ?, ?, ?)
            `, [
                req.user.userId,
                result.success ? 'claude_scan' : 'claude_scan_failed',
                dateOnly,
                apiCost,
                tokenCount,
                imageCount,
                scanTimestamp,
                cardDataWithImages ? JSON.stringify(cardDataWithImages) : null
            ]);
            
            console.log(`✅ Platform scan tracked: $${apiCost.toFixed(4)}, ${tokenCount} tokens, ${imageCount} image(s)`);
        } catch (usageError) {
            console.error('Failed to track API usage:', usageError);
            // Don't fail the request if usage tracking fails
        }

        // 🎯 VALIDATE CARD DATA AGAINST SET INTELLIGENCE DATABASE
        if (result.success && result.card && result.card.card_number) {
            try {
                console.log(`🔍 Checking set intelligence for card #${result.card.card_number}...`);
                
                // Query database for matching card number
                const setMatch = await db.query(`
                    SELECT id, year, brand, product, sport, set_full_name, parallels
                    FROM set_intelligence
                    WHERE checklist LIKE ?
                    LIMIT 1
                `, [`%"card_number":"${result.card.card_number}"%`.replace(/\?/g, '$1')]);
                
                if (setMatch.rows.length > 0) {
                    const correctSet = setMatch.rows[0];
                    console.log(`✅ Found matching set: ${correctSet.set_full_name}`);
                    
                    // Override AI's guess with database truth
                    result.card.year = correctSet.year;
                    result.card.set_name = correctSet.product;
                    result.card.sport = correctSet.sport;
                    
                    console.log(`📝 Corrected: ${result.card.year} ${result.card.set_name} (was AI guess)`);
                } else {
                    console.log(`⚠️  No set match found for card #${result.card.card_number}`);
                }
            } catch (dbError) {
                console.error('❌ Set validation error:', dbError);
                // Don't fail the scan if validation fails
            }
        }

        if (!result.success) {
    return res.json({
        success: false,
        error: result.error,
        card: result.card,
        message: 'AI scan failed. Please enter details manually.'
    });
}

// 🔥 NEW: Try to find exact parallel in database
const parallelMatcher = require('../services/parallel-matcher');
const parallelMatch = await parallelMatcher.findExactParallel({
    player: result.card.player,
    year: result.card.year,
    setName: (result.card.set_name || '').replace(/^\d{4}\s+/, ''),
    cardNumber: result.card.card_number,
    serialNumber: result.card.serial_number,
    numberedTo: result.card.numbered_to,
    sport: result.card.sport
});

// Use database parallel if found, BUT don't override Claude's color detection
const aiParallel = (result.card.parallel || '').toLowerCase();
const colorParallels = ['green', 'red', 'blue', 'orange', 'pink', 'purple', 'gold', 'silver', 'black', 'white', 'teal', 'neon'];
const aiDetectedColor = colorParallels.some(color => aiParallel.includes(color));

if (parallelMatch.source === 'database' && parallelMatch.parallel) {
    // If AI detected a specific color, trust it over database lookup
    if (aiDetectedColor) {
        console.log(`🎨 Keeping AI-detected color parallel: ${result.card.parallel} (ignoring DB: ${parallelMatch.parallel})`);
        result.card.parallel_confidence = 90;
        result.card.parallel_source = 'ai_color';
    } else {
        console.log(`✅ Using database parallel: ${parallelMatch.parallel} (${parallelMatch.confidence}% confidence)`);
        result.card.parallel = extractCleanParallel(parallelMatch.parallel);
    result.card.parallel_confidence = parallelMatch.confidence;
    result.card.parallel_source = 'database';
    }
    
    if (parallelMatch.pricing) {
        result.card.database_psa10 = parallelMatch.pricing.psa10;
        result.card.database_raw = parallelMatch.pricing.raw;
    }
} else {
    console.log(`ℹ️  Using AI parallel + API fallback`);
    result.card.parallel_source = 'api';
    // Also clean AI-detected parallel
    result.card.parallel = extractCleanParallel(result.card.parallel);
}

        // 🔥 AUTO-FETCH PRICING (eBay BIN + SportsCardsPro/Pokemon TCG)
let priceData = null;
let priceDisclaimer = null;
let sportsCardsProData = null;

try {
    const cardType = result.card.sport?.toLowerCase();
    console.log(`🔍 Auto-fetching pricing for ${cardType} card...`);
    
    // ⚡ OPTIMIZATION: If we have database pricing, skip SportsCardsPro API
    const hasDbPricing = result.card.database_psa10 || result.card.database_raw;
    if (hasDbPricing && result.card.parallel_source === 'database') {
        console.log('⚡ Using database pricing - skipping SportsCardsPro API call');
        sportsCardsProData = {
            psa10: result.card.database_psa10,
            raw: result.card.database_raw,
            psa7: null,
            psa8: null,
            psa9: null,
            bgs10: null,
            cgc10: null,
            sgc10: null,
            salesVolume: null,
            source: 'Database'
        };
    }
            
            // 🎴 POKEMON CARDS - Use eBay + PriceCharting
if (cardType === 'pokemon') {
    console.log('🎴 Detected Pokemon card - using eBay + PriceCharting pricing...');
    
    const searchQuery = result.card.ebay_search_string || 
        `${result.card.year} ${result.card.set_name} ${result.card.player}`;
    
    const cardDetails = {
        player: result.card.player,
        year: result.card.year,
        setName: result.card.set_name?.replace(/^\d{4}\s+/, ''),
        cardNumber: result.card.card_number,
        parallel: result.card.parallel,
        sport: result.card.sport
    };
    
    const priceResponse = await axios.post(
        `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/cards/quick-price-check`,
        { searchQuery, cardDetails },
        { 
            headers: { 
                'Authorization': req.headers.authorization,
                'Content-Type': 'application/json' 
            },
            timeout: 10000
        }
    );
    
    const priceResult = priceResponse.data;
    
    // 🔥 CAPTURE PriceCharting data for Pokemon (returned as sportsCardsPro)
    if (priceResult.sportsCardsPro) {
        sportsCardsProData = priceResult.sportsCardsPro;
        console.log(`💎 PriceCharting data retrieved for Pokemon:`, sportsCardsProData);
    }
    
    if (priceResult.success && priceResult.sales && priceResult.sales.length > 0) {
        const prices = priceResult.sales.map(s => s.price).filter(p => p > 0).sort((a, b) => a - b);
        
        if (prices.length > 0) {
            const lowestBIN = prices[0];
            const marketAvg = prices.reduce((sum, p) => sum + p, 0) / prices.length;
            const highest = prices[prices.length - 1];
            
            // 🔥 REMOVED: eBay auto-pricing - user fetches manually via Market Comps
            priceData = {
                ebay_avg: marketAvg,
                ebay_low: lowestBIN,
                ebay_high: highest,
                ebay_sample_size: prices.length
            };
            
            // eBay fields intentionally NOT set on card - user uses CombinedMarketModal
            // tcgplayer fields also NOT auto-set
            
            // 🔥 ADD PriceCharting DATA TO POKEMON CARD
            if (sportsCardsProData) {
                result.card.sportscardspro_raw = sportsCardsProData.raw;
                result.card.sportscardspro_psa7 = sportsCardsProData.psa7;
                result.card.sportscardspro_psa8 = sportsCardsProData.psa8;
                result.card.sportscardspro_psa9 = sportsCardsProData.psa9;
                result.card.sportscardspro_psa10 = sportsCardsProData.psa10;
                result.card.sportscardspro_bgs10 = sportsCardsProData.bgs10;
                result.card.sportscardspro_cgc10 = sportsCardsProData.cgc10;
                result.card.sportscardspro_sgc10 = sportsCardsProData.sgc10;
                result.card.sportscardspro_sales_volume = sportsCardsProData.salesVolume;
            }
            
            console.log(`✅ Pokemon eBay pricing: $${lowestBIN.toFixed(2)} - $${highest.toFixed(2)} (${prices.length} listings)`);
            
            priceDisclaimer = {
                type: 'pokemon',
                message: `💎 POKEMON CARD: Pricing from ${prices.length} active eBay listings. Market avg: $${marketAvg.toFixed(2)}`,
                confidence: 'high'
            };
        }
    } else {
        console.log('⚠️ No Pokemon pricing found');
        priceDisclaimer = {
            type: 'none',
            message: '⚠️ NO MARKET DATA: Could not find active listings for this Pokemon card.',
            confidence: 'none'
        };
    }
}
            // 🏈 SPORTS CARDS - Use SportsCardsPro API
            else {
                console.log('🏈 Detected sports card - using SportsCardsPro API...');
                
                // Build search query (use backend's ebay_search_string if available)
                const searchQuery = result.card.ebay_search_string || 
                    `${result.card.year} ${result.card.set_name} ${result.card.player}`;
                
                const cardDetails = {
                    player: result.card.player,
                    year: result.card.year,
                    setName: result.card.set_name?.replace(/^\d{4}\s+/, ''),
                    cardNumber: result.card.card_number,
                    parallel: result.card.parallel,
                    gradingCompany: result.card.grading_company,
                    grade: result.card.grade,
                    isGraded: !!result.card.grading_company,
                    sport: result.card.sport
                };
                
                // Call the quick-price-check endpoint internally
                const priceResponse = await axios.post(
                    `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/cards/quick-price-check`,
                    { searchQuery, cardDetails },
                    { 
                        headers: { 
                            'Authorization': req.headers.authorization,
                            'Content-Type': 'application/json' 
                        }
                    }
                );
                
                const priceResult = priceResponse.data;
                
                // 🔥 STORE PRICING DATA (SportsCardsPro)
                if (priceResult.sportsCardsPro) {
                    sportsCardsProData = priceResult.sportsCardsPro;
                    console.log(`💎 SportsCardsPro data retrieved:`, sportsCardsProData);
                }
                
                if (priceResult.success && priceResult.sales && priceResult.sales.length > 0) {
                    const prices = priceResult.sales.map(s => s.price).filter(p => p > 0).sort((a, b) => a - b);
                    
                    if (prices.length > 0) {
                        const lowestBIN = prices[0];
                        const marketAvg = prices.reduce((sum, p) => sum + p, 0) / prices.length;
                        const highest = prices[prices.length - 1];
                        
                        // 🔥 REMOVED: eBay auto-pricing - user fetches manually via Market Comps
                        priceData = {
                            ebay_avg: marketAvg,
                            ebay_low: lowestBIN,
                            ebay_high: highest,
                            ebay_sample_size: prices.length
                        };
                        
                        // eBay fields intentionally NOT set on card - user uses CombinedMarketModal
                        
                        // 🔥 ADD SPORTSCARDSPRO DATA TO CARD
                        if (sportsCardsProData) {
                            result.card.sportscardspro_raw = sportsCardsProData.raw;
                            result.card.sportscardspro_psa7 = sportsCardsProData.psa7;
                            result.card.sportscardspro_psa8 = sportsCardsProData.psa8;
                            result.card.sportscardspro_psa9 = sportsCardsProData.psa9;
                            result.card.sportscardspro_psa10 = sportsCardsProData.psa10;
                            result.card.sportscardspro_bgs10 = sportsCardsProData.bgs10;
                            result.card.sportscardspro_cgc10 = sportsCardsProData.cgc10;
                            result.card.sportscardspro_sgc10 = sportsCardsProData.sgc10;
                            result.card.sportscardspro_sales_volume = sportsCardsProData.salesVolume;
                        }
                        
                        // Build disclaimer based on card type
                        if (!result.card.grading_company) {
                            // RAW CARD
                            priceDisclaimer = {
                                type: 'raw',
                                message: '⚠️ RAW CARD PRICING: This is a raw (ungraded) card. Prices shown are estimates based on similar raw cards. Actual value depends heavily on condition, centering, and surface quality. Consider professional grading for accurate valuation.',
                                confidence: 'low'
                            };
                        } else {
                            // GRADED CARD
                            priceDisclaimer = {
                                type: 'graded',
                                message: `✅ GRADED CARD: Pricing based on ${prices.length} current Buy-It-Now listings. Lowest BIN ($${lowestBIN.toFixed(2)}) = best available price right now.`,
                                confidence: 'high'
                            };
                        }
                        
                        console.log(`✅ Auto-priced: Lowest BIN = $${lowestBIN.toFixed(2)}, Market Avg = $${marketAvg.toFixed(2)}`);
                    }
                } else {
                    console.log('⚠️ No pricing data found for this card');
                    priceDisclaimer = {
                        type: 'none',
                        message: '⚠️ NO MARKET DATA: Could not find active listings for this card. This may be a rare card, or the search query needs refinement. You can manually update pricing later.',
                        confidence: 'none'
                    };
                }
            } // 🔥 CLOSING BRACE FOR "else" (sports) BLOCK
            
        } catch (priceError) {
            console.error('❌ Auto-price fetch failed:', priceError.message);
            // Don't fail the scan if pricing fails
            priceDisclaimer = {
                type: 'error',
                message: '⚠️ PRICING UNAVAILABLE: Could not fetch market data at this time. You can update pricing manually from the card details page.',
                confidence: 'none'
            };
        }

        // 🔥 SAVE TO QUICK_CHECKS TABLE FOR RECENT CARDS WIDGET
        if (priceData || sportsCardsProData) {
            try {
                console.log('💾 Saving Quick Price Check to database...');
                
                // 🔥 DEBUG: Log what we're trying to save
                console.log('🔍 DEBUG priceData:', JSON.stringify(priceData));
                console.log('🔍 DEBUG sportsCardsProData:', JSON.stringify(sportsCardsProData));
                
                // 🔥 BUILD VALUES ARRAY WITH LOGGING
                const valuesArray = [
                    req.user.userId,                                    // 1
                    result.card.player,                                  // 2
                    result.card.year,                                    // 3
                    result.card.set_name,                                // 4
                    result.card.card_number,                             // 5
                    result.card.parallel || 'Base',                      // 6
                    result.card.team,                                    // 7
                    result.card.sport,                                   // 8
                    result.card.front_image_url,                         // 9
                    parseFloat(priceData?.ebay_avg) || null,            // 10
                    parseFloat(priceData?.ebay_low) || null,            // 11
                    parseFloat(priceData?.ebay_high) || null,           // 12
                    parseInt(priceData?.ebay_sample_size) || 0,         // 13
                    parseFloat(sportsCardsProData?.raw) || null,        // 14
                    parseFloat(sportsCardsProData?.psa7) || null,       // 15
                    parseFloat(sportsCardsProData?.psa8) || null,       // 16
                    parseFloat(sportsCardsProData?.psa9) || null,       // 17
                    parseFloat(sportsCardsProData?.psa10) || null,      // 18
                    parseFloat(sportsCardsProData?.bgs10) || null,      // 19
                    parseFloat(sportsCardsProData?.cgc10) || null,      // 20
                    parseFloat(sportsCardsProData?.sgc10) || null,      // 21
                    parseInt(sportsCardsProData?.salesVolume) || null,  // 22
                    parseFloat(result.card.tcgplayer_market) || null,   // 23 🔥 NEW
                    parseFloat(result.card.tcgplayer_low) || null,      // 24 🔥 NEW
                    parseFloat(result.card.tcgplayer_mid) || null,      // 25 🔥 NEW
                    parseFloat(result.card.tcgplayer_high) || null,     // 26 🔥 NEW
                    parseInt(result.confidence) || 95,                   // 27
                    'quick_price_check'                                  // 28
                ];
                
                // 🔥 LOG EACH VALUE WITH TYPE
                console.log('🔍 VALUES ARRAY:');
                valuesArray.forEach((val, idx) => {
                    console.log(`  [${idx + 1}] ${typeof val}: ${val}`);
                });
                
                await db.query(`
                    INSERT INTO quick_checks (
                        user_id, player, year, set_name, card_number, parallel,
                        team, sport, thumbnail_url, 
                        ebay_avg, ebay_low, ebay_high, ebay_sample_size,
                        sportscardspro_raw, sportscardspro_psa7, sportscardspro_psa8,
                        sportscardspro_psa9, sportscardspro_psa10, sportscardspro_bgs10,
                        sportscardspro_cgc10, sportscardspro_sgc10, sportscardspro_sales_volume,
                        tcgplayer_market, tcgplayer_low, tcgplayer_mid, tcgplayer_high,
                        confidence_score, check_mode
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, valuesArray);
                
                console.log('✅ Quick Price Check saved to database');
            } catch (dbError) {
                console.error('❌ Failed to save Quick Price Check:', dbError);
                // Don't fail the request if saving fails
            }
        }

        // 🔥 AUTO-SAVE DISABLED - USER CLICKS "ADD TO COLLECTION" MANUALLY
        let savedCardId = null;

        res.json({
            success: true,
            card: result.card,
            cardId: null,
            confidence: result.confidence,
            pricing: priceData,
            sportsCardsPro: sportsCardsProData,
            priceDisclaimer: priceDisclaimer,
            message: 'Card scanned successfully! Review details and click "Add to Collection" when ready.'
        });

    } catch (error) {
        console.error('Scanner route error:', error);
        
        // Check if it's an overload error (529)
        if (error.status === 529 || error.message?.includes('overloaded') || error.message?.includes('Overloaded')) {
            try {
                const scanTimestamp = new Date().toISOString();
                const dateOnly = scanTimestamp.split('T')[0];
                const imageCount = req.body.backImage ? 2 : 1;
                
                await db.query(`
                    INSERT INTO api_usage (
                        user_id, api_name, call_date, call_count,
                        api_cost, token_count, scan_source, image_count,
                        scan_timestamp, card_data
                    )
                    VALUES (?, 'claude_overloaded', ?, 1, 0, 0, 'platform', ?, ?, ?)
                `, [req.user.userId, dateOnly, imageCount, scanTimestamp, JSON.stringify({ error: 'Overloaded' })]);
            } catch (usageError) {
                console.error('Failed to track overload:', usageError);
            }
            
            return res.status(503).json({
                success: false,
                error: 'AI_OVERLOADED',
                message: 'AI scanning is temporarily overloaded. Please try again in a few minutes.',
                retryAfter: 120,
                statusUrl: 'https://status.anthropic.com'
            });
        }
        
        // Check if it's a rate limit (429)
        if (error.status === 429) {
            return res.status(429).json({
                success: false,
                error: 'RATE_LIMITED',
                message: 'Too many requests. Please wait a moment and try again.',
                retryAfter: 60,
                statusUrl: 'https://status.anthropic.com'
            });
        }
        
        // Track failed scan without images
        try {
            const scanTimestamp = new Date().toISOString();
            const dateOnly = scanTimestamp.split('T')[0];
            const imageCount = req.body.backImage ? 2 : 1;
            
            // Store error data without images
            const failedScanData = {
                error: error.message
            };
            
            await db.query(`
                INSERT INTO api_usage (
                    user_id, 
                    api_name, 
                    call_date, 
                    call_count,
                    api_cost,
                    token_count,
                    scan_source,
                    image_count,
                    scan_timestamp,
                    card_data
                )
                VALUES (?, 'claude_scan_failed', ?, 1, 0, 0, 'platform', ?, ?, ?)
            `, [req.user.userId, dateOnly, imageCount, scanTimestamp, JSON.stringify(failedScanData)]);
        } catch (usageError) {
            console.error('Failed to track failed scan:', usageError);
        }
        
        res.status(500).json({ 
            success: false, 
            error: 'SCAN_FAILED',
            message: 'Card scanning failed. Please try again in a moment.',
            retryAfter: 30
        });
    }
});

// NEW: Analyze card WITHOUT saving (for two-step verification flow)
router.post('/analyze', authenticateToken, async (req, res) => {
    try {
        const { frontImage, backImage } = req.body;

        if (!frontImage) {
            return res.status(400).json({ 
                success: false, 
                error: 'Front image is required' 
            });
        }

        console.log('🔍 Analyzing card for user:', req.user.userId);

        // Call Claude Vision API (no saving yet)
        const result = await claudeScanner.scanCard(frontImage, backImage);

        if (!result.success) {
            return res.json({
                success: false,
                error: result.error,
                card: result.card,
                message: 'AI analysis failed. Please enter details manually.'
            });
        }

        // Calculate parallel confidence
        const parallel = result.card.parallel || 'Base';
        let parallelConfidence = 0.85; // Default confidence
        let suggestions = [parallel];
        let needsVerification = false;

        // Check if parallel seems unusual or low confidence
        const lowConfidencePatterns = [
            'prizm', 'refractor', 'chrome', 'shimmer', 'holo',
            'silver', 'gold', 'orange', 'green', 'blue', 'purple', 'red'
        ];
        
        const parallelLower = parallel.toLowerCase();
        const hasLowConfidencePattern = lowConfidencePatterns.some(p => 
            parallelLower.includes(p)
        );

        if (hasLowConfidencePattern) {
            parallelConfidence = 0.70;
            needsVerification = true;
            
            // Add similar parallel suggestions
            if (parallelLower.includes('silver')) {
                suggestions = [parallel, 'Silver', 'Silver Prizm', 'Hyper', 'Base'];
            } else if (parallelLower.includes('prizm')) {
                suggestions = [parallel, 'Silver Prizm', 'Prizm', 'Base'];
            } else if (parallelLower.includes('refractor')) {
                suggestions = [parallel, 'Refractor', 'Base Chrome', 'Base'];
            } else {
                suggestions = [parallel, 'Base'];
            }
        }

        // Return results WITHOUT saving
        res.json({
            success: true,
            card: result.card,
            confidence: result.confidence,
            parallelConfidence: parallelConfidence,
            needsVerification: needsVerification,
            suggestions: suggestions,
            usage: result.usage,
            message: 'Card analyzed! Please verify the details before adding to collection.'
        });

    } catch (error) {
        console.error('Analyze endpoint error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Analysis failed',
            message: 'AI analysis failed. Please try again.'
        });
    }
});

// NEW: Confirm and save verified card data
router.post('/confirm', authenticateToken, async (req, res) => {
    try {
        const { cardData, frontImage, backImage, userCorrected } = req.body;

        if (!cardData) {
            return res.status(400).json({ 
                success: false, 
                error: 'Card data is required' 
            });
        }

        console.log('💾 Saving verified card for user:', req.user.userId);
        console.log('User corrected:', userCorrected ? 'YES' : 'NO');

        // Upload images to Cloudinary
        const timestamp = Date.now();
        const cardId = `card_${timestamp}`;
        
        const frontUrl = await uploadImage(
            frontImage, 
            cardId,
            req.user.userId,
            'front'
        );
        const backUrl = backImage ? await uploadImage(
            backImage, 
            cardId,
            req.user.userId,
            'back'
        ) : null;

        // Add image URLs to card data
        cardData.front_image_url = frontUrl;
        cardData.back_image_url = backUrl;

        // Auto-fetch pricing (same logic as /scan)
        let priceData = null;
        let sportsCardsProData = null;

        try {
            const cardType = cardData.sport?.toLowerCase();
            console.log(`🔍 Fetching pricing for ${cardType} card...`);

            const searchQuery = cardData.ebay_search_string || 
                `${cardData.year} ${cardData.set_name} ${cardData.player}`;

            const cardDetails = {
                player: cardData.player,
                year: cardData.year,
                setName: cardData.set_name?.replace(/^\d{4}\s+/, ''),
                cardNumber: cardData.card_number,
                parallel: cardData.parallel,
                sport: cardData.sport
            };

            const priceResponse = await axios.post(
                `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/cards/quick-price-check`,
                { searchQuery, cardDetails },
                { 
                    headers: { 
                        'Authorization': req.headers.authorization,
                        'Content-Type': 'application/json' 
                    },
                    timeout: 10000
                }
            );

            const priceResult = priceResponse.data;

            if (priceResult.sportsCardsPro) {
                sportsCardsProData = priceResult.sportsCardsPro;
            }

            if (priceResult.success && priceResult.sales && priceResult.sales.length > 0) {
                const prices = priceResult.sales.map(s => s.price).filter(p => p > 0).sort((a, b) => a - b);

                if (prices.length > 0) {
                    const lowestBIN = prices[0];
                    const marketAvg = prices.reduce((sum, p) => sum + p, 0) / prices.length;
                    const highest = prices[prices.length - 1];

                    // 🔥 REMOVED: eBay auto-pricing - user fetches manually via Market Comps
                    priceData = {
                        ebay_avg: marketAvg,
                        ebay_low: lowestBIN,
                        ebay_high: highest,
                        ebay_sample_size: prices.length
                    };

                    // eBay fields intentionally NOT set on card - user uses CombinedMarketModal

                    if (sportsCardsProData) {
                        cardData.sportscardspro_raw = sportsCardsProData.raw;
                        cardData.sportscardspro_psa7 = sportsCardsProData.psa7;
                        cardData.sportscardspro_psa8 = sportsCardsProData.psa8;
                        cardData.sportscardspro_psa9 = sportsCardsProData.psa9;
                        cardData.sportscardspro_psa10 = sportsCardsProData.psa10;
                        cardData.sportscardspro_bgs10 = sportsCardsProData.bgs10;
                        cardData.sportscardspro_cgc10 = sportsCardsProData.cgc10;
                        cardData.sportscardspro_sgc10 = sportsCardsProData.sgc10;
                        cardData.sportscardspro_sales_volume = sportsCardsProData.salesVolume;
                    }

                    console.log(`✅ Priced: $${lowestBIN.toFixed(2)} - $${highest.toFixed(2)}`);
                }
            }
        } catch (priceError) {
            console.error('❌ Pricing failed:', priceError.message);
        }

        // Save to quick_checks table
        if (priceData || sportsCardsProData) {
            try {
                const valuesArray = [
                    req.user.userId,
                    cardData.player,
                    cardData.year,
                    cardData.set_name,
                    cardData.card_number,
                    cardData.parallel || 'Base',
                    cardData.team,
                    cardData.sport,
                    cardData.front_image_url,
                    parseFloat(priceData?.ebay_avg) || null,
                    parseFloat(priceData?.ebay_low) || null,
                    parseFloat(priceData?.ebay_high) || null,
                    parseInt(priceData?.ebay_sample_size) || 0,
                    parseFloat(sportsCardsProData?.raw) || null,
                    parseFloat(sportsCardsProData?.psa7) || null,
                    parseFloat(sportsCardsProData?.psa8) || null,
                    parseFloat(sportsCardsProData?.psa9) || null,
                    parseFloat(sportsCardsProData?.psa10) || null,
                    parseFloat(sportsCardsProData?.bgs10) || null,
                    parseFloat(sportsCardsProData?.cgc10) || null,
                    parseFloat(sportsCardsProData?.sgc10) || null,
                    parseInt(sportsCardsProData?.salesVolume) || null,
                    parseFloat(cardData.tcgplayer_market) || null,
                    parseFloat(cardData.tcgplayer_low) || null,
                    parseFloat(cardData.tcgplayer_mid) || null,
                    parseFloat(cardData.tcgplayer_high) || null,
                    parseInt(userCorrected ? 85 : 95),
                    'verified_scan'
                ];

                await db.query(`
                    INSERT INTO quick_checks (
                        user_id, player, year, set_name, card_number, parallel,
                        team, sport, thumbnail_url, 
                        ebay_avg, ebay_low, ebay_high, ebay_sample_size,
                        sportscardspro_raw, sportscardspro_psa7, sportscardspro_psa8,
                        sportscardspro_psa9, sportscardspro_psa10, sportscardspro_bgs10,
                        sportscardspro_cgc10, sportscardspro_sgc10, sportscardspro_sales_volume,
                        tcgplayer_market, tcgplayer_low, tcgplayer_mid, tcgplayer_high,
                        confidence_score, check_mode
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, valuesArray);

                console.log('✅ Quick check saved');
            } catch (dbError) {
                console.error('❌ Quick check save failed:', dbError);
            }
        }

        res.json({
            success: true,
            card: cardData,
            pricing: priceData,
            sportsCardsPro: sportsCardsProData,
            message: userCorrected 
                ? 'Card saved with your corrections!'
                : 'Card saved successfully!'
        });

    } catch (error) {
        console.error('Confirm endpoint error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to save card',
            message: 'Could not save card. Please try again.'
        });
    }
});

// DEMO scan - NO AUTH REQUIRED (for landing page) - LANDING SOURCE
router.post('/demo-scan', async (req, res) => {
    try {
        const { frontImage, backImage } = req.body;

        if (!frontImage) {
            return res.status(400).json({ 
                success: false, 
                error: 'Front image is required' 
            });
        }

        // CHECK DEMO SCAN LIMIT BEFORE PROCESSING
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        const today = new Date().toDateString();
        
        let limit = demoScanLimits.get(ip);
        
        if (!limit || limit.date !== today) {
            limit = { date: today, count: 0 };
            demoScanLimits.set(ip, limit);
        }
        
        if (limit.count >= 3) {
            console.log(`🚫 Demo scan limit reached for IP: ${ip}`);
            return res.status(429).json({
                success: false,
                error: 'DEMO_LIMIT_REACHED',
                message: 'You\'ve used all 3 free demo scans! Sign up to get 7 scans per month.',
                remaining: 0
            });
        }

        console.log(`✅ Demo scan allowed for IP: ${ip} (${limit.count}/3 used)`);

        // Call Claude Vision API
        const result = await claudeScanner.scanCard(frontImage, backImage);

        // Store processed images in result
        if (result.success && result.card) {
            // Upload to Cloudinary and get URLs for demo scans too
            const timestamp = Date.now();
            const cardId = `demo_${timestamp}`;
            
            // For demo scans, use 0 as userId to keep them separate
            const frontUrl = await uploadImage(
                result.processedFrontImage || frontImage, 
                cardId,
                0,  // demo user
                'front'
            );
            const backUrl = backImage ? await uploadImage(
                result.processedBackImage || backImage, 
                cardId,
                0,  // demo user
                'back'
            ) : null;
            
            result.card.front_image_url = frontUrl;
            result.card.back_image_url = backUrl;
        }

        // Track API usage with cost and tokens - LANDING SOURCE (user_id = NULL for demo)
        const scanTimestamp = new Date().toISOString();
        const dateOnly = scanTimestamp.split('T')[0];
        
        try {
            // Calculate cost from token usage
            const apiCost = result.usage ? calculateCost(result.usage) : 0;
            const tokenCount = result.usage ? result.usage.total_tokens : 0;
            const imageCount = backImage ? 2 : 1;
            
            // Store card data WITH IMAGE URLS for admin viewing
            const cardDataWithImages = result.card ? {
                ...result.card,
                // Add the Cloudinary URLs so admin can see images
                front_image: result.card.front_image_url,
                back_image: result.card.back_image_url
            } : null;
            
            // Store each demo scan individually
            await db.query(`
                INSERT INTO api_usage (
                    user_id, 
                    api_name, 
                    call_date, 
                    call_count,
                    api_cost,
                    token_count,
                    scan_source,
                    image_count,
                    scan_timestamp,
                    card_data
                )
                VALUES (NULL, ?, ?, 1, ?, ?, 'landing', ?, ?, ?)
            `, [
                result.success ? 'claude_scan' : 'claude_scan_failed',
                dateOnly,
                apiCost,
                tokenCount,
                imageCount,
                scanTimestamp,
                cardDataWithImages ? JSON.stringify(cardDataWithImages) : null
            ]);
            
            console.log(`✅ Landing scan tracked: $${apiCost.toFixed(4)}, ${tokenCount} tokens, ${imageCount} image(s)`);
        } catch (usageError) {
            console.error('Failed to track demo API usage:', usageError);
            // Don't fail the request if usage tracking fails
        }

        if (!result.success) {
            return res.json({
                success: false,
                error: result.error,
                card: result.card,
                message: 'AI scan failed. Please try the example card.'
            });
        }

        // INCREMENT DEMO LIMIT ONLY ON SUCCESS
        limit.count += 1;
        demoScanLimits.set(ip, limit);
        console.log(`📊 Demo scan count for IP ${ip}: ${limit.count}/3`);

        res.json({
            success: true,
            card: result.card,
            confidence: result.confidence,
            message: 'Card scanned successfully!'
        });

    } catch (error) {
        console.error('Demo scanner error:', error);
        
        // Track failed demo scan without images
        try {
            const scanTimestamp = new Date().toISOString();
            const dateOnly = scanTimestamp.split('T')[0];
            const imageCount = req.body.backImage ? 2 : 1;
            
            // Store error data without images
            const failedScanData = {
                error: error.message
            };
            
            await db.query(`
                INSERT INTO api_usage (
                    user_id, 
                    api_name, 
                    call_date, 
                    call_count,
                    api_cost,
                    token_count,
                    scan_source,
                    image_count,
                    scan_timestamp,
                    card_data
                )
                VALUES (NULL, 'claude_scan_failed', ?, 1, 0, 0, 'landing', ?, ?, ?)
            `, [dateOnly, imageCount, scanTimestamp, JSON.stringify(failedScanData)]);
        } catch (usageError) {
            console.error('Failed to track failed demo scan:', usageError);
        }
        
        res.status(500).json({ 
            success: false, 
            error: 'Scan failed',
            message: 'AI scan failed. Please try the example card.'
        });
    }
});

// Helper function to calculate API cost based on Claude pricing
function calculateCost(usage) {
    // Claude 3.5 Sonnet pricing (as of Oct 2024):
    // Input: $3 per million tokens
    // Output: $15 per million tokens
    
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    
    const inputCost = (inputTokens / 1000000) * 3.0;
    const outputCost = (outputTokens / 1000000) * 15.0;
    
    return inputCost + outputCost;
}

// Get pricing for a card (NO AUTH - for landing page)
router.post('/price', async (req, res) => {
    try {
        const { player, year, set_name, card_number, parallel, grading_company, grade, sport } = req.body;

        console.log('Pricing request for landing page:', { player, year, set_name, card_number });

        // Build eBay search query
        const cleanSetName = set_name ? set_name.replace(/^\d{4}\s+/, '') : '';
        
        let query = `${year} ${cleanSetName} ${player}`;
        if (card_number) query += ` #${card_number}`;
        
        // Add grading info if present
        if (grading_company && grade) {
            query += ` ${grading_company} ${grade}`;
        } else if (parallel && parallel !== 'Base') {
            const cleanParallel = parallel.replace(/[-\/]/g, ' ');
            query += ` ${cleanParallel}`;
        }

        console.log('eBay search query:', query);

        // For now, return mock data since we need the eBay service
        // TODO: Replace with actual eBay API call when ebayService is available
        const mockPricing = {
            pricing: {
                ebay_avg: 125.50,
                ebay_low: 75.00,
                ebay_high: 225.00,
                ebay_sample_size: 18
            },
            analytics: {
                periods: {
                    days30: { count: 5, avg: 125.50, low: 95.00, high: 175.00 },
                    days60: { count: 9, avg: 118.75, low: 85.00, high: 185.00 },
                    days90: { count: 18, avg: 125.50, low: 75.00, high: 225.00 },
                    months6: { count: 42, avg: 130.20, low: 70.00, high: 250.00 },
                    year: { count: 95, avg: 135.80, low: 65.00, high: 275.00 }
                }
            },
            currentListings: [
                {
                    title: `${year} ${set_name} ${player} #${card_number}${grading_company ? ` ${grading_company} ${grade}` : ''}`,
                    price: 149.99,
                    seller: 'pristinecards',
                    shippingCost: 0,
                    condition: 'New',
                    url: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}`
                }
            ],
            stats: {
                careerPoints: 4742,
                careerGames: 439,
                pointsPerGame: 10.8,
                assistsPerGame: 3.5,
                teams: ['Team 1', 'Team 2'],
                seasons: '1985-1992',
                note: `Stats for ${player} will be loaded when you sign up for full access.`
            }
        };

        res.json({
            success: true,
            ...mockPricing
        });

    } catch (error) {
        console.error('Pricing endpoint error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get pricing'
        });
    }
});

// Cleanup old IP records daily
setInterval(() => {
    const today = new Date().toDateString();
    let cleaned = 0;
    for (const [ip, data] of demoScanLimits.entries()) {
        if (data.date !== today) {
            demoScanLimits.delete(ip);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`🧹 Cleaned up ${cleaned} old IP rate limits`);
    }
}, 24 * 60 * 60 * 1000); // Run daily

// Export router and demoScanLimits for admin access
module.exports = router;
module.exports.demoScanLimits = demoScanLimits;