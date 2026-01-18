const express = require('express');
const router = express.Router();
const ebayService = require('../services/ebay-oauth');
const db = require('../database/db');
const { getRateLimitMiddleware, incrementUsage } = require('../middleware/rate-limiter');
const { authenticateToken } = require('../middleware/auth');
const { getUserEbayToken } = require('./ebayAuth');
const axios = require('axios');
const { generateLotCollages } = require('../services/collageService');

router.post('/price-card', authenticateToken, getRateLimitMiddleware(100), async (req, res) => {
    try {
        const { cardId, player, year, set_name, card_number, parallel, grading_company, grade, sport } = req.body;

        const cleanSetName = set_name.replace(/^\d{4}\s+/, '');
        
        // POKEMON PIPELINE: Prioritize Name + Card Number 
        const isPokemon = sport === 'Pokemon' || (set_name && set_name.toLowerCase().includes('pokemon'));
        
        let query;
        if (isPokemon) {
            // Pokemon: ONLY use Pokemon Name + Card Number (most reliable)
            query = player; // Pokemon name
            if (card_number) {
                query += ` ${card_number}`; // Card number like "006/165"
            }
            // Optionally add grading (but DON'T add set/year - they're often wrong)
            if (grading_company) query += ` ${grading_company} ${grade}`;
        } else {
            // Sports cards: Use existing logic
            query = `${year} ${cleanSetName} ${player}`;
            if (card_number) query += ` ${card_number}`;
            if (parallel && parallel !== 'Base') {
                const cleanParallel = parallel.replace(/[-\/]/g, ' ');
                query += ` ${cleanParallel}`;
            }
            if (grading_company) query += ` ${grading_company} ${grade}`;
        }

        console.log('🔍 Price request for:', query);

        const result = await ebayService.getSoldPrices(query);
        
        console.log('📊 eBay Result:', result);
        
        // Track API usage
        if (req.user) {
            incrementUsage(req.user.userId, 'ebay');
        }

        // Return data in the format frontend expects
        if (result.found && result.prices) {
            // UPDATE DATABASE if cardId provided
            if (cardId) {
                try {
                    db.prepare(`
                        UPDATE cards 
                        SET ebay_low = ?,
                            ebay_avg = ?,
                            ebay_high = ?,
                            ebay_sample_size = ?,
                            ebay_last_checked = CURRENT_TIMESTAMP
                        WHERE id = ? AND user_id = ?
                    `).run(
                        result.prices.low,
                        result.prices.average,
                        result.prices.high,
                        result.count,
                        cardId,
                        req.user.userId
                    );
                    console.log('✅ Updated card prices in database');
                } catch (dbError) {
                    console.error('❌ Database update failed:', dbError);
                }
            }
            
            res.json({
                success: true,
                pricing: {
                    ebay_low: parseFloat(result.prices.low),
                    ebay_avg: parseFloat(result.prices.average),
                    ebay_high: parseFloat(result.prices.high),
                    ebay_sample_size: result.count
                },
                query: query
            });
        } else {
            res.json({
                success: false,
                message: result.message || 'No sold listings found',
                query: query
            });
        }
    } catch (error) {
        console.error('Price card error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Generate listing preview
router.post('/preview-listing', authenticateToken, async (req, res) => {
    try {
        const { cardId } = req.body;
        
        const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
        
        if (!card) {
            return res.status(404).json({ success: false, error: 'Card not found' });
        }
        
        const cleanSetName = card.set_name.replace(/^\d{4}\s+/, '');
        
        const preview = {
            title: `${card.year} ${cleanSetName} ${card.player} #${card.card_number}`,
            suggestedPrice: card.ebay_avg ? (card.ebay_avg * 1.15).toFixed(2) : '9.99',
            marketAverage: card.ebay_avg?.toFixed(2) || 'N/A',
            recentSales: card.ebay_sample_size || 0,
            profitEstimate: card.ebay_avg ? (card.ebay_avg * 0.15).toFixed(2) : '0.00',
            images: [card.front_image_url, card.back_image_url].filter(Boolean)
        };
        
        res.json({ success: true, preview });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/recent-sales/:cardId', authenticateToken, async (req, res) => {
    try {
        const { cardId } = req.params;
        
        // Get card from database
        const cardResult = await db.query(
            'SELECT * FROM cards WHERE id = $1 AND user_id = $2',
            [cardId, req.user.userId]
        );
        
        if (cardResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Card not found' });
        }
        
        const card = cardResult.rows[0];
        
        const cleanSetName = card.set_name.replace(/^\d{4}\s+/, '');
        let searchQuery = `${card.year} ${cleanSetName} ${card.player}`;
        if (card.card_number) searchQuery += ` #${card.card_number}`;
        if (card.parallel && card.parallel !== 'Base') searchQuery += ` ${card.parallel}`;
        if (card.grading_company) searchQuery += ` ${card.grading_company} ${card.grade}`;
        
        console.log('🔍 Fetching recent sales for:', searchQuery);
        
        const soldListings = await ebayService.getRecentSoldListings(searchQuery);
        
        console.log(`✅ Found ${soldListings.length} sold listings`);
        
        const prices = soldListings.map(item => item.price).filter(p => p > 0);
        const estimate = {
            low: prices.length > 0 ? Math.min(...prices).toFixed(2) : '0.00',
            avg: prices.length > 0 ? (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2) : '0.00',
            high: prices.length > 0 ? Math.max(...prices).toFixed(2) : '0.00'
        };
        
        // Update card prices in database if we found sales
        if (prices.length > 0) {
            await db.query(
                `UPDATE cards 
                SET ebay_low = $1, ebay_avg = $2, ebay_high = $3, ebay_sample_size = $4, ebay_last_checked = NOW() 
                WHERE id = $5`,
                [estimate.low, estimate.avg, estimate.high, prices.length, cardId]
            );
            console.log('✅ Updated card prices in database');
        }
        
        // Track API usage
        if (req.user) {
            incrementUsage(req.user.userId, 'ebay');
        }
        
        res.json({
            success: true,
            estimate,
            totalSales: soldListings.length,
            sales: soldListings,
            searchQuery
        });
        
    } catch (error) {
        console.error('❌ Error fetching recent sales:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch recent sales' });
    }
});

// Get CURRENT active listings (not sold) - WITH FALLBACK SEARCH
router.get('/current-listings/:cardId', authenticateToken, async (req, res) => {
    try {
        const { cardId } = req.params;
        
        const cardResult = await db.query(
            'SELECT * FROM cards WHERE id = $1 AND user_id = $2',
            [cardId, req.user.userId]
        );
        
        if (cardResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Card not found' });
        }
        
        const card = cardResult.rows[0];
        
        // ✅ CHECK AND INCREMENT EBAY USAGE
        const tierLimits = {
  free: { batch: 10, monthly: 50 },
  power: { batch: 25, monthly: 150 },
  dealer: { batch: 100, monthly: 999999 },
  // Legacy tiers get unlimited
  starter: { batch: 100, monthly: 999999 },
  pro: { batch: 100, monthly: 999999 },
  premium: { batch: 100, monthly: 999999 }
};
        
        const userTier = req.user.subscriptionTier || 'free';
        const monthlyLimit = tierLimits[userTier];
        
        // Get current usage
        const usageResult = await db.query(
            'SELECT ebay_pricing_usage, usage_reset_date FROM users WHERE id = $1',
            [req.user.userId]
        );
        
        if (usageResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }
        
        let { ebay_pricing_usage, usage_reset_date } = usageResult.rows[0];
        
        // Reset counter if new month
        const now = new Date();
        const resetDate = new Date(usage_reset_date);
        if (!usage_reset_date || now > resetDate) {
            const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
            await db.query(
                'UPDATE users SET ebay_pricing_usage = 0, usage_reset_date = $1 WHERE id = $2',
                [nextReset, req.user.userId]
            );
            ebay_pricing_usage = 0;
        }
        
        // Check if limit exceeded
        if (ebay_pricing_usage >= monthlyLimit) {
            return res.status(429).json({
                success: false,
                error: `Monthly eBay pricing limit reached (${monthlyLimit} lookups)`,
                usage: ebay_pricing_usage,
                limit: monthlyLimit
            });
        }
        
        // Increment usage BEFORE making the API call
        await db.query(
            'UPDATE users SET ebay_pricing_usage = ebay_pricing_usage + 1 WHERE id = $1',
            [req.user.userId]
        );
        
        console.log(`✅ eBay pricing usage: ${ebay_pricing_usage + 1}/${monthlyLimit}`);
        
        // Build search query
        const cleanSetName = card.set_name.replace(/^\d{4}\s+/, '');
        let searchQuery = `${card.year} ${cleanSetName} ${card.player}`;
        if (card.card_number) searchQuery += ` #${card.card_number}`;
        if (card.parallel && card.parallel !== 'Base') searchQuery += ` ${card.parallel}`;
        if (card.grading_company) searchQuery += ` ${card.grading_company} ${card.grade}`;
        
        console.log('🔍 Fetching CURRENT listings for:', searchQuery);
        
        // NEW: Pass card details for fallback search
        const cardDetails = {
            player: card.player,
            year: card.year,
            setName: cleanSetName,
            cardNumber: card.card_number,
            parallel: card.parallel,
            gradingCompany: card.grading_company,
            grade: card.grade,
            isGraded: !!card.grading_company,
            sport: card.sport // ADD THIS LINE
        };
        
        // Call eBay service with card details for fallback
        const result = await ebayService.getCurrentListings(searchQuery, cardDetails);
        
        // Extract listings and metadata
        const currentListings = result.listings || [];
        const searchMetadata = result.searchMetadata || {};
        
        console.log(`✅ Found ${currentListings.length} current listings using ${searchMetadata.searchType} search`);
        
        if (searchMetadata.fallbackUsed) {
            console.log(`⚠️ Fallback used: ${searchMetadata.disclaimer}`);
        }
        
        const prices = currentListings.map(item => item.price).filter(p => p > 0);
        const estimate = {
            low: prices.length > 0 ? Math.min(...prices).toFixed(2) : '0.00',
            avg: prices.length > 0 ? (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2) : '0.00',
            high: prices.length > 0 ? Math.max(...prices).toFixed(2) : '0.00'
        };
        
        // Track API usage
        if (req.user) {
            incrementUsage(req.user.userId, 'ebay');
        }
        
        res.json({
            success: true,
            estimate,
            totalListings: currentListings.length,
            listings: currentListings,
            searchQuery: searchMetadata.usedQuery || searchQuery,
            originalQuery: searchQuery,
            searchMetadata // NEW: Include metadata for frontend
        });
        
    } catch (error) {
        console.error('❌ Error fetching current listings:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch current listings' });
    }
});
// Grading Analysis - Compare Raw vs PSA 8/9/10 values WITH CACHING
router.get('/grading-analysis/:cardId', authenticateToken, async (req, res) => {
    try {
        const { cardId } = req.params;
        const forceRefresh = req.query.refresh === 'true';
        
        console.log('💎 Starting grading analysis for card:', cardId);
        
        // Get card from database
        const cardResult = await db.query(
            'SELECT * FROM cards WHERE id = $1 AND user_id = $2',
            [cardId, req.user.userId]
        );
        
        if (cardResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Card not found' });
        }
        
        const card = cardResult.rows[0];
        
        // Build base search query (without grading)
        const cleanSetName = card.set_name.replace(/^\d{4}\s+/, '');
        let baseQuery = `${card.year} ${cleanSetName} ${card.player}`;
        if (card.card_number) baseQuery += ` #${card.card_number}`;
        
        // ALWAYS include parallel for accuracy (unless it's Base)
        if (card.parallel && card.parallel !== 'Base') {
            baseQuery += ` ${card.parallel}`;
        }
        
        // If numbered card, include the print run for specificity
        if (card.numbered_to) {
            baseQuery += ` /${card.numbered_to}`;
        }
        
        console.log('🔍 Base query (specific):', baseQuery);
        
        // Also try broader query if specific returns too few results
        let broadQuery = `${card.year} ${cleanSetName} ${card.player}`;
        if (card.card_number) broadQuery += ` #${card.card_number}`;
        console.log('🔍 Broad query (fallback):', broadQuery);
        
        // CACHE KEY
        const cacheKey = `grading_${cardId}_${baseQuery}`;
        
        // CHECK CACHE FIRST (unless force refresh)
        if (!forceRefresh) {
            const cached = await db.query(
                'SELECT results FROM ebay_cache WHERE search_query = $1 AND expires_at > NOW()',
                [cacheKey]
            );
            
            if (cached.rows.length > 0) {
                console.log('✅ Using cached grading analysis');
                return res.json({
                    success: true,
                    analysis: JSON.parse(cached.rows[0].results),
                    cached: true
                });
            }
        }
        
        console.log('🔄 No cache found, fetching from eBay...');
        
        // Helper: Get listings with cache
        const getCachedListings = async (query, limit, grade = null) => {
            const searchCacheKey = `search_${query}_${grade || 'raw'}_${limit}`;
            
            // Check cache
            if (!forceRefresh) {
                const cached = await db.query(
                    'SELECT results FROM ebay_cache WHERE search_query = $1 AND expires_at > NOW()',
                    [searchCacheKey]
                );
                
                if (cached.rows.length > 0) {
                    console.log(`✅ Using cached listings for ${grade || 'raw'}`);
                    return JSON.parse(cached.rows[0].results);
                }
            }
            
            // Fetch from eBay
            console.log(`📊 Fetching ${limit} ${grade || 'raw'} listings from eBay...`);
            const listings = await ebayService.getRecentSoldListings(query);
            const limitedListings = listings.slice(0, limit);
            
            // Cache results (24 hour expiry)
            await db.query(
                `INSERT INTO ebay_cache (search_query, results, expires_at) 
                 VALUES ($1, $2, NOW() + INTERVAL '24 hours')
                 ON CONFLICT (search_query) DO UPDATE SET results = $2, expires_at = NOW() + INTERVAL '24 hours'`,
                [searchCacheKey, JSON.stringify(limitedListings)]
            );
            
            return limitedListings;
        };
        
        // Search for RAW (ungraded) prices - LIMIT TO 20
        console.log('📊 Fetching RAW card prices (specific search)...');
        let rawListings = await getCachedListings(baseQuery, 20);
        
        // If too few results, try broader search
        if (rawListings.length < 3) {
            console.log('⚠️ Only found', rawListings.length, 'specific results. Trying broader search...');
            rawListings = await getCachedListings(broadQuery, 20);
            console.log('✅ Found', rawListings.length, 'results with broader search');
        } else {
            console.log('✅ Found', rawListings.length, 'results with specific search');
        }
        
        const rawPrices = rawListings
            .map(item => item.price)
            .filter(p => p > 0 && p < 1000); // Filter obvious outliers
        
        // Remove outliers using IQR method
        const removeOutliers = (prices) => {
            if (prices.length < 4) return prices;
            
            const sorted = [...prices].sort((a, b) => a - b);
            const q1 = sorted[Math.floor(sorted.length * 0.25)];
            const q3 = sorted[Math.floor(sorted.length * 0.75)];
            const iqr = q3 - q1;
            const lowerBound = q1 - (1.5 * iqr);
            const upperBound = q3 + (1.5 * iqr);
            
            return prices.filter(p => p >= lowerBound && p <= upperBound);
        };
        
        const cleanRawPrices = removeOutliers(rawPrices);
        
        const rawValue = {
            avg: cleanRawPrices.length > 0 
                ? cleanRawPrices.reduce((a, b) => a + b, 0) / cleanRawPrices.length 
                : 0,
            low: cleanRawPrices.length > 0 ? Math.min(...cleanRawPrices) : 0,
            high: cleanRawPrices.length > 0 ? Math.max(...cleanRawPrices) : 0,
            sampleSize: cleanRawPrices.length
        };
        
        console.log('✅ Raw value:', rawValue);
        
        // Search for PSA 10, 9, 8 prices - LIMIT TO 10 EACH
        const grades = ['PSA 10', 'PSA 9', 'PSA 8'];
        const gradedValues = {};
        
        for (const grade of grades) {
            console.log(`📊 Fetching ${grade} prices (specific search)...`);
            const gradeQuery = `${baseQuery} ${grade}`;
            let gradeListings = await getCachedListings(gradeQuery, 10, grade);
            
            // If too few results, try broader search
            if (gradeListings.length < 3) {
                console.log(`⚠️ Only found ${gradeListings.length} specific ${grade} results. Trying broader...`);
                const broadGradeQuery = `${broadQuery} ${grade}`;
                gradeListings = await getCachedListings(broadGradeQuery, 10, grade);
                console.log(`✅ Found ${gradeListings.length} ${grade} results with broader search`);
            } else {
                console.log(`✅ Found ${gradeListings.length} specific ${grade} results`);
            }
            
            const gradePrices = gradeListings
                .map(item => item.price)
                .filter(p => p > 0 && p < 5000); // Higher ceiling for graded
            
            const cleanGradePrices = removeOutliers(gradePrices);
            
            const gradingCost = 25; // PSA standard grading cost
            
            gradedValues[grade] = {
                avg: cleanGradePrices.length > 0 
                    ? cleanGradePrices.reduce((a, b) => a + b, 0) / cleanGradePrices.length 
                    : 0,
                low: cleanGradePrices.length > 0 ? Math.min(...cleanGradePrices) : 0,
                high: cleanGradePrices.length > 0 ? Math.max(...cleanGradePrices) : 0,
                sampleSize: cleanGradePrices.length,
                gradingCost: gradingCost,
                profit: cleanGradePrices.length > 0 
                    ? (cleanGradePrices.reduce((a, b) => a + b, 0) / cleanGradePrices.length) - rawValue.avg - gradingCost
                    : -gradingCost,
                roi: rawValue.avg > 0 && cleanGradePrices.length > 0
                    ? (((cleanGradePrices.reduce((a, b) => a + b, 0) / cleanGradePrices.length) - rawValue.avg - gradingCost) / rawValue.avg) * 100
                    : 0
            };
            
            console.log(`✅ ${grade}:`, gradedValues[grade]);
        }
        
        // Determine best grade and recommendation
        const profitableGrades = Object.entries(gradedValues)
            .filter(([_, data]) => data.profit > 0)
            .sort((a, b) => b[1].profit - a[1].profit);
        
        const bestGrade = profitableGrades.length > 0 ? profitableGrades[0][0] : null;
        const bestProfit = profitableGrades.length > 0 ? profitableGrades[0][1].profit : 0;
        
        let recommendation = 'DONT_GRADE';
        let recommendationText = "Don't grade. The potential profit doesn't justify the grading cost.";
        
        if (bestProfit > 50) {
            recommendation = 'GRADE';
            recommendationText = `Strong grading candidate! ${bestGrade} could net you $${bestProfit.toFixed(2)} profit.`;
        } else if (bestProfit > 20) {
            recommendation = 'CONSIDER';
            recommendationText = `Consider grading if confident in ${bestGrade}. Potential profit: $${bestProfit.toFixed(2)}.`;
        }
        
        console.log('🎯 Recommendation:', recommendation);
        
        const analysis = {
            rawValue,
            grades: gradedValues,
            bestGrade,
            recommendation,
            recommendationText,
            psaSubmitUrl: 'https://www.psacard.com/submissions'
        };
        
        // CACHE THE FINAL ANALYSIS (24 hours)
        await db.query(
            `INSERT INTO ebay_cache (search_query, results, expires_at) 
             VALUES ($1, $2, NOW() + INTERVAL '24 hours')
             ON CONFLICT (search_query) DO UPDATE SET results = $2, expires_at = NOW() + INTERVAL '24 hours'`,
            [cacheKey, JSON.stringify(analysis)]
        );
        
        res.json({
            success: true,
            analysis,
            cached: false
        });
        
    } catch (error) {
        console.error('❌ Grading analysis error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to analyze grading potential',
            details: error.message 
        });
    }
});

// Get SOLD listings
router.get('/sold-comps/:cardId', authenticateToken, async (req, res) => {
    try {
        const { cardId } = req.params;
        
        const cardResult = await db.query(
            'SELECT * FROM cards WHERE id = $1 AND user_id = $2',
            [cardId, req.user.userId]
        );
        
        if (cardResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Card not found' });
        }
        
        const card = cardResult.rows[0];
        
        const cleanSetName = card.set_name.replace(/^\d{4}\s+/, '');
        let searchQuery = `${card.year} ${cleanSetName} ${card.player}`;
        if (card.card_number) searchQuery += ` #${card.card_number}`;
        if (card.parallel && card.parallel !== 'Base') searchQuery += ` ${card.parallel}`;
        if (card.grading_company) searchQuery += ` ${card.grading_company} ${card.grade}`;
        
        console.log('🔍 Fetching SOLD listings for:', searchQuery);
        
        // NEW: Pass card details for fallback search
        const cardDetails = {
            player: card.player,
            year: card.year,
            setName: cleanSetName,
            cardNumber: card.card_number,
            parallel: card.parallel,
            gradingCompany: card.grading_company,
            grade: card.grade,
            isGraded: !!card.grading_company,
            sport: card.sport // ADD THIS LINE
        };
        
        // Call the NEW method with smart matching
        const result = await ebayService.getSoldListings(searchQuery, cardDetails);
        
        // Extract listings and metadata
        const soldListings = result.listings || [];
        const searchMetadata = result.searchMetadata || {};
        
        console.log(`✅ Found ${soldListings.length} sold comps using ${searchMetadata.searchType} search`);
        
        if (searchMetadata.fallbackUsed) {
            console.log(`⚠️ Fallback used: ${searchMetadata.disclaimer}`);
        }
        
        res.json({
            success: true,
            sales: soldListings,  // ← Frontend expects "sales"
            grouped: result.grouped,
            stats: result.stats,
            searchQuery: searchMetadata.usedQuery || searchQuery,
            originalQuery: searchQuery,
            searchMetadata
        });
        
    } catch (error) {
        console.error('❌ Error fetching sold comps:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch sold comps' });
    }
});

// Get parallel pricing for a card
router.get('/parallel-pricing/:cardId', authenticateToken, async (req, res) => {
  try {
    const { cardId } = req.params;
    const forceRefresh = req.query.refresh === 'true';
    
    console.log('📊 Fetching parallel pricing for card:', cardId);
    
    // Get card from database
    const cardResult = await db.query(
      'SELECT * FROM cards WHERE id = $1 AND user_id = $2',
      [cardId, req.user.userId]
    );
    
    if (cardResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Card not found' });
    }
    
    const card = cardResult.rows[0];
    
    // Build base query (without parallel or grade)
    const cleanSetName = card.set_name.replace(/^\d{4}\s+/, '');
    let baseQuery = `${card.year} ${cleanSetName} ${card.player}`;
    if (card.card_number) baseQuery += ` #${card.card_number}`;
    
    console.log('🔍 Base query:', baseQuery);
    
    // Check cache first (unless force refresh)
    const cacheKey = `parallel_${cardId}_${baseQuery}`;
    
    if (!forceRefresh) {
      const cached = await db.query(
        'SELECT * FROM parallel_prices WHERE set_name = $1 AND year = $2 AND player_name = $3 AND card_number = $4 AND expires_at > NOW()',
        [card.set_name, card.year, card.player, card.card_number]
      );
      
      if (cached.rows.length > 0) {
        console.log('✅ Using cached parallel pricing');
        
        // Transform cached data to match frontend format
        const formattedParallels = cached.rows.map(row => ({
          parallel: row.parallel_name,
          grades: {
            'Raw': row.raw_avg ? {
              avg: parseFloat(row.raw_avg),
              low: parseFloat(row.raw_avg) * 0.8,
              high: parseFloat(row.raw_avg) * 1.2,
              sampleSize: row.raw_sample_size || 0
            } : null,
            'PSA 8': row.psa_8_avg ? {
              avg: parseFloat(row.psa_8_avg),
              low: parseFloat(row.psa_8_avg) * 0.8,
              high: parseFloat(row.psa_8_avg) * 1.2,
              sampleSize: row.psa_8_sample_size || 0
            } : null,
            'PSA 9': row.psa_9_avg ? {
              avg: parseFloat(row.psa_9_avg),
              low: parseFloat(row.psa_9_avg) * 0.8,
              high: parseFloat(row.psa_9_avg) * 1.2,
              sampleSize: row.psa_9_sample_size || 0
            } : null,
            'PSA 10': row.psa_10_avg ? {
              avg: parseFloat(row.psa_10_avg),
              low: parseFloat(row.psa_10_avg) * 0.8,
              high: parseFloat(row.psa_10_avg) * 1.2,
              sampleSize: row.psa_10_sample_size || 0
            } : null
          }
        })).filter(p => Object.values(p.grades).some(g => g !== null));
        
        return res.json({
          success: true,
          parallels: formattedParallels,
          cached: true
        });
      }
    }
    
    console.log('🔄 No cache found, fetching from eBay...');
    
    // List of common parallels to search (you can expand this)
    const parallelsToSearch = [
      'Base',
      'Silver Prizm',
      'Green Prizm',
      'Orange Prizm',
      'Gold Prizm',
      'Red Prizm',
      'Black Prizm'
    ];
    
    const results = [];
    
    for (const parallel of parallelsToSearch) {
      try {
        const searchQuery = parallel === 'Base' 
          ? baseQuery 
          : `${baseQuery} ${parallel}`;
        
        console.log(`📊 Checking ${parallel}...`);
        
        // Search for Raw, PSA 8, 9, 10
        const grades = ['Raw', 'PSA 8', 'PSA 9', 'PSA 10'];
        const gradeData = {};
        
        for (const grade of grades) {
          const gradeQuery = grade === 'Raw' 
            ? searchQuery 
            : `${searchQuery} ${grade}`;
          
          const priceData = await ebayService.getSoldPrices(gradeQuery);
          
          if (priceData.found && priceData.count >= 3) {
            gradeData[grade] = {
              avg: parseFloat(priceData.prices.average),
              low: parseFloat(priceData.prices.low),
              high: parseFloat(priceData.prices.high),
              sampleSize: priceData.count
            };
          }
          
          // Rate limiting
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        // Only add if we found data
        if (Object.keys(gradeData).length > 0) {
          results.push({
            parallel: parallel,
            grades: gradeData
          });
          
          // Cache this parallel's pricing (7 days)
          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + 7);
          
          await db.query(`
            INSERT INTO parallel_prices (
              set_name, year, sport, player_name, card_number, parallel_name,
              raw_avg, raw_sample_size,
              psa_8_avg, psa_8_sample_size,
              psa_9_avg, psa_9_sample_size,
              psa_10_avg, psa_10_sample_size,
              expires_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            ON CONFLICT (set_name, year, sport, player_name, card_number, parallel_name)
            DO UPDATE SET
              raw_avg = $7, raw_sample_size = $8,
              psa_8_avg = $9, psa_8_sample_size = $10,
              psa_9_avg = $11, psa_9_sample_size = $12,
              psa_10_avg = $13, psa_10_sample_size = $14,
              expires_at = $15,
              last_checked = NOW()
          `, [
            card.set_name, card.year, card.sport, card.player, card.card_number, parallel,
            gradeData['Raw']?.avg, gradeData['Raw']?.sampleSize,
            gradeData['PSA 8']?.avg, gradeData['PSA 8']?.sampleSize,
            gradeData['PSA 9']?.avg, gradeData['PSA 9']?.sampleSize,
            gradeData['PSA 10']?.avg, gradeData['PSA 10']?.sampleSize,
            expiresAt
          ]);
        }
        
      } catch (error) {
        console.error(`❌ Error fetching ${parallel}:`, error.message);
      }
    }
    
    console.log(`✅ Found pricing for ${results.length} parallels`);
    
    res.json({
      success: true,
      parallels: results,
      cached: false
    });
    
  } catch (error) {
    console.error('❌ Parallel pricing error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch parallel pricing' 
    });
  }
});

// ═══════════════════════════════════════════════════════
// 🔥 EBAY SELLER INTEGRATION - List Cards on eBay
// ═══════════════════════════════════════════════════════

// Connect eBay Seller Account (OAuth)
router.get('/connect-seller', authenticateToken, (req, res) => {
  try {
    const scopes = [
      'https://api.ebay.com/oauth/api_scope/sell.inventory',
      'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
      'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
      'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
      'https://api.ebay.com/oauth/api_scope/sell.account',
      'https://api.ebay.com/oauth/api_scope/sell.account.readonly'
    ].join(' ');
    const redirectUri = process.env.EBAY_SELLER_REDIRECT_URI || 
      `${process.env.FRONTEND_URL || 'https://slabtrack.vercel.app'}/ebay-callback`;

    // Use specific RuName based on environment
    const ruName = process.env.NODE_ENV === 'staging' 
      ? 'sherwin_gilani-sherwing-RHKCzV-yfaglwv'  // Staging RuName
      : 'sherwin_gilani-sherwing-RHKCzV-kofyl';   // Production RuName
    
    const authUrl = `https://auth.ebay.com/oauth2/authorize?` +
      `client_id=${process.env.EBAY_APP_ID}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&state=${req.user.userId}` +
      `&runame=${ruName}`;

    console.log('🔗 eBay Seller OAuth URL generated for user:', req.user.userId);

    res.json({ 
      success: true, 
      authUrl 
    });

  } catch (error) {
    console.error('❌ eBay connect-seller error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to generate eBay auth URL' 
    });
  }
});

// eBay Seller OAuth Callback
// eBay Seller OAuth Callback - REDIRECT VERSION
router.get('/seller-callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;

    // Handle OAuth errors
    if (error) {
      console.log('❌ eBay OAuth error:', error);
      return res.redirect(`${process.env.FRONTEND_URL}/settings?ebay=error&message=${encodeURIComponent('Authorization failed')}`);
    }

    const userId = parseInt(state);

    if (!code || !userId) {
      console.log('❌ Missing code or userId');
      return res.redirect(`${process.env.FRONTEND_URL}/settings?ebay=error&message=${encodeURIComponent('Missing parameters')}`);
    }

    console.log('🔐 Processing eBay seller callback for user:', userId);

    const redirectUri = process.env.EBAY_SELLER_REDIRECT_URI || 
      `${process.env.FRONTEND_URL || 'https://slabtrack.vercel.app'}/ebay-callback`;

    // Exchange code for access token
    const axios = require('axios');
    const tokenResponse = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${Buffer.from(
            `${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`
          ).toString('base64')}`
        }
      }
    );

    const { access_token, refresh_token } = tokenResponse.data;

    // Store tokens in database
    await db.query(`
      UPDATE users 
      SET ebay_seller_token = $1,
          ebay_seller_refresh_token = $2,
          ebay_seller_connected = true,
          ebay_seller_connected_at = NOW()
      WHERE id = $3
    `, [access_token, refresh_token, userId]);

    console.log('✅ eBay seller account connected for user:', userId);

    // Log the connection (skip card_id to avoid foreign key error)
    console.log('✅ eBay connected, skipping log entry');

    // Redirect back to settings with success message
    res.redirect(`${process.env.FRONTEND_URL}/settings?ebay=success`);

  } catch (error) {
    console.error('❌ eBay seller callback error:', error.response?.data || error.message);
    res.redirect(`${process.env.FRONTEND_URL}/settings?ebay=error&message=${encodeURIComponent('Failed to connect')}`);
  }
});

// Check eBay Seller Connection Status
router.get('/seller-status', authenticateToken, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT ebay_seller_connected, ebay_seller_connected_at FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }

    const { ebay_seller_connected, ebay_seller_connected_at } = result.rows[0];

    res.json({
      success: true,
      connected: !!ebay_seller_connected,
      connectedAt: ebay_seller_connected_at
    });

  } catch (error) {
    console.error('❌ eBay seller status error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to check eBay connection status' 
    });
  }
});

// Disconnect eBay Seller Account
router.post('/disconnect-seller', authenticateToken, async (req, res) => {
  try {
    await db.query(`
      UPDATE users 
      SET ebay_seller_token = NULL,
          ebay_seller_refresh_token = NULL,
          ebay_seller_connected = false,
          ebay_seller_connected_at = NULL
      WHERE id = $1
    `, [req.user.userId]);

    // Log the disconnection (don't use card_id=0, it violates foreign key)
    // Just skip logging for now
    console.log('✅ eBay disconnected, skipping log entry');

    console.log('✅ eBay seller account disconnected for user:', req.user.userId);

    res.json({
      success: true,
      message: 'eBay seller account disconnected successfully'
    });

  } catch (error) {
    console.error('❌ eBay disconnect error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to disconnect eBay seller account' 
    });
  }
});

// ═══════════════════════════════════════════════════════
// 🔥 CREATE SINGLE EBAY LISTING
// ═══════════════════════════════════════════════════════

router.post('/create-listing', authenticateToken, async (req, res) => {
  try {
    const { 
      cardId, 
      price, 
      duration = 'GTC', 
      shippingCost = 4.99, 
      description,
      customTitle,
      quantity = 1,
      condition
    } = req.body;
    
    console.log('🏷️ Creating eBay listing for card:', cardId);
    
    // 1. Get user's OAuth token with auto-refresh
    let ebay_seller_token;
    try {
      ebay_seller_token = await getUserEbayToken(req.user.userId);
      console.log('🔑 Using user OAuth token for single listing');
    } catch (error) {
      console.error('❌ Failed to get eBay token:', error.message);
      return res.status(401).json({
        success: false,
        error: 'eBay seller account not connected',
        needsAuth: true
      });
    }
    
    // 2. Get card details
    const cardResult = await db.query(
      'SELECT * FROM cards WHERE id = $1 AND user_id = $2',
      [cardId, req.user.userId]
    );
    
    if (cardResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Card not found'
      });
    }
    
    const card = cardResult.rows[0];
    
    // 2.5 Get user's shipping settings
    const userResult = await db.query(`
      SELECT 
        ebay_ship_from_city,
        ebay_ship_from_state,
        ebay_ship_from_zip,
        ebay_ship_from_country,
        default_shipping_cost,
        default_shipping_service,
        default_handling_time,
        enable_free_shipping,
        free_shipping_threshold,
        default_returns_accepted,
        default_return_period
      FROM users 
      WHERE id = $1
    `, [req.user.userId]);

    const userSettings = userResult.rows[0];

    // Validate shipping address exists
    if (!userSettings.ebay_ship_from_city || !userSettings.ebay_ship_from_state || !userSettings.ebay_ship_from_zip) {
      return res.status(400).json({
        success: false,
        error: 'Shipping location not configured. Please add your shipping address in Settings → eBay Selling → Shipping Settings.',
        errorType: 'MISSING_LOCATION'
      });
    }

    // Get shipping cost from request body (shippingCost is already defined above from req.body)
let finalShippingCost = null;

// Check if user provided a shipping cost override
if (shippingCost !== undefined && shippingCost !== null) {
  finalShippingCost = parseFloat(shippingCost);
  console.log(`📦 Card ${cardId}: Using MANUAL shipping override: $${finalShippingCost}`);
}
// ONLY auto-detect if no override provided
else {
  const cardPrice = parseFloat(price);
  const isGraded = !!card.grading_company;
  
  console.log(`📦 Card ${cardId}: AUTO-DETECTING shipping for $${cardPrice} ${isGraded ? 'graded' : 'raw'} card...`);
  
  // Check free shipping threshold FIRST
  if (cardPrice >= userSettings.free_shipping_threshold && userSettings.enable_free_shipping) {
    finalShippingCost = 0;
    console.log(`   ✅ Free shipping (price $${cardPrice} >= $${userSettings.free_shipping_threshold})`);
  }
  else if (isGraded) {
    finalShippingCost = 4.99;
    console.log(`   ✅ Graded → BMWT: $4.99`);
  } else if (cardPrice < 10) {
    finalShippingCost = 1.00;
    console.log(`   ✅ Raw under $10 → PWE: $1.00`);
  } else if (cardPrice < 50) {
    finalShippingCost = 4.99;
    console.log(`   ✅ Raw $10-50 → BMWT: $4.99`);
  } else {
    finalShippingCost = 8.99;
    console.log(`   ✅ High value → Priority: $8.99`);
  }
}

// Determine shipping service
const finalShippingService = shippingService || userSettings.default_shipping_service || 'USPSFirstClass';

// Determine returns policy
    const finalReturnsAccepted = returnsAccepted !== undefined ? returnsAccepted : userSettings.default_returns_accepted;
    const finalReturnPeriod = userSettings.default_return_period || 0;

    console.log(`📦 Final shipping: $${finalShippingCost} via ${finalShippingService}`);
    console.log(`↩️ Returns: ${finalReturnsAccepted ? finalReturnPeriod + ' days' : 'Not accepted'}`);
    
    // 3. Build listing data
    const cleanSetName = card.set_name?.replace(/^\d{4}\s+/, '') || '';
    
    // 🔥 SMART TITLE BUILDING - ALWAYS INCLUDE GRADING INFO
    let title = customTitle || `${card.year} ${cleanSetName} ${card.player}`;
    if (!customTitle) {
      if (card.card_number) title += ` #${card.card_number}`;
      if (card.parallel && card.parallel !== 'Base') title += ` ${card.parallel}`;
      
      // 🔥 GRADING INFO (most important for search!)
      if (card.grading_company && card.grade) {
        title += ` ${card.grading_company} ${card.grade}`;
      }
      
      // 🔥 SERIAL NUMBER (if numbered)
      if (card.numbered === 'true' && card.serial_number && card.numbered_to) {
        title += ` ${card.serial_number}/${card.numbered_to}`;
      }
    }
    
    // Truncate to 80 characters (eBay limit)
    title = title.substring(0, 80);
    
    const listingDescription = description || `
🏆 ${card.year} ${cleanSetName} ${card.player} ${card.card_number ? `#${card.card_number}` : ''}

${card.parallel && card.parallel !== 'Base' ? `🎨 Parallel: ${card.parallel}\n` : ''}
${card.grading_company && card.grade ? `
✅ GRADED: ${card.grading_company} ${card.grade}
${card.cert_number ? `📜 Certificate #: ${card.cert_number}` : ''}
` : '🔓 Raw/Ungraded'}
${card.is_autographed ? '✍️ AUTOGRAPHED\n' : ''}
${card.numbered === 'true' && card.serial_number && card.numbered_to ? `🔢 SERIAL NUMBERED: ${card.serial_number}/${card.numbered_to}\n` : ''}
${card.sport ? `🏈 Sport: ${card.sport}\n` : ''}
${card.team ? `🏟️ Team: ${card.team}\n` : ''}

📦 Ships securely in top loader within 24 hours!
💯 100% Authentic - Guaranteed!
    `.trim();
    
    const images = [card.front_image_url, card.back_image_url].filter(Boolean);
    
    // Determine condition - graded cards = LIKE_NEW, raw = USED_EXCELLENT
    const ebayCondition = condition || (card.grading_company ? 'LIKE_NEW' : 'USED_EXCELLENT');
    
    // 4. Create listing via eBay service
    const result = await ebayService.createListing(ebay_seller_token, {
      card,
      title,
      description: listingDescription,
      price: parseFloat(price),
      quantity: parseInt(quantity),
      condition: ebayCondition,
      images,
      shippingCost: parseFloat(finalShippingCost),
      shippingService: finalShippingService,
      handlingTime: userSettings.default_handling_time || 1,
      duration,
      // NEW: Item location
      location: {
        city: userSettings.ebay_ship_from_city,
        stateOrProvince: userSettings.ebay_ship_from_state,
        postalCode: userSettings.ebay_ship_from_zip,
        country: userSettings.ebay_ship_from_country || 'US'
      },
      // NEW: Returns policy
      returnsAccepted: finalReturnsAccepted,
      returnPeriod: finalReturnPeriod
    });
    
    if (!result.success) {
      // Log error
      await db.query(`
        INSERT INTO ebay_listings_log (user_id, card_id, action, status, error_message)
        VALUES ($1, $2, 'create_listing', 'failed', $3)
      `, [req.user.userId, cardId, result.error]);
      
      return res.status(400).json({
        success: false,
        error: result.error
      });
    }
    
    // 5. Update card with eBay listing info
    await db.query(`
      UPDATE cards 
      SET ebay_listing_url = $1,
          ebay_listing_id = $2,
          ebay_sku = $3,
          ebay_offer_id = $4,
          ebay_listed_at = NOW(),
          ebay_listing_status = 'active',
          ebay_listing_price = $5,
          listing_status = 'listed',
          listing_price = $5
      WHERE id = $6
    `, [
      result.listingUrl,
      result.listingId,
      result.sku,
      result.offerId,
      price,
      cardId
    ]);
    
    // 6. Log success
    await db.query(`
      INSERT INTO ebay_listings_log (
        user_id, card_id, action, status, 
        listing_id, sku, offer_id, listing_url,
        metadata
      ) VALUES ($1, $2, 'create_listing', 'success', $3, $4, $5, $6, $7)
    `, [
      req.user.userId,
      cardId,
      result.listingId,
      result.sku,
      result.offerId,
      result.listingUrl,
      JSON.stringify({ price, shippingCost, duration, title })
    ]);
    
    console.log('✅ eBay listing created:', result.listingUrl);
    
    res.json({
      success: true,
      listing: {
        url: result.listingUrl,
        listingId: result.listingId,
        sku: result.sku
      }
    });
    
  } catch (error) {
    console.error('❌ Create listing error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create eBay listing',
      details: error.message
    });
  }
});

// ═══════════════════════════════════════════════════════
// 🔥 BULK CREATE EBAY LISTINGS
// ═══════════════════════════════════════════════════════

// 🔥 FIX POLICIES - Fetch existing eBay policies (FIXED)
router.get('/fix-policies', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Get user's eBay access token (with auto-refresh)
    let token;
    try {
      token = await getUserEbayToken(userId);
    } catch (error) {
      return res.status(401).json({ 
        success: false, 
        error: 'eBay not connected' 
      });
    }
    
    console.log('🔍 Fetching eBay policies with token...');
    
    // Fetch policies - ADD marketplace_id as QUERY PARAM
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Language': 'en-US'
    };
    
    const [paymentRes, returnRes, shippingRes] = await Promise.all([
      fetch('https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=EBAY_US', { headers }),
      fetch('https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=EBAY_US', { headers }),
      fetch('https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US', { headers })
    ]);
    
    const payment = await paymentRes.json();
    const returns = await returnRes.json();
    const shipping = await shippingRes.json();
    
    console.log('📋 Payment policies:', payment);
    console.log('📋 Return policies:', returns);
    console.log('📋 Shipping policies:', shipping);
    
    const paymentId = payment.paymentPolicies?.[0]?.paymentPolicyId;
    const returnId = returns.returnPolicies?.[0]?.returnPolicyId;
    const shippingId = shipping.fulfillmentPolicies?.[0]?.fulfillmentPolicyId;
    
    if (!paymentId || !returnId || !shippingId) {
      console.log('❌ Missing policies:', { paymentId, returnId, shippingId });
      return res.status(400).json({
        success: false,
        error: 'Some policies are missing. Go to eBay Seller Hub → Business Policies and create them.',
        details: {
          payment: !!paymentId,
          return: !!returnId,
          shipping: !!shippingId
        }
      });
    }
    
    // Save to database
    await db.query(
      'UPDATE users SET ebay_payment_policy_id = $1, ebay_return_policy_id = $2, ebay_fulfillment_policy_id = $3 WHERE id = $4',
      [paymentId, returnId, shippingId, userId]
    );
    
    console.log('✅ Policies saved:', { paymentId, returnId, shippingId });
    
    res.json({ 
      success: true, 
      paymentId, 
      returnId, 
      shippingId 
    });
  } catch (error) {
    console.error('❌ Fix policies error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

router.post('/bulk-create-listings', authenticateToken, async (req, res) => {
  try {
    const { 
      cardIds, 
      globalSettings = {},
      perCardSettings = {} 
    } = req.body;
    
    console.log(`🏷️ Bulk creating ${cardIds.length} eBay listings...`);
    
    // 🔥 TIER LIMITS CHECK (also get eBay token)
    const userResult = await db.query(
      'SELECT subscription_tier, ebay_listings_used, ebay_listings_reset_date, ebay_seller_token FROM users WHERE id = $1',
      [req.user.userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }
    
    const user = userResult.rows[0];
    const tier = user.subscription_tier || 'free';
    let ebayListingsUsed = user.ebay_listings_used || 0;
    const resetDate = user.ebay_listings_reset_date ? new Date(user.ebay_listings_reset_date) : null;
    
    // Check if we need to reset monthly counter
    const now = new Date();
    if (!resetDate || now > resetDate) {
      // Reset counter
      const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      await db.query(
        'UPDATE users SET ebay_listings_used = 0, ebay_listings_reset_date = $1 WHERE id = $2',
        [nextReset, req.user.userId]
      );
      ebayListingsUsed = 0;
      console.log(`🔄 Reset eBay listing counter for user ${req.user.userId}`);
    }
    
    // Tier limits: { batchLimit, monthlyLimit }
    const tierLimits = {
  free: { batch: 10, monthly: 50 },
  power: { batch: 25, monthly: 150 },
  dealer: { batch: 100, monthly: 999999 },
  // Legacy tiers get unlimited
  starter: { batch: 100, monthly: 999999 },
  pro: { batch: 100, monthly: 999999 },
  premium: { batch: 100, monthly: 999999 }
};
    
    const limits = tierLimits[tier] || tierLimits.free;
    
    // Check batch limit
    if (cardIds.length > limits.batch) {
      return res.status(403).json({
        success: false,
        error: `Your ${tier} plan allows listing ${limits.batch} cards at once. You selected ${cardIds.length} cards.`,
        errorType: 'BATCH_LIMIT',
        tier: tier,
        batchLimit: limits.batch,
        attempted: cardIds.length,
        upgradeMessage: tier === 'free' 
          ? 'Upgrade to Starter ($9/mo) to list 15 cards at once!'
          : tier === 'starter'
          ? 'Upgrade to Pro ($29/mo) to list 50 cards at once!'
          : 'Upgrade to Premium for unlimited bulk listing!'
      });
    }
    
    // Check monthly limit
    if (ebayListingsUsed + cardIds.length > limits.monthly) {
      const remaining = limits.monthly - ebayListingsUsed;
      return res.status(403).json({
        success: false,
        error: `Monthly limit reached. You have ${remaining} listings remaining this month (${tier} plan: ${limits.monthly}/month).`,
        errorType: 'MONTHLY_LIMIT',
        tier: tier,
        monthlyLimit: limits.monthly,
        used: ebayListingsUsed,
        remaining: remaining,
        attempted: cardIds.length,
        upgradeMessage: tier === 'free'
          ? 'Upgrade to Starter ($9/mo) for 150 listings/month!'
          : tier === 'starter'
          ? 'Upgrade to Pro ($29/mo) for 750 listings/month!'
          : 'Upgrade to Premium for unlimited listings!'
      });
    }
    
    console.log(`✅ Tier check passed: ${tier} plan (${ebayListingsUsed}/${limits.monthly} used this month)`);
    
    // 🔥 CHECK BUSINESS POLICIES (NEW!)
    console.log('🏪 Checking business policies...');
    const policiesCheck = await db.query(
      'SELECT ebay_payment_policy_id, ebay_return_policy_id, ebay_fulfillment_policy_id FROM users WHERE id = $1',
      [req.user.userId]
    );
    
    const policies = policiesCheck.rows[0];
    
    if (!policies.ebay_payment_policy_id || !policies.ebay_return_policy_id || !policies.ebay_fulfillment_policy_id) {
      console.log('❌ Business policies not set up');
      return res.status(400).json({
        success: false,
        error: 'eBay business policies not configured',
        errorType: 'MISSING_POLICIES',
        message: 'Please disconnect and reconnect your eBay account to auto-create business policies',
        action: 'RECONNECT_EBAY'
      });
    }
    
    console.log('✅ Business policies found:', {
      payment: policies.ebay_payment_policy_id,
      return: policies.ebay_return_policy_id,
      fulfillment: policies.ebay_fulfillment_policy_id
    });
    
    // Get user's OAuth token with auto-refresh
    let ebay_seller_token;
    try {
      ebay_seller_token = await getUserEbayToken(req.user.userId);
      console.log('🔑 Using user OAuth token for listing');
    } catch (error) {
      console.error('❌ Failed to get eBay token:', error.message);
      return res.status(401).json({
        success: false,
        error: 'eBay seller account not connected',
        needsAuth: true
      });
    }
    
    // Get user's shipping settings
    const userSettingsResult = await db.query(`
      SELECT 
        ebay_ship_from_city,
        ebay_ship_from_state,
        ebay_ship_from_zip,
        ebay_ship_from_country,
        default_shipping_cost,
        default_shipping_service,
        default_handling_time,
        enable_free_shipping,
        free_shipping_threshold,
        default_returns_accepted,
        default_return_period
      FROM users 
      WHERE id = $1
    `, [req.user.userId]);

    const userSettings = userSettingsResult.rows[0];

    // Validate shipping address
    if (!userSettings.ebay_ship_from_city || !userSettings.ebay_ship_from_state || !userSettings.ebay_ship_from_zip) {
      return res.status(400).json({
        success: false,
        error: 'Shipping location not configured. Please add your shipping address in Settings.',
        errorType: 'MISSING_LOCATION'
      });
    }

    console.log('✅ User shipping settings loaded');
    
    const results = {
      success: [],
      failed: []
    };
    
    // Process each card
    for (const cardId of cardIds) {
      try {
        // Get card
        const cardResult = await db.query(
          'SELECT * FROM cards WHERE id = $1 AND user_id = $2',
          [cardId, req.user.userId]
        );
        
        if (cardResult.rows.length === 0) {
          results.failed.push({
            cardId,
            error: 'Card not found'
          });
          continue;
        }
        
        const card = cardResult.rows[0];
        
        // Merge settings (per-card overrides global)
        const cardSettings = perCardSettings[cardId] || {};

        // AUTO-DETECT shipping cost
        // 🔥 Don't auto-detect if user explicitly set a shipping cost (even $0 or low values)
let finalShippingCost = cardSettings.shippingCost !== undefined && cardSettings.shippingCost !== null
  ? cardSettings.shippingCost 
  : (globalSettings.shippingCost !== undefined && globalSettings.shippingCost !== null
    ? globalSettings.shippingCost
    : null);

        if (!finalShippingCost) {
          const cardPrice = parseFloat(cardSettings.price || globalSettings.price || card.ebay_avg || 9.99);
          const isGraded = !!card.grading_company;
          
          console.log(`📦 Card ${cardId}: AUTO-DETECTING shipping for $${cardPrice} ${isGraded ? 'graded' : 'raw'} card...`);
          
          if (isGraded) {
            finalShippingCost = 4.99; // BMWT for graded
            console.log(`   ✅ Graded → BMWT: $4.99`);
          } else if (cardPrice < 10) {
            finalShippingCost = 1.00; // PWE for cheap raw
            console.log(`   ✅ Raw under $10 → PWE: $1.00`);
          } else if (cardPrice < 50) {
            finalShippingCost = 4.99; // BMWT
            console.log(`   ✅ Raw $10-50 → BMWT: $4.99`);
          } else if (cardPrice >= userSettings.free_shipping_threshold && userSettings.enable_free_shipping) {
            finalShippingCost = 0; // Free
            console.log(`   ✅ High value → Free shipping`);
          } else {
            finalShippingCost = 8.99; // Priority
            console.log(`   ✅ High value → Priority: $8.99`);
          }
        } else {
          console.log(`📦 Card ${cardId}: Using preset shipping: $${finalShippingCost}`);
        }

        const settings = {
  price: cardSettings.price || globalSettings.price || card.ebay_avg || 9.99,
  shippingCost: finalShippingCost,
  shippingService: cardSettings.shippingService || globalSettings.shippingService || userSettings.default_shipping_service,
  duration: cardSettings.duration || globalSettings.duration || 'GTC',
  condition: cardSettings.condition || globalSettings.condition,
  description: cardSettings.description || globalSettings.description,
  customTitle: cardSettings.customTitle,

  // 🔥 Standard Envelope detection
  useStandardEnvelope: globalSettings.useStandardEnvelope || false,
  // 🔥 Pass calculated vs flat rate setting (disabled if Standard Envelope)
  useCalculatedShipping: globalSettings.useStandardEnvelope ? false : (globalSettings.useCalculatedShipping !== undefined ? globalSettings.useCalculatedShipping : true),
  weightOz: globalSettings.useStandardEnvelope ? 2 : (globalSettings.packageWeight || 4)
};
        
        // Build title
        const cleanSetName = card.set_name?.replace(/^\d{4}\s+/, '') || '';
        let title = settings.customTitle || `${card.year} ${cleanSetName} ${card.player}`;
        if (!settings.customTitle) {
          if (card.card_number) title += ` #${card.card_number}`;
          if (card.parallel && card.parallel !== 'Base') title += ` ${card.parallel}`;
          if (card.grading_company) title += ` ${card.grading_company} ${card.grade}`;
        }
        title = title.substring(0, 80);
        
        // Build description
        const description = settings.description || `
${card.year} ${cleanSetName} ${card.player} ${card.card_number ? `#${card.card_number}` : ''}

${card.parallel && card.parallel !== 'Base' ? `Parallel: ${card.parallel}` : ''}
${card.grading_company ? `Graded: ${card.grading_company} ${card.grade}` : 'Raw/Ungraded'}
${card.cert_number ? `Cert #: ${card.cert_number}` : ''}
${card.is_autographed ? 'Autographed: Yes' : ''}
${card.numbered === 'true' ? `Numbered: ${card.serial_number || 'Yes'}` : ''}

Shipped securely in protective sleeve. Fast shipping!
        `.trim();
        
        const images = [card.front_image_url, card.back_image_url].filter(Boolean);
        // Determine condition - graded cards = LIKE_NEW, raw = USED_EXCELLENT
        const ebayCondition = settings.condition || (card.grading_company ? 'LIKE_NEW' : 'USED_EXCELLENT');
        console.log('📦 Listing settings:', {
  useStandardEnvelope: settings.useStandardEnvelope,
  useCalculatedShipping: settings.useCalculatedShipping,
  weightOz: settings.weightOz
});
        // Create listing
        const result = await ebayService.createListing(ebay_seller_token, {
          card,
          title,
          description,
          price: parseFloat(settings.price),
          quantity: 1,
          condition: ebayCondition,
          images,
          shippingCost: parseFloat(settings.shippingCost),
          shippingService: settings.shippingService,
          handlingTime: userSettings.default_handling_time,
          duration: settings.duration,
          // 🔥 ADD THIS LINE:
          useStandardEnvelope: settings.useStandardEnvelope,
          useCalculatedShipping: settings.useCalculatedShipping,
          packageWeight: settings.weightOz || 4,
          // NEW: Item location
          location: {
            city: userSettings.ebay_ship_from_city,
            stateOrProvince: userSettings.ebay_ship_from_state,
            postalCode: userSettings.ebay_ship_from_zip,
            country: userSettings.ebay_ship_from_country || 'US'
          },
          // NEW: Returns policy
          returnsAccepted: userSettings.default_returns_accepted,
          returnPeriod: userSettings.default_return_period
        });
        
        if (result.success) {
          // Update card
          await db.query(`
            UPDATE cards 
            SET ebay_listing_url = $1,
                ebay_listing_id = $2,
                ebay_sku = $3,
                ebay_offer_id = $4,
                ebay_listed_at = NOW(),
                ebay_listing_status = 'active',
                ebay_listing_price = $5,
                listing_status = 'listed',
                listing_price = $5
            WHERE id = $6
          `, [
            result.listingUrl,
            result.listingId,
            result.sku,
            result.offerId,
            settings.price,
            cardId
          ]);
          
          // Log success
          await db.query(`
            INSERT INTO ebay_listings_log (
              user_id, card_id, action, status, 
              listing_id, sku, offer_id, listing_url,
              metadata
            ) VALUES ($1, $2, 'bulk_create', 'success', $3, $4, $5, $6, $7)
          `, [
            req.user.userId,
            cardId,
            result.listingId,
            result.sku,
            result.offerId,
            result.listingUrl,
            JSON.stringify({ ...settings, title })
          ]);
          
          results.success.push({
            cardId,
            listingUrl: result.listingUrl,
            listingId: result.listingId
          });
          
          console.log(`✅ Listed card ${cardId}: ${result.listingUrl}`);
        } else {
          // Log error
          await db.query(`
            INSERT INTO ebay_listings_log (user_id, card_id, action, status, error_message)
            VALUES ($1, $2, 'bulk_create', 'failed', $3)
          `, [req.user.userId, cardId, result.error]);
          
          results.failed.push({
            cardId,
            error: result.error
          });
          
          console.log(`❌ Failed card ${cardId}: ${result.error}`);
        }
        
        // Rate limiting: 1 second between listings
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error(`❌ Error listing card ${cardId}:`, error);
        results.failed.push({
          cardId,
          error: error.message
        });
      }
    }
    
    // Update monthly usage counter
    await db.query(
      'UPDATE users SET ebay_listings_used = ebay_listings_used + $1 WHERE id = $2',
      [results.success.length, req.user.userId]
    );
    
    console.log(`📊 Updated usage: ${ebayListingsUsed + results.success.length}/${limits.monthly}`);
    
    console.log(`✅ Bulk listing complete: ${results.success.length} success, ${results.failed.length} failed`);
    
    res.json({
      success: true,
      results: {
        total: cardIds.length,
        succeeded: results.success.length,
        failed: results.failed.length,
        details: {
          succeeded: results.success,
          failed: results.failed
        }
      },
      usage: {
        used: ebayListingsUsed + results.success.length,
        limit: limits.monthly,
        tier: tier
      }
    });
    
  } catch (error) {
    console.error('❌ Bulk create listings error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to bulk create listings',
      details: error.message
    });
  }
});

// ═══════════════════════════════════════════════════════
// 🔥 END EBAY LISTING
// ═══════════════════════════════════════════════════════

router.post('/end-listing/:cardId', authenticateToken, async (req, res) => {
  try {
    const { cardId } = req.params;
    const { reason = 'NOT_AVAILABLE' } = req.body;
    
    console.log('🛑 Ending eBay listing for card:', cardId);
    
    // Get user's OAuth token with auto-refresh
    let ebay_seller_token;
    try {
      ebay_seller_token = await getUserEbayToken(req.user.userId);
    } catch (error) {
      return res.status(401).json({
        success: false,
        error: 'eBay seller account not connected'
      });
    }
    
    // Get card with eBay listing info
    const cardResult = await db.query(
      'SELECT * FROM cards WHERE id = $1 AND user_id = $2',
      [cardId, req.user.userId]
    );
    
    if (cardResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Card not found'
      });
    }
    
    const card = cardResult.rows[0];
    
    if (!card.ebay_offer_id) {
      return res.status(400).json({
        success: false,
        error: 'Card is not listed on eBay'
      });
    }
    
    // End listing via eBay API
    const result = await ebayService.endListing(ebay_seller_token, card.ebay_offer_id, reason);
    
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error
      });
    }
    
    // Update card status
    await db.query(`
      UPDATE cards 
      SET ebay_listing_status = 'ended',
          listing_status = 'unlisted'
      WHERE id = $1
    `, [cardId]);
    
    // Log action
    await db.query(`
      INSERT INTO ebay_listings_log (
        user_id, card_id, action, status, listing_id, metadata
      ) VALUES ($1, $2, 'end_listing', 'success', $3, $4)
    `, [
      req.user.userId,
      cardId,
      card.ebay_listing_id,
      JSON.stringify({ reason })
    ]);
    
    console.log('✅ eBay listing ended');
    
    res.json({
      success: true,
      message: 'Listing ended successfully'
    });
    
  } catch (error) {
    console.error('❌ End listing error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to end eBay listing'
    });
  }
});

// ═══════════════════════════════════════════════════════
// 🔥 GET LISTING STATUS
// ═══════════════════════════════════════════════════════

router.get('/listing-status/:cardId', authenticateToken, async (req, res) => {
  try {
    const { cardId } = req.params;
    
    const result = await db.query(`
      SELECT 
        ebay_listing_url,
        ebay_listing_id,
        ebay_listing_status,
        ebay_listing_price,
        ebay_listed_at
      FROM cards 
      WHERE id = $1 AND user_id = $2
    `, [cardId, req.user.userId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Card not found'
      });
    }
    
    const card = result.rows[0];
    
    res.json({
      success: true,
      listing: {
        url: card.ebay_listing_url,
        listingId: card.ebay_listing_id,
        status: card.ebay_listing_status,
        price: card.ebay_listing_price,
        listedAt: card.ebay_listed_at,
        isActive: card.ebay_listing_status === 'active'
      }
    });
    
  } catch (error) {
    console.error('❌ Get listing status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get listing status'
    });
  }
});

// Remove listing from SlabTrack (doesn't end eBay listing)
router.patch('/remove-listing/:cardId', authenticateToken, async (req, res) => {
  try {
    const { cardId } = req.params;
    const { reason, listing_type } = req.body;
    
    console.log(`🗑️ Removing listing for card ${cardId}...`);
    
    // If it's a lot, get all cards with same eBay listing ID
    const cardResult = await db.query(
      'SELECT ebay_listing_id, ebay_sku FROM cards WHERE id = $1 AND user_id = $2',
      [cardId, req.user.userId]
    );
    
    if (cardResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Card not found' });
    }
    
    const card = cardResult.rows[0];
    
    const isLot = listing_type === 'lot' || card.ebay_listing_status === 'active_lot';
    
    if (isLot && card.ebay_listing_id) {
      // Remove ALL cards in this lot
      await db.query(`
        UPDATE cards 
        SET listing_status = 'unlisted',
            ebay_listing_url = NULL,
            ebay_listing_id = NULL,
            ebay_sku = NULL,
            ebay_offer_id = NULL,
            ebay_listing_status = NULL,
            ebay_listing_price = NULL,
            listing_price = NULL
        WHERE ebay_listing_id = $1 AND user_id = $2
      `, [card.ebay_listing_id, req.user.userId]);
      
      console.log(`✅ Removed lot listing: ${card.ebay_listing_id}`);
    } else {
      // Remove single card
      await db.query(`
        UPDATE cards 
        SET listing_status = 'unlisted',
            ebay_listing_url = NULL,
            ebay_listing_id = NULL,
            ebay_sku = NULL,
            ebay_offer_id = NULL,
            ebay_listing_status = NULL,
            ebay_listing_price = NULL,
            listing_price = NULL
        WHERE id = $1 AND user_id = $2
      `, [cardId, req.user.userId]);
      
      console.log(`✅ Removed individual listing: ${cardId}`);
    }
    
    // Log the removal
    await db.query(`
      INSERT INTO ebay_listings_log (user_id, card_id, action, status, metadata)
      VALUES ($1, $2, 'remove_listing', 'success', $3)
    `, [req.user.userId, cardId, JSON.stringify({ reason, listing_type })]);
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('❌ Remove listing error:', error);
    res.status(500).json({ success: false, error: 'Failed to remove listing' });
  }
});

// ═══════════════════════════════════════════════════════
// 🔥 GET USER'S EBAY LISTINGS HISTORY
// ═══════════════════════════════════════════════════════

router.get('/listings-history', authenticateToken, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        l.*,
        c.player,
        c.year,
        c.set_name,
        c.front_image_url
      FROM ebay_listings_log l
      LEFT JOIN cards c ON l.card_id = c.id
      WHERE l.user_id = $1
      ORDER BY l.created_at DESC
      LIMIT 50
    `, [req.user.userId]);
    
    res.json({
      success: true,
      history: result.rows
    });
    
  } catch (error) {
    console.error('❌ Get listings history error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get listings history'
    });
  }
});

// 🧪 TEST ENDPOINT - Check eBay's category requirements
router.get('/test-category-specs', async (req, res) => {
  try {
    const token = await ebayService.getAccessToken();
    
    const response = await axios.get(
      'https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category',
      {
        params: { category_id: '183454' },
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
        }
      }
    );
    
    console.log('📋 Category 183454 Required Aspects:', JSON.stringify(response.data, null, 2));
    
    res.json({
      success: true,
      aspects: response.data
    });
    
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════
// 🔨 CREATE AUCTION LISTING
// ═══════════════════════════════════════════════════════
router.post('/create-auction', authenticateToken, async (req, res) => {
  try {
    console.log('🔨 POST /create-auction - Creating auction listing...');
    
    const {
      cardId,
      title,
      description,
      startPrice,        // Starting bid (e.g., 0.99, 9.99, 25.00)
      reservePrice,      // Optional hidden minimum
      buyItNowPrice,     // Optional instant purchase
      duration,          // DAYS_3, DAYS_5, DAYS_7, DAYS_10
      shippingCost,
      useCalculatedShipping,
      packageWeight,
      useStandardEnvelope,
      returnsAccepted,
      returnPeriod,
      handlingTime
    } = req.body;

    console.log(`📊 Auction Request:
  Card ID: ${cardId}
  Starting Bid: $${startPrice}
  Reserve: ${reservePrice ? '$' + reservePrice : 'None'}
  Buy It Now: ${buyItNowPrice ? '$' + buyItNowPrice : 'None'}
  Duration: ${duration}`);

    // Validate required fields
    if (!cardId || !title || !startPrice || !duration) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: cardId, title, startPrice, duration'
      });
    }

    // Validate duration
    const validDurations = ['DAYS_3', 'DAYS_5', 'DAYS_7', 'DAYS_10'];
    if (!validDurations.includes(duration)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid duration. Must be DAYS_3, DAYS_5, DAYS_7, or DAYS_10'
      });
    }

    // Get user's eBay token
    // Get user's eBay token with auto-refresh
    let accessToken;
    try {
      accessToken = await getUserEbayToken(req.user.userId);
      console.log('🔑 Using user OAuth token (auto-refreshed if needed)');
    } catch (error) {
      console.error('❌ Failed to get eBay token:', error.message);
      return res.status(401).json({
        success: false,
        error: 'eBay seller account not connected',
        needsAuth: true
      });
    }

    const userResult = await db.query(
      'SELECT ebay_ship_from_city, ebay_ship_from_state, ebay_ship_from_zip FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }
    const userData = userResult.rows[0];

    // Get card details
    const cardResult = await db.query(
      `SELECT * FROM cards WHERE id = $1 AND user_id = $2`,
      [cardId, req.user.userId]
    );

    if (cardResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Card not found'
      });
    }

    const card = cardResult.rows[0];

    // Build listing data
    const listingData = {
      card,
      title,
      description: description || `${card.year || ''} ${card.set_name || ''} ${card.player || ''} #${card.card_number || ''}`.trim(),
      startPrice: parseFloat(startPrice),
      reservePrice: reservePrice ? parseFloat(reservePrice) : null,
      buyItNowPrice: buyItNowPrice ? parseFloat(buyItNowPrice) : null,
      duration,
      quantity: 1,
      condition: card.condition || 'USED_VERY_GOOD',
      images: [card.front_image_url, card.back_image_url].filter(Boolean),
      shippingCost: shippingCost !== undefined ? parseFloat(shippingCost) : 4.99,
      useCalculatedShipping: useCalculatedShipping || false,
      packageWeight: packageWeight || 4,
      useStandardEnvelope: useStandardEnvelope || false,
      returnsAccepted: returnsAccepted !== undefined ? returnsAccepted : false,
      returnPeriod: returnPeriod || 0,
      handlingTime: handlingTime || 3,
      location: {
        city: userData.ebay_ship_from_city || 'Dallas',
        stateOrProvince: userData.ebay_ship_from_state || 'TX',
        postalCode: userData.ebay_ship_from_zip || '75001',
        country: 'US'
      }
    };

    // Create auction listing
    const result = await ebayService.createAuctionListing(accessToken, listingData);

    if (!result.success) {
      return res.status(400).json(result);
    }

    // Update card in database
    await db.query(
  `UPDATE cards 
   SET listing_type = $1,
       auction_start_price = $2,
       auction_reserve_price = $3,
       auction_buy_it_now = $4,
       auction_duration = $5,
       auction_end_time = NOW() + INTERVAL '1 day' * $6,
       ebay_listing_id = $7,
       ebay_sku = $8,
       ebay_offer_id = $9,
       ebay_listing_url = $10,
       ebay_listing_status = $11,
       listing_status = 'listed',
       listing_price = $2,
       listed_date = NOW()
   WHERE id = $12`,
  [
    'auction',
    startPrice,
    reservePrice,
    buyItNowPrice,
    duration,
    duration === 'DAYS_3' ? 3 : duration === 'DAYS_5' ? 5 : duration === 'DAYS_7' ? 7 : 10,
    result.listingId,
    result.sku,
    result.offerId,
    result.listingUrl,
    'active',
    cardId
  ]
);

    console.log(`✅ Auction created: ${result.listingUrl}`);

    res.json({
      success: true,
      listingUrl: result.listingUrl,
      listingId: result.listingId,
      offerId: result.offerId
    });

  } catch (error) {
    console.error('❌ Create auction error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ═══════════════════════════════════════════════════════
// 🔨 BULK CREATE AUCTION LISTINGS
// ═══════════════════════════════════════════════════════
router.post('/bulk-create-auctions', authenticateToken, async (req, res) => {
  try {
    console.log('🔨 POST /bulk-create-auctions - Creating multiple auctions...');
    
    const { auctions } = req.body; // Array of auction objects

    if (!Array.isArray(auctions) || auctions.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'auctions must be a non-empty array'
      });
    }

    console.log(`📦 Creating ${auctions.length} auction listings...`);

    // Get user's eBay token with auto-refresh
    let accessToken;
    try {
      accessToken = await getUserEbayToken(req.user.userId);
      console.log('🔑 Using user OAuth token (auto-refreshed if needed)');
    } catch (error) {
      console.error('❌ Failed to get eBay token:', error.message);
      return res.status(401).json({
        success: false,
        error: 'eBay seller account not connected',
        needsAuth: true
      });
    }

    // Get user settings (shipping location)
    const userResult = await db.query(
      'SELECT ebay_ship_from_city, ebay_ship_from_state, ebay_ship_from_zip, ebay_ship_from_country FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const userData = userResult.rows[0]; // 🔥 THIS WAS MISSING!

    const results = [];
    
    for (const auction of auctions) {
      try {
        const { cardId, title, description, startPrice, reservePrice, buyItNowPrice, duration, shippingCost } = auction;

        // Get card
        const cardResult = await db.query(
          'SELECT * FROM cards WHERE id = $1 AND user_id = $2',
          [cardId, req.user.userId]
        );

        if (cardResult.rows.length === 0) {
          results.push({ cardId, success: false, error: 'Card not found' });
          continue;
        }

        const card = cardResult.rows[0];

        // Build listing data
        const listingData = {
          card,
          title,
          description: description || `${card.year || ''} ${card.set_name || ''} ${card.player || ''}`.trim(),
          startPrice: parseFloat(startPrice),
          reservePrice: reservePrice ? parseFloat(reservePrice) : null,
          buyItNowPrice: buyItNowPrice ? parseFloat(buyItNowPrice) : null,
          duration: duration || 'DAYS_7',
          images: [card.front_image_url, card.back_image_url].filter(Boolean),
          shippingCost: auction.shippingCost !== undefined ? parseFloat(auction.shippingCost) : 4.99,
          useCalculatedShipping: auction.useCalculatedShipping !== undefined ? auction.useCalculatedShipping : false,
          useStandardEnvelope: auction.useStandardEnvelope !== undefined ? auction.useStandardEnvelope : false,
          packageWeight: auction.packageWeight || 4,
          returnsAccepted: auction.returnsAccepted !== undefined ? auction.returnsAccepted : false,
          returnPeriod: auction.returnPeriod || 0,
          handlingTime: auction.handlingTime || 3,
          location: {
            city: userData.ebay_ship_from_city || 'Dallas',
            stateOrProvince: userData.ebay_ship_from_state || 'TX',
            postalCode: userData.ebay_ship_from_zip || '75001',
            country: userData.ebay_ship_from_country || 'US'
          }
        };

        // Create auction
        const result = await ebayService.createAuctionListing(accessToken, listingData);

        if (result.success) {
          // Update database
          await db.query(
  `UPDATE cards 
   SET listing_type = 'auction',
       auction_start_price = $1,
       auction_reserve_price = $2,
       auction_buy_it_now = $3,
       auction_duration = $4,
       auction_end_time = NOW() + INTERVAL '1 day' * $5,
       ebay_listing_id = $6,
       ebay_sku = $7,
       ebay_offer_id = $8,
       ebay_listing_url = $9,
       ebay_listing_status = 'active',
       listing_status = 'listed',
       listing_price = $1,
       listed_date = NOW()
   WHERE id = $10`,
  [
    startPrice,
    reservePrice,
    buyItNowPrice,
    duration,
    duration === 'DAYS_3' ? 3 : duration === 'DAYS_5' ? 5 : duration === 'DAYS_7' ? 7 : 10,
    result.listingId,
    result.sku,
    result.offerId,
    result.listingUrl,
    cardId
  ]
);
        }

        results.push({
          cardId,
          success: result.success,
          listingUrl: result.listingUrl,
          error: result.error
        });

      } catch (error) {
        results.push({ cardId: auction.cardId, success: false, error: error.message });
      }
    }

    const successCount = results.filter(r => r.success).length;
    console.log(`✅ Created ${successCount}/${auctions.length} auctions`);

    res.json({
      success: true,
      results,
      summary: {
        total: auctions.length,
        successful: successCount,
        failed: auctions.length - successCount
      }
    });

  } catch (error) {
    console.error('❌ Bulk create auctions error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ═══════════════════════════════════════════════════════
// 🏷️ CREATE LOT LISTING
// ═══════════════════════════════════════════════════════
router.post('/create-lot-listing', authenticateToken, async (req, res) => {
  try {
    const { cardIds, title, description, price, condition = 'LIKE_NEW',
      useStandardEnvelope = false, useCalculatedShipping = true, shippingCost, packageWeight = 8,
      shippingService = 'USPSFirstClass', handlingTime = 3,
      returnsAccepted = false, returnPeriod = 0, duration = 'GTC',
      generateCollage = false, collageGridSize = 'large', includeCompCollage = false
    } = req.body;

    console.log(`📦 Creating LOT listing with ${cardIds.length} cards...`);

    if (!cardIds || cardIds.length < 2) {
      return res.status(400).json({ success: false, error: 'At least 2 cards required for a lot' });
    }

    // Get eBay token
    let ebay_seller_token;
    try {
      ebay_seller_token = await getUserEbayToken(req.user.userId);
    } catch (error) {
      return res.status(401).json({ success: false, error: 'eBay not connected', needsAuth: true });
    }

    // Check policies
    const policiesCheck = await db.query(
      'SELECT ebay_payment_policy_id, ebay_return_policy_id, ebay_fulfillment_policy_id FROM users WHERE id = $1',
      [req.user.userId]
    );
    const policies = policiesCheck.rows[0];
    if (!policies.ebay_payment_policy_id || !policies.ebay_return_policy_id || !policies.ebay_fulfillment_policy_id) {
      return res.status(400).json({ success: false, error: 'eBay policies not configured', errorType: 'MISSING_POLICIES' });
    }

    // Get user settings
    const userSettingsResult = await db.query(
      `SELECT ebay_ship_from_city, ebay_ship_from_state, ebay_ship_from_zip, ebay_ship_from_country, default_handling_time FROM users WHERE id = $1`,
      [req.user.userId]
    );
    const userSettings = userSettingsResult.rows[0];
    if (!userSettings.ebay_ship_from_city || !userSettings.ebay_ship_from_zip) {
      return res.status(400).json({ success: false, error: 'Shipping location not configured', errorType: 'MISSING_LOCATION' });
    }

    // Get all cards
    const cardsResult = await db.query(
      `SELECT * FROM cards WHERE id = ANY($1) AND user_id = $2`,
      [cardIds, req.user.userId]
    );
    if (cardsResult.rows.length !== cardIds.length) {
      return res.status(400).json({ success: false, error: `Only found ${cardsResult.rows.length} of ${cardIds.length} cards` });
    }
    const cards = cardsResult.rows;
    
    // 🔍 DEBUG: Check pricing data
    console.log(`📊 Sample card pricing:`, cards.slice(0, 3).map(c => ({
      player: c.player,
      ebay_avg: c.ebay_avg,
      ebay_low: c.ebay_low,
      ebay_high: c.ebay_high,
      ebay_sample_size: c.ebay_sample_size
    })));

    // Generate collage images if requested
    let images = [];
    if (generateCollage) {
      console.log(`🎨 Generating collage images with ${collageGridSize} grid...`);
      
      const collageResult = await generateLotCollages(cards.map(c => ({
        front_image: c.front_image_url,
        back_image: c.back_image_url,
        // Player info
        player: c.player,
        year: c.year,
        set_name: c.set_name,
        front_image_thumb: c.front_image_thumb,
        // Pricing data (all fields from SlabTrack)
        ebay_low: c.ebay_low,           // Lowest BIN (green)
        ebay_avg: c.ebay_avg,           // Average
        ebay_high: c.ebay_high,         // Highest
        asking_price: c.asking_price,   // Your price (yellow)
        listing_price: c.listing_price, // Alternative your price
        recent_sold_avg: c.ebay_avg,    // Recent sold (blue) - same as avg
        ebay_sample_size: c.ebay_sample_size,
        // Grading info
        grading_company: c.grading_company,
        grade: c.grade,
        // PSA 10 potential (if exists in DB)
        psa_10_value: c.psa_10_value || null
      })), {
        gridSize: collageGridSize,
        includeCompCollage: includeCompCollage // NEW
      });

      if (!collageResult.success) {
        console.error('❌ Collage generation failed:', collageResult.error);
        return res.status(400).json({ 
          success: false, 
          error: collageResult.error 
        });
      }

      // Use collage URLs (Cloudinary URLs returned by generateLotCollages)
      images = collageResult.collages.map(c => c.image);
      console.log(`✅ Generated ${images.length} collage images for ${collageResult.totalCards} cards`);
      console.log(`   📐 Grid: ${collageResult.gridInfo} (${collageResult.cardsPerPage} cards/page, ${collageResult.totalPages} pages)`);
      console.log('   🖼️ Collage URLs:', images.slice(0, 3), '...');
    } else {
      // Original logic: collect individual images (max 12)
      const allImages = [];
      cards.forEach(card => {
        if (card.front_image_url) allImages.push(card.front_image_url);
        if (card.back_image_url) allImages.push(card.back_image_url);
      });
      images = allImages.slice(0, 12);
    }

    if (images.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one card must have an image' });
    }

    const hasGradedCards = cards.some(c => c.grading_company);
    const lotSku = `LOT-${req.user.userId}-${Date.now()}`;

    // Create listing
    const result = await ebayService.createListing(ebay_seller_token, {
      card: cards[0],
      title: title.substring(0, 80),
      description,
      price: parseFloat(price),
      quantity: 1,
      condition: hasGradedCards ? 'LIKE_NEW' : condition,
      images,
      useStandardEnvelope: useStandardEnvelope,
      shippingCost: useStandardEnvelope ? 0 : (useCalculatedShipping ? null : parseFloat(shippingCost || 5.99)),
      shippingService,
      handlingTime: handlingTime || userSettings.default_handling_time || 3,
      duration,
      useCalculatedShipping,
      packageWeight,
      location: {
        city: userSettings.ebay_ship_from_city,
        stateOrProvince: userSettings.ebay_ship_from_state,
        postalCode: userSettings.ebay_ship_from_zip,
        country: userSettings.ebay_ship_from_country || 'US'
      },
      returnsAccepted,
      returnPeriod,
      customSku: lotSku
    });

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    // Update ALL cards with listing info
    for (const card of cards) {
      await db.query(`
        UPDATE cards SET ebay_listing_url = $1, ebay_listing_id = $2, ebay_sku = $3,
          ebay_offer_id = $4, ebay_listed_at = NOW(), ebay_listing_status = 'active_lot',
          ebay_listing_price = $5, listing_status = 'listed', listing_price = $5
        WHERE id = $6
      `, [result.listingUrl, result.listingId, lotSku, result.offerId, price, card.id]);
    }

    // 🔥 CREATE LOT_LISTINGS RECORD so it shows in Sales Analytics
    const totalCardValue = cards.reduce((sum, c) => sum + (parseFloat(c.ebay_avg) || parseFloat(c.asking_price) || 0), 0);
    
    const lotResult = await db.query(`
      INSERT INTO lot_listings (
        user_id, title, description, lot_type, listing_price,
        platform, status, listing_status, listed_date,
        ebay_listing_id, ebay_listing_url,
        card_count, total_card_value,
        created_at, updated_at
      ) VALUES ($1, $2, $3, 'custom', $4, 'ebay', 'active', 'listed', NOW(), $5, $6, $7, $8, NOW(), NOW())
      RETURNING id
    `, [
      req.user.userId,
      title,
      description,
      price,
      result.listingId,
      result.listingUrl,
      cards.length,
      totalCardValue
    ]);
    
    const lotId = lotResult.rows[0].id;
    
    // Link all cards to this lot in junction table
    for (const card of cards) {
      await db.query(
        'INSERT INTO lot_listing_cards (lot_id, card_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [lotId, card.id]
      );
    }
    
    console.log(`✅ Created lot_listings record ID: ${lotId} with ${cards.length} cards`);

    // Log success
    await db.query(`
      INSERT INTO ebay_listings_log (user_id, card_id, action, status, listing_id, sku, offer_id, listing_url, metadata)
      VALUES ($1, $2, 'create_lot', 'success', $3, $4, $5, $6, $7)
    `, [req.user.userId, cards[0].id, result.listingId, lotSku, result.offerId, result.listingUrl,
        JSON.stringify({ cardIds, cardCount: cards.length, title, price, lotId })]);

    // Update usage (counts as 1 listing)
    await db.query('UPDATE users SET ebay_listings_used = ebay_listings_used + 1 WHERE id = $1', [req.user.userId]);

    console.log(`✅ LOT listing created: ${result.listingUrl}`);

    res.json({
      success: true,
      listingUrl: result.listingUrl,
      listingId: result.listingId,
      sku: lotSku,
      cardCount: cards.length,
      price: parseFloat(price)
    });

  } catch (error) {
    console.error('❌ Create lot listing error:', error);
    res.status(500).json({ success: false, error: 'Failed to create lot listing', details: error.message });
  }
});

module.exports = router;
