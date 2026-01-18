const axios = require('axios');
const cardMatcher = require('../utils/cardMatcher');

class EbayOAuthService {
  constructor() {
  // ═══════════════════════════════════════════════════════
  // 🔐 CREDENTIALS (Required - No Fallbacks!)
  // ═══════════════════════════════════════════════════════
  this.clientId = process.env.EBAY_APP_ID;
  this.clientSecret = process.env.EBAY_CERT_ID;
  
  if (!this.clientId || !this.clientSecret) {
    throw new Error('❌ Missing eBay API credentials: Set EBAY_APP_ID and EBAY_CERT_ID in environment variables');
  }
  
  // ═══════════════════════════════════════════════════════
  // 🌐 API ENDPOINTS
  // ═══════════════════════════════════════════════════════
  this.browseApiUrl = 'https://api.ebay.com/buy/browse/v1';
  this.oauthUrl = 'https://api.ebay.com/identity/v1/oauth2/token';
  this.marketplaceInsightsUrl = 'https://api.ebay.com/buy/marketplace_insights/v1_beta';
  this.findingApiUrl = 'https://svcs.ebay.com/services/search/FindingService/v1';
  
  // ═══════════════════════════════════════════════════════
  // 📊 CONSTANTS
  // ═══════════════════════════════════════════════════════
  this.MARKETPLACE_ID = 'EBAY_US';
  this.DEFAULT_LOCATION_KEY = 'default';
  this.DEFAULT_CATEGORY_ID = '183454';  // Sports Trading Cards
  this.DEFAULT_SHIPPING_COST = 4.99;
  this.LISTING_DURATION = 'GTC';
  this.DEFAULT_HANDLING_TIME = 1; // 1 business day
  
  // ═══════════════════════════════════════════════════════
  // 🔑 TOKEN CACHE
  // ═══════════════════════════════════════════════════════
  this.accessToken = null;
  this.tokenExpiry = null;
}

  async getAccessToken() {
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    try {
      console.log('🔐 Getting new eBay OAuth token...');
      
      const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      
      const response = await axios.post(
        this.oauthUrl,
        'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${auth}`
          }
        }
      );

      this.accessToken = response.data.access_token;
      this.tokenExpiry = Date.now() + ((response.data.expires_in - 300) * 1000);
      
      console.log('✅ OAuth token obtained');
      return this.accessToken;

    } catch (error) {
      console.error('❌ OAuth Error:', error.response?.data || error.message);
      throw new Error('Failed to get eBay access token');
    }
  }

  // ═══════════════════════════════════════════════════════
  // 🔍 BROWSE & SEARCH API (Price Lookups)
  // ═══════════════════════════════════════════════════════

  async getSoldListings(searchQuery, cardDetails = {}) {
    console.log('🔍 SOLD COMPS - Using Browse API (last 90 days)');
    
    try {
      const token = await this.getAccessToken();
      const queries = this.buildProgressiveQueries(cardDetails);
      
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 90);

      let bestResult = null;
      
      for (const queryObj of queries) {
        console.log(`🔍 Sold Search ${queryObj.level}: "${queryObj.query}"`);
        
        const params = {
          q: queryObj.query,
          limit: 50,
          filter: `buyingOptions:{FIXED_PRICE|AUCTION},itemEndDate:[${startDate.toISOString()}..${endDate.toISOString()}]`
        };

        try {
          const response = await axios.get(`${this.browseApiUrl}/item_summary/search`, {
            params,
            headers: {
              'Authorization': `Bearer ${token}`,
              'X-EBAY-C-MARKETPLACE-ID': this.MARKETPLACE_ID
            },
            timeout: 10000
          });

          const items = response.data.itemSummaries || [];
          const listings = items.map(item => ({
            title: item.title || '',
            price: parseFloat(item.price?.value || 0),
            soldDate: item.itemEndDate || new Date().toISOString(),
            listingUrl: item.itemWebUrl || '',
            image: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || null,
            condition: item.condition || 'Used',
            seller: item.seller?.username || 'Unknown'
          })).filter(item => item.price > 0);

          console.log(`   → ${listings.length} completed listings`);

          if (listings.length >= 5) {
            bestResult = { listings, query: queryObj.query, level: queryObj.level };
            console.log(`   ✅ Using ${queryObj.level} search`);
            break;
          } else if (listings.length > 0 && !bestResult) {
            bestResult = { listings, query: queryObj.query, level: queryObj.level };
            console.log(`   💾 Saved as backup`);
          }
        } catch (error) {
          console.log(`   ❌ Failed: ${error.message}`);
        }
      }

      if (!bestResult || bestResult.listings.length === 0) {
        console.log('⚠️ No completed listings found');
        return this.emptyResult(searchQuery);
      }

      console.log(`✅ ${bestResult.listings.length} sold comps (${bestResult.level})`);
      return this.formatResults(bestResult.listings, searchQuery, bestResult.query, cardDetails);

    } catch (error) {
      console.error('❌ Sold comps error:', error.message);
      return this.emptyResult(searchQuery, error.message);
    }
  }

  async getCurrentListings(searchQuery, cardDetails = {}) {
    try {
      const token = await this.getAccessToken();
      
      const { 
        player = '', 
        year = '', 
        setName = '', 
        cardNumber = '',
        parallel = '',
        gradingCompany = '', 
        grade = ''
      } = cardDetails;

      console.log(`🔍 ACTIVE LISTINGS - Progressive Search:`);
      console.log(`   ${year} ${setName} | ${player} | #${cardNumber} | ${parallel} | ${gradingCompany} ${grade}`);

      const queries = this.buildProgressiveQueries({
        year, setName, player, cardNumber, parallel, gradingCompany, grade
      });

      console.log(`📊 Trying ${queries.length} progressive queries...`);

      let bestResult = null;
      
      for (const queryObj of queries) {
        console.log(`🔍 Search ${queryObj.level}: "${queryObj.query}"`);
        
        const params = {
          q: queryObj.query,
          limit: 50
        };

        try {
          const response = await axios.get(`${this.browseApiUrl}/item_summary/search`, {
            params,
            headers: {
              'Authorization': `Bearer ${token}`,
              'X-EBAY-C-MARKETPLACE-ID': this.MARKETPLACE_ID
            },
            timeout: 10000
          });

          const items = response.data.itemSummaries || [];
          const listings = items.map(item => ({
            title: item.title || '',
            price: parseFloat(item.price?.value || 0),
            listingUrl: item.itemWebUrl || '',
            image: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || null,
            condition: item.condition || 'Used',
            seller: item.seller?.username || 'Unknown'
          })).filter(item => item.price > 0);

          console.log(`   → ${listings.length} results`);

          if (listings.length >= 3) {
            bestResult = { listings, query: queryObj.query, level: queryObj.level };
            console.log(`   ✅ Using ${queryObj.level} search`);
            break;
          } else if (listings.length > 0 && !bestResult) {
            bestResult = { listings, query: queryObj.query, level: queryObj.level };
            console.log(`   💾 Saved as backup`);
          }
        } catch (error) {
          console.log(`   ❌ Failed: ${error.message}`);
        }
      }

      if (!bestResult || bestResult.listings.length === 0) {
        return this.emptyResult(searchQuery);
      }

      console.log(`✅ ${bestResult.listings.length} active listings (${bestResult.level})`);
      return this.formatResults(bestResult.listings, searchQuery, bestResult.query, cardDetails);

    } catch (error) {
      console.error('❌ Active Listings Error:', error.message);
      return this.emptyResult(searchQuery, error.message);
    }
  }
  
  buildProgressiveQueries(details) {
    const { year, setName, player, cardNumber, parallel, gradingCompany, grade, sport } = details;
    const queries = [];

    const isPokemon = sport === 'Pokemon' || (setName && setName.toLowerCase().includes('pokemon'));
    const hasGradedParallel = gradingCompany && grade && parallel && parallel !== 'Base';

    if (isPokemon) {
      if (player && cardNumber && gradingCompany && grade) {
        queries.push({
          query: `Pokemon ${player} ${cardNumber} ${gradingCompany} ${grade}`,
          level: 'P1-Full-Graded'
        });
      }
      
      if (player && cardNumber && gradingCompany && grade) {
        queries.push({
          query: `${player} ${cardNumber} ${gradingCompany} ${grade}`,
          level: 'P2-NameNum-Graded'
        });
      }
      
      if (player && cardNumber) {
        queries.push({
          query: `${player} ${cardNumber}`,
          level: 'P3-NameNum'
        });
      }
      
      if (setName && player && cardNumber) {
        const cleanSet = setName.replace(/^Pokemon\s+/i, '');
        queries.push({
          query: `Pokemon ${cleanSet} ${player} ${cardNumber}`,
          level: 'P4-Set-NameNum'
        });
      }
      
      if (player && cardNumber && parallel && parallel !== 'Base') {
        queries.push({
          query: `${player} ${cardNumber} ${parallel}`,
          level: 'P5-NameNum-Parallel'
        });
      }
      
      if (player && gradingCompany && grade) {
        queries.push({
          query: `Pokemon ${player} ${gradingCompany} ${grade}`,
          level: 'P6-Name-Graded'
        });
      }

    } else {
      if (hasGradedParallel) {
        queries.push({
          query: `${year} ${setName} ${player} ${cardNumber} ${parallel} ${gradingCompany} ${grade}`,
          level: 'L1-Full-Strict'
        });
        
        queries.push({
          query: `${setName} ${player} ${cardNumber} ${parallel} ${gradingCompany} ${grade}`,
          level: 'L2-NoYear-Strict'
        });
        
        console.log('🔒 STRICT MODE: Graded parallel card');
        
      } else {
        if (year && setName && player && cardNumber && parallel && parallel !== 'Base' && gradingCompany && grade) {
          queries.push({
            query: `${year} ${setName} ${player} ${cardNumber} ${parallel} ${gradingCompany} ${grade}`,
            level: 'L1-Full'
          });
        }

        if (year && setName && player && cardNumber && gradingCompany && grade && !hasGradedParallel) {
          queries.push({
            query: `${year} ${setName} ${player} ${cardNumber} ${gradingCompany} ${grade}`,
            level: 'L2-Graded'
          });
        }

        if (year && setName && player && cardNumber && parallel && parallel !== 'Base') {
          queries.push({
            query: `${year} ${setName} ${player} ${cardNumber} ${parallel}`,
            level: 'L3-Parallel'
          });
        }

        if (year && setName && player && cardNumber) {
          queries.push({
            query: `${year} ${setName} ${player} ${cardNumber}`,
            level: 'L4-Card'
          });
        }

        if (year && setName && player && !hasGradedParallel) {
          queries.push({
            query: `${year} ${setName} ${player}`,
            level: 'L5-Player'
          });
        }
      }
    }

    return queries;
  }

  formatResults(listings, originalQuery, usedQuery, cardDetails) {
    const yourCard = {
      player: cardDetails.player,
      year: cardDetails.year,
      set_name: cardDetails.setName,
      card_number: cardDetails.cardNumber,
      parallel: cardDetails.parallel,
      grading_company: cardDetails.gradingCompany,
      grade: cardDetails.grade
    };

    const matchedListings = cardMatcher.filterListings(listings, yourCard, 'all');
    const exactMatches = matchedListings.filter(l => l.matchType === 'exact');
    const similarMatches = matchedListings.filter(l => l.matchType === 'similar');
    const differentMatches = matchedListings.filter(l => l.matchType === 'different');

    console.log(`🎯 ${exactMatches.length} exact, ${similarMatches.length} similar, ${differentMatches.length} different`);

    return {
      listings: matchedListings,
      grouped: {
        exact: exactMatches,
        similar: similarMatches,
        different: differentMatches
      },
      stats: {
        total: matchedListings.length,
        exactCount: exactMatches.length,
        similarCount: similarMatches.length,
        differentCount: differentMatches.length,
        exactAvg: exactMatches.length > 0 
          ? (exactMatches.reduce((sum, l) => sum + l.price, 0) / exactMatches.length).toFixed(2)
          : '0.00',
        similarAvg: similarMatches.length > 0
          ? (similarMatches.reduce((sum, l) => sum + l.price, 0) / similarMatches.length).toFixed(2)
          : '0.00'
      },
      searchMetadata: {
        originalQuery,
        usedQuery,
        searchType: 'progressive',
        fallbackUsed: usedQuery !== originalQuery,
        disclaimer: null
      }
    };
  }

  emptyResult(query, error = null) {
    return {
      listings: [],
      grouped: { exact: [], similar: [], different: [] },
      stats: {
        total: 0,
        exactCount: 0,
        similarCount: 0,
        differentCount: 0,
        exactAvg: '0.00',
        similarAvg: '0.00'
      },
      searchMetadata: {
        originalQuery: query,
        usedQuery: query,
        searchType: error ? 'error' : 'none',
        fallbackUsed: false,
        error: error
      }
    };
  }

  // ═══════════════════════════════════════════════════════
  // 🏷️ SELLER API - CREATE LISTINGS
  // ═══════════════════════════════════════════════════════

  async createListing(userToken, listingData) {
    try {
      console.log('🏷️ Creating eBay listing...');
      
      const {
        card,
        title,
        description,
        price: rawPrice,
        quantity = 1,
        condition,
        images = [],
        shippingCost = 4.99,
        useCalculatedShipping = true, // 🔥 NEW: Default to calculated
        packageWeight = 4, // 🔥 NEW: oz
        packageLength = 6,
        packageWidth = 4,
        packageHeight = 1
      } = listingData;
      
      // 🔥 USE USER'S SELECTION (No auto-detection)
// ✅ ENFORCE EBAY MINIMUM PRICE ($0.99 for Buy It Now)
      const price = Math.max(0.99, parseFloat(rawPrice));
      if (price !== parseFloat(rawPrice)) {
        console.log(`⚠️ Price adjusted: $${rawPrice} → $${price} (eBay minimum $0.99)`);
      }

      const finalWeight = packageWeight; // Use exactly what user selected
const finalPackageType = (finalWeight <= 3) ? 'LETTER' : 'PACKAGE_THICK_ENVELOPE';

console.log(`📦 Using user-selected weight: ${finalWeight} oz (${finalPackageType})`);
      
      // Determine correct condition enum based on card type
      // eBay trading cards use special condition IDs:
      // - LIKE_NEW (2750) = Graded card
      // - USED_VERY_GOOD (4000) = Ungraded card
      // Determine if this is a lot listing
const isLotListing = listingData.customSku?.startsWith('LOT-');

let ebayCondition;
if (isLotListing) {
  // Lots category 261329 requires 'USED_EXCELLENT' or just skip condition descriptors
  ebayCondition = 'USED_EXCELLENT';
  console.log('✅ Using USED_EXCELLENT (lot listing condition)');
} else if (card.grading_company && card.grade) {
  ebayCondition = 'LIKE_NEW';  // Graded = condition ID 2750
  console.log('✅ Using LIKE_NEW (graded card condition 2750)');
} else {
  ebayCondition = 'USED_VERY_GOOD';  // Ungraded = condition ID 4000
  console.log('✅ Using USED_VERY_GOOD (ungraded card condition 4000)');
}

      // Step 1: Create Inventory Item
      const sku = `SLABTRACK-${card.id}-${Date.now()}`;
      
      // Build aspects (no Grade in here anymore!)
      const aspects = this.buildAspects(card);
      console.log('📋 Aspects being sent to eBay:', JSON.stringify(aspects, null, 2));
      
      // Build condition descriptors (THIS is where Grade goes now!)
// BUT: Lot categories don't use the same condition descriptors
const isLot = listingData.customSku?.startsWith('LOT-');
const conditionDescriptors = isLot ? [] : this.buildConditionDescriptors(card);
console.log('📋 Condition descriptors being sent to eBay:', JSON.stringify(conditionDescriptors, null, 2));
      
      // Determine package size based on shipping method
      const useStandardEnvelope = listingData.useStandardEnvelope || false;
      const isGraded = !!(card.grading_company && card.grade);
      
      let packageConfig;
      if (useStandardEnvelope) {
        // ✅ eBay Standard Envelope - MUST use proper envelope dimensions
        // Max dimensions: 11.5" x 6.125" x 0.25" per eBay requirements
        packageConfig = {
        dimensions: {
          height: 6.125,    // eBay max height for Standard Envelope
          length: 11.5,     // eBay max length for Standard Envelope  
          width: 0.25,      // CRITICAL: 0.25" for envelope rate
          unit: 'INCH'
        },
        weight: {
          value: 1,         // 1 oz for cheapest PWE rate (~$0.74)
          unit: 'OUNCE'
        }
      };
        console.log('📧 Using eBay Standard Envelope (2oz, 11.5"x6.125"x0.25")');
      } else if (isGraded) {
        // Graded slab - needs box or bubble mailer
        packageConfig = {
          dimensions: {
            height: 8,
            length: 6,
            width: 2,
            unit: 'INCH'
          },
          weight: {
            value: 8,     // ~8 oz for slab + packaging
            unit: 'OUNCE'
          }
        };
        console.log('📦 Using graded slab package dimensions (8oz)');
      } else {
        // Raw card in bubble mailer (BMWT)
        packageConfig = {
          dimensions: {
            height: 6,
            length: 9,
            width: 1,
            unit: 'INCH'
          },
          weight: {
            value: listingData.packageWeight || 4,  // Use provided weight or default 4oz
            unit: 'OUNCE'
          }
        };
        console.log(`📦 Using BMWT package dimensions (${packageConfig.weight.value}oz)`);
      }

      const inventoryItem = {
        availability: {
          shipToLocationAvailability: {
            quantity: quantity
          }
        },
        condition: ebayCondition,
        conditionDescriptors: conditionDescriptors,
        conditionDescription: card.grading_company ? `${card.grading_company} ${card.grade}` : undefined,
        product: {
          title: title.substring(0, 80),
          description: description,
          aspects: aspects,
          imageUrls: images.filter(Boolean).slice(0, 12)
        },
        packageWeightAndSize: packageConfig
      };

      await axios.put(
        `https://api.ebay.com/sell/inventory/v1/inventory_item/${sku}`,
        inventoryItem,
        {
          headers: {
            'Authorization': `Bearer ${userToken}`,
            'Content-Type': 'application/json',
            'Content-Language': 'en-US'
          }
        }
      );

      console.log('✅ Inventory item created:', sku);

      // Step 2: Use location from listingData (passed from routes)
      const locationData = listingData.location || {
        city: 'Dallas',
        stateOrProvince: 'TX',
        postalCode: '75001',
        country: 'US'
      };

      try {
        // First, try to create (if it doesn't exist)
        await axios.post(
          'https://api.ebay.com/sell/inventory/v1/location/default',
          {
            location: {
              address: {
                addressLine1: 'Local Distribution',
                city: locationData.city,
                stateOrProvince: locationData.stateOrProvince,
                postalCode: locationData.postalCode,
                country: locationData.country
              }
            },
            locationTypes: ['WAREHOUSE'],
            merchantLocationStatus: 'ENABLED',
            name: 'SlabTrack Warehouse'
          },
          {
            headers: {
              'Authorization': `Bearer ${userToken}`,
              'Content-Type': 'application/json'
            }
          }
        );
        console.log(`✅ Merchant location created: ${locationData.city}, ${locationData.stateOrProvince}`);
      } catch (locError) {
        if (locError.response?.status === 400 || locError.response?.status === 409) {
          // Location exists - UPDATE it with user's address
          console.log(`ℹ️ Location exists, updating to ${locationData.city}, ${locationData.stateOrProvince}...`);
          try {
            await axios.post(
              'https://api.ebay.com/sell/inventory/v1/location/default/update_location_details',
              {
                location: {
                  address: {
                    addressLine1: 'Local Distribution',
                    city: locationData.city,
                    stateOrProvince: locationData.stateOrProvince,
                    postalCode: locationData.postalCode,
                    country: locationData.country
                  }
                }
              },
              {
                headers: {
                  'Authorization': `Bearer ${userToken}`,
                  'Content-Type': 'application/json'
                }
              }
            );
            console.log(`✅ Merchant location updated to ${locationData.city}, ${locationData.stateOrProvince}`);
          } catch (updateError) {
            console.log('⚠️ Location update error:', updateError.response?.data || updateError.message);
          }
        } else {
          console.log('⚠️ Location error:', locError.response?.data || locError.message);
        }
      }

      // Step 3: Get business policy IDs
const finalShippingCost = listingData.shippingCost || this.DEFAULT_SHIPPING_COST;
const finalHandlingTime = listingData.handlingTime || 3;

// 🔍 DEBUG: Log what we received
console.log('🔍 SHIPPING DEBUG:', {
  finalShippingCost,
  useStandardEnvelope,
  useCalculatedShipping,
  rawShippingCost: listingData.shippingCost
});
      
      // 🔥 Use Standard Envelope, calculated shipping, flat rate, or FREE shipping
      let fulfillmentPolicyId;
      
      // ✅ CHECK FREE SHIPPING FIRST (regardless of other settings)
      if (parseFloat(finalShippingCost) === 0 && !useCalculatedShipping) {
        console.log('🎁 Using FREE SHIPPING (seller absorbs cost)');
        fulfillmentPolicyId = await this.getFulfillmentPolicyByShipping(userToken, 0, finalHandlingTime);
      } else if (useStandardEnvelope) {
        // eBay Standard Envelope - cheap tracking for cards under $20
        console.log('📧 Using STANDARD ENVELOPE shipping (tracking included, ~$0.68-$1.17)');
        fulfillmentPolicyId = await this.getStandardEnvelopePolicy(userToken, listingData.shippingCost || 0, finalHandlingTime);
      } else if (useCalculatedShipping) {
        console.log('📦 Using CALCULATED shipping (buyer pays exact cost)');
        fulfillmentPolicyId = await this.getCalculatedShippingPolicy(userToken, finalWeight, finalPackageType, finalHandlingTime);
      } else {
        console.log(`📦 Using FLAT RATE shipping ($${finalShippingCost})`);
        fulfillmentPolicyId = await this.getFulfillmentPolicyByShipping(userToken, finalShippingCost, finalHandlingTime);
      }
      const paymentPolicyId = await this.getDefaultPaymentPolicy(userToken);

// ✅ Get return policy based on user's selection
const returnsAccepted = listingData.returnsAccepted !== undefined 
  ? listingData.returnsAccepted 
  : false; // Default to NO RETURNS
const returnPeriod = listingData.returnPeriod || 0;

console.log(`↩️ Returns: ${returnsAccepted ? returnPeriod + ' days' : 'Not accepted'}`);

const returnPolicyId = await this.getReturnPolicyBySettings(userToken, returnsAccepted, returnPeriod);

if (!fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId) {
  throw new Error('Business policies not found. Please create policies in eBay Seller Hub.');
}

      // Step 4: Create Offer with business policies + Best Offer
      
      // Best Offer settings (from user preferences or listing override)
      const enableAutoAccept = listingData.enableAutoAccept || false; // OFF by default
      const autoAcceptPercent = listingData.autoAcceptPercent || 90; // 90% default
      
      // Build Best Offer terms
      const bestOfferTerms = {
        bestOfferEnabled: true, // Always allow offers
        autoDeclinePrice: {
          currency: 'USD',
          value: (price * 0.70).toFixed(2) // Always auto-decline below 70%
        }
      };
      
      // Only add auto-accept if user enabled it
      if (enableAutoAccept) {
        bestOfferTerms.autoAcceptPrice = {
          currency: 'USD',
          value: (price * (autoAcceptPercent / 100)).toFixed(2)
        };
        console.log(`✅ Auto-accept enabled at ${autoAcceptPercent}% ($${bestOfferTerms.autoAcceptPrice.value})`);
      } else {
        console.log('ℹ️ Auto-accept disabled - manual review required');
      }
      
      const offer = {
        sku: sku,
        marketplaceId: this.MARKETPLACE_ID,
        format: 'FIXED_PRICE',
        availableQuantity: quantity,
        categoryId: listingData.customSku?.startsWith('LOT-') ? '261329' : this.DEFAULT_CATEGORY_ID,
        listingDescription: description,
        listingDuration: this.LISTING_DURATION,
        merchantLocationKey: this.DEFAULT_LOCATION_KEY,
        pricingSummary: {
          price: {
            currency: 'USD',
            value: price.toString()
          }
        },
        bestOfferTerms: bestOfferTerms,
        listingPolicies: {
          fulfillmentPolicyId: fulfillmentPolicyId,
          paymentPolicyId: paymentPolicyId,
          returnPolicyId: returnPolicyId
        }
      };

      
      console.log('📤 Sending offer to eBay:', JSON.stringify(offer, null, 2));
      
      const offerResponse = await axios.post(
        'https://api.ebay.com/sell/inventory/v1/offer',
        offer,
        {
          headers: {
            'Authorization': `Bearer ${userToken}`,
            'Content-Type': 'application/json',
            'Content-Language': 'en-US'
          }
        }
      );

      const offerId = offerResponse.data.offerId;
      console.log('✅ Offer created:', offerId);

      // Step 5: Publish Listing
      const publishResponse = await axios.post(
        `https://api.ebay.com/sell/inventory/v1/offer/${offerId}/publish`,
        {},
        {
          headers: {
            'Authorization': `Bearer ${userToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const listingId = publishResponse.data.listingId;
      const ebayUrl = `https://www.ebay.com/itm/${listingId}`;

      console.log('✅ Listing published:', ebayUrl);

      return {
        success: true,
        sku: sku,
        offerId: offerId,
        listingId: listingId,
        listingUrl: ebayUrl
      };

    } catch (error) {
      console.error('❌ Create listing error:', JSON.stringify(error.response?.data, null, 2));
      
      if (error.response?.data?.errors) {
        error.response.data.errors.forEach((err, idx) => {
          console.error(`Error ${idx + 1}:`, {
            errorId: err.errorId,
            domain: err.domain,
            message: err.message,
            longMessage: err.longMessage,
            parameters: err.parameters
          });
        });
      }
      
      return {
        success: false,
        error: error.response?.data?.errors?.[0]?.longMessage || error.response?.data?.errors?.[0]?.message || error.message,
        details: error.response?.data
      };
    }
  }

  // ═══════════════════════════════════════════════════════
  // 🔨 AUCTION LISTING - CREATE AUCTION
  // ═══════════════════════════════════════════════════════

  async createAuctionListing(userToken, listingData) {
    try {
      console.log('🔨 Creating eBay AUCTION listing...');
      
      const {
        card,
        title,
        description,
        startPrice: rawStartPrice,           // Starting bid (e.g., $0.99, $9.99, $25.00)
        reservePrice: rawReservePrice,       // Hidden minimum (optional)
        buyItNowPrice: rawBuyItNowPrice,     // Instant purchase (optional)
        duration,             // 'DAYS_3', 'DAYS_5', 'DAYS_7', 'DAYS_10'
        quantity = 1,
        condition,
        images = [],
        shippingCost = 4.99,
        useCalculatedShipping = true,
        packageWeight = 4,
        packageLength = 6,
        packageWidth = 4,
        packageHeight = 1
      } = listingData;

      // ✅ ENFORCE EBAY MINIMUM PRICES
      // Auction start: $0.01 minimum
      // Reserve: $0.99 minimum (if used)
      // Buy It Now: $0.99 minimum (if used)
      const startPrice = Math.max(0.01, parseFloat(rawStartPrice));
      const reservePrice = rawReservePrice ? Math.max(0.99, parseFloat(rawReservePrice)) : null;
      const buyItNowPrice = rawBuyItNowPrice ? Math.max(0.99, parseFloat(rawBuyItNowPrice)) : null;
      
      if (startPrice !== parseFloat(rawStartPrice)) {
        console.log(`⚠️ Start price adjusted: $${rawStartPrice} → $${startPrice} (eBay minimum $0.01)`);
      }

      console.log(`🔨 Auction Settings:
  Starting Bid: $${startPrice}
  Reserve Price: ${reservePrice ? '$' + reservePrice : 'None'}
  Buy It Now: ${buyItNowPrice ? '$' + buyItNowPrice : 'None'}
  Duration: ${duration}`);
      
      // Package configuration (same as fixed price)
      const finalWeight = packageWeight;
      const finalPackageType = (finalWeight <= 3) ? 'LETTER' : 'PACKAGE_THICK_ENVELOPE';
      console.log(`📦 Using user-selected weight: ${finalWeight} oz (${finalPackageType})`);
      
      // Determine condition
      const isLotListing = listingData.customSku?.startsWith('LOT-');
      let ebayCondition;
      if (isLotListing) {
        ebayCondition = 'USED_EXCELLENT';
        console.log('✅ Using USED_EXCELLENT (lot listing condition)');
      } else if (card.grading_company && card.grade) {
        ebayCondition = 'LIKE_NEW';
        console.log('✅ Using LIKE_NEW (graded card condition 2750)');
      } else {
        ebayCondition = 'USED_VERY_GOOD';
        console.log('✅ Using USED_VERY_GOOD (ungraded card condition 4000)');
      }

      // Step 1: Create Inventory Item
      const sku = `SLABTRACK-AUCTION-${card.id}-${Date.now()}`;
      
      const aspects = this.buildAspects(card);
      const isLot = listingData.customSku?.startsWith('LOT-');
      const conditionDescriptors = isLot ? [] : this.buildConditionDescriptors(card);
      
      // Package configuration
      const useStandardEnvelope = listingData.useStandardEnvelope || false;
      const isGraded = !!(card.grading_company && card.grade);
      
      let packageConfig;
      if (useStandardEnvelope) {
        packageConfig = {
          dimensions: { height: 6, length: 9, width: 0.25, unit: 'INCH' },
          weight: { value: 2, unit: 'OUNCE' }
        };
      } else if (isGraded) {
        packageConfig = {
          dimensions: { height: 8, length: 6, width: 2, unit: 'INCH' },
          weight: { value: 8, unit: 'OUNCE' }
        };
      } else {
        packageConfig = {
          dimensions: { height: 6, length: 9, width: 1, unit: 'INCH' },
          weight: { value: listingData.packageWeight || 4, unit: 'OUNCE' }
        };
      }

      const inventoryItem = {
        availability: {
          shipToLocationAvailability: {
            quantity: quantity
          }
        },
        condition: ebayCondition,
        conditionDescriptors: conditionDescriptors,
        conditionDescription: card.grading_company ? `${card.grading_company} ${card.grade}` : undefined,
        product: {
          title: title.substring(0, 80),
          description: description,
          aspects: aspects,
          imageUrls: images.filter(Boolean).slice(0, 12)
        },
        packageWeightAndSize: packageConfig
      };

      await axios.put(
        `https://api.ebay.com/sell/inventory/v1/inventory_item/${sku}`,
        inventoryItem,
        {
          headers: {
            'Authorization': `Bearer ${userToken}`,
            'Content-Type': 'application/json',
            'Content-Language': 'en-US'
          }
        }
      );

      console.log('✅ Inventory item created:', sku);

      // Step 2: Location setup (same as fixed price)
      const locationData = listingData.location || {
        city: 'Dallas',
        stateOrProvince: 'TX',
        postalCode: '75001',
        country: 'US'
      };

      try {
        await axios.post(
          'https://api.ebay.com/sell/inventory/v1/location/default',
          {
            location: {
              address: {
                addressLine1: 'Local Distribution',
                city: locationData.city,
                stateOrProvince: locationData.stateOrProvince,
                postalCode: locationData.postalCode,
                country: locationData.country
              }
            },
            locationTypes: ['WAREHOUSE'],
            merchantLocationStatus: 'ENABLED',
            name: 'SlabTrack Warehouse'
          },
          {
            headers: {
              'Authorization': `Bearer ${userToken}`,
              'Content-Type': 'application/json'
            }
          }
        );
      } catch (locError) {
        if (locError.response?.status === 400 || locError.response?.status === 409) {
          console.log(`ℹ️ Location exists, updating...`);
        }
      }

      // Step 3: Get business policies
      const finalShippingCost = listingData.shippingCost || this.DEFAULT_SHIPPING_COST;
      const finalHandlingTime = listingData.handlingTime || 3;
      
      console.log('🚢 SHIPPING DEBUG:', {
        useStandardEnvelope,
        useCalculatedShipping,
        shippingCost: finalShippingCost,
        packageWeight: finalWeight
      });
      
      let fulfillmentPolicyId;
      
      // Check Standard Envelope FIRST (highest priority)
      if (useStandardEnvelope) {
        console.log('📧 Using eBay Standard Envelope (PWE with tracking)');
        fulfillmentPolicyId = await this.getStandardEnvelopePolicy(userToken, listingData.shippingCost || 0.74, finalHandlingTime);
      } 
      // Check Free Shipping
      else if (parseFloat(finalShippingCost) === 0 && !useCalculatedShipping) {
        console.log('🎁 Using FREE SHIPPING');
        fulfillmentPolicyId = await this.getFulfillmentPolicyByShipping(userToken, 0, finalHandlingTime);
      } 
      // Check Calculated Shipping
      else if (useCalculatedShipping) {
        console.log('📦 Using CALCULATED shipping');
        fulfillmentPolicyId = await this.getCalculatedShippingPolicy(userToken, finalWeight, finalPackageType, finalHandlingTime);
      } 
      // Default to Flat Rate
      else {
        console.log(`💵 Using FLAT RATE shipping: $${finalShippingCost}`);
        fulfillmentPolicyId = await this.getFulfillmentPolicyByShipping(userToken, finalShippingCost, finalHandlingTime);
      }
      
      const paymentPolicyId = await this.getAuctionPaymentPolicy(userToken);
      
      const returnsAccepted = listingData.returnsAccepted !== undefined ? listingData.returnsAccepted : false;
      const returnPeriod = listingData.returnPeriod || 0;
      const returnPolicyId = await this.getReturnPolicyBySettings(userToken, returnsAccepted, returnPeriod);

      if (!fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId) {
        throw new Error('Business policies not found. Please create policies in eBay Seller Hub.');
      }

      // Step 4: Create AUCTION Offer
      const offer = {
        sku: sku,
        marketplaceId: this.MARKETPLACE_ID,
        format: 'AUCTION',  // 🔥 THIS IS THE KEY DIFFERENCE
        // 🔥 NOTE: Auctions don't use availableQuantity (always 1 by nature)
        categoryId: listingData.customSku?.startsWith('LOT-') ? '261329' : this.DEFAULT_CATEGORY_ID,
        listingDescription: description,
        listingDuration: duration,  // 🔥 DAYS_3, DAYS_5, DAYS_7, DAYS_10
        merchantLocationKey: this.DEFAULT_LOCATION_KEY,
        pricingSummary: {
          auctionStartPrice: {  // 🔥 Starting bid instead of fixed price
            currency: 'USD',
            value: startPrice.toString()
          }
        },
        listingPolicies: {
          fulfillmentPolicyId: fulfillmentPolicyId,
          paymentPolicyId: paymentPolicyId,
          returnPolicyId: returnPolicyId
        }
      };

      // 🔥 Add reserve price if specified
      if (reservePrice) {
        offer.pricingSummary.auctionReservePrice = {
          currency: 'USD',
          value: reservePrice.toString()
        };
      }

      // 🔥 Add Buy It Now if specified (goes in pricingSummary for auctions)
      if (buyItNowPrice) {
        offer.pricingSummary.buyItNowPrice = {
          currency: 'USD',
          value: buyItNowPrice.toString()
        };
      }

      console.log('📤 Sending auction offer to eBay:', JSON.stringify(offer, null, 2));
      
      const offerResponse = await axios.post(
        'https://api.ebay.com/sell/inventory/v1/offer',
        offer,
        {
          headers: {
            'Authorization': `Bearer ${userToken}`,
            'Content-Type': 'application/json',
            'Content-Language': 'en-US'
          }
        }
      );

      const offerId = offerResponse.data.offerId;
      console.log('✅ Auction offer created:', offerId);

      // Step 5: Publish Auction
      const publishResponse = await axios.post(
        `https://api.ebay.com/sell/inventory/v1/offer/${offerId}/publish`,
        {},
        {
          headers: {
            'Authorization': `Bearer ${userToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const listingId = publishResponse.data.listingId;
      const ebayUrl = `https://www.ebay.com/itm/${listingId}`;

      console.log('✅ Auction published:', ebayUrl);

      return {
        success: true,
        sku: sku,
        offerId: offerId,
        listingId: listingId,
        listingUrl: ebayUrl
      };

    } catch (error) {
      console.error('❌ Create auction error:', error);
      console.error('❌ Error stack:', error.stack);
      console.error('❌ Error message:', error.message);
      
      if (error.response?.data) {
        console.error('❌ eBay API Response:', JSON.stringify(error.response.data, null, 2));
        
        if (error.response.data.errors) {
          error.response.data.errors.forEach((err, idx) => {
            console.error(`Error ${idx + 1}:`, {
              errorId: err.errorId,
              domain: err.domain,
              message: err.message,
              longMessage: err.longMessage,
              parameters: err.parameters
            });
          });
        }
      }
      
      return {
        success: false,
        error: error.response?.data?.errors?.[0]?.longMessage || error.response?.data?.errors?.[0]?.message || error.message || 'Unknown error',
        details: error.response?.data
      };
    }
  }

  buildAspects(card) {
    console.log('🏗️ Building aspects for card:', card.id);
    
    
    // Determine sport/game
    const sport = card.sport || 'Football';
    const isPokemon = sport === 'Pokemon';
    const game = isPokemon ? 'Non-Sport Trading Card' : sport;
    
    // Start with required base aspects
    const aspects = {
      'Sport': [sport],
      'Game': [game],
      'Card Name': [card.player || 'Unknown Player'],
      'Type': [isPokemon ? 'Non-Sport Trading Card' : 'Sports Trading Card'],
      'Player/Athlete': [card.player || 'Unknown'],
      'Card Number': [card.card_number?.toString() || 'N/A']
    };
    
    // Add year
    if (card.year) {
      aspects['Year'] = [card.year.toString()];
    }
    
    // Add set (clean format)
    if (card.set_name) {
      const cleanSet = card.set_name.replace(/^\d{4}\s+/, '');
      aspects['Set'] = [cleanSet];
    }
    
    // Add team
    if (card.team) {
      aspects['Team'] = [card.team];
    }
    
    // Add league (if available in DB)
    if (card.league) {
      aspects['League'] = [card.league];
    }
    
    // Add manufacturer
    if (card.manufacturer || card.set_name) {
      const manufacturer = card.manufacturer || card.set_name.split(' ')[1] || 'Panini';
      aspects['Manufacturer'] = [manufacturer];
    }
    
    // Add parallel/variety
    if (card.parallel && card.parallel !== 'Base') {
      aspects['Parallel/Variety'] = [card.parallel];
    }
    
    // Build features array
    const features = [];
    if (card.is_autographed) {
      features.push('Autographed');
    }
    if (card.numbered === 'true' || card.serial_number) {
      features.push('Numbered');
    }
    if (card.is_rookie) {
      features.push('Rookie');
    }
    if (card.is_insert) {
      features.push('Insert');
    }
    if (features.length > 0) {
      aspects['Features'] = features;
    }
    
    // Add serial number if available
    if (card.serial_number) {
      aspects['Serial Number'] = [card.serial_number];
    }
    
    // GRADING INFO - Don't put Grade in aspects anymore!
    // Grade now goes in conditionDescriptors (new eBay requirement for trading cards)
    if (card.grading_company && card.grade) {
      aspects['Graded'] = ['Yes'];
      // DON'T add Grade here - it will go in conditionDescriptors
      
      if (card.cert_number) {
        aspects['Certification Number'] = [card.cert_number.toString()];
      }
    } else {
      aspects['Graded'] = ['No'];
      // DON'T add Grade here - it will go in conditionDescriptors
    }
    
    // Filter out null/undefined values
    const cleanedAspects = {};
    for (const [key, value] of Object.entries(aspects)) {
      if (value && Array.isArray(value) && value.length > 0 && value[0]) {
        cleanedAspects[key] = value;
      }
    }
    
    console.log('✅ Built aspects:', Object.keys(cleanedAspects).length, 'fields');
    return cleanedAspects;
  }

  buildConditionDescriptors(card) {
    console.log('🏗️ Building condition descriptors for card:', card.id);
    
    const descriptors = [];
    
    if (card.grading_company && card.grade) {
      // ═══════════════════════════════════════════════════════
      // GRADED CARD - Use eBay's new condition descriptor system
      // ═══════════════════════════════════════════════════════
      // Normalize grading company
const rawGrader = (card.grading_company || '').toUpperCase().trim();

// Map grading company to eBay's descriptor value IDs (27501 values)
const graderMap = {
  'PSA': '275010',
  'PROFESSIONAL SPORTS AUTHENTICATOR (PSA)': '275010',
  'BCCG': '275011',
  'BECKETT COLLECTORS CLUB GRADING (BCCG)': '275011',
  'BVG': '275012',
  'BECKETT VINTAGE GRADING (BVG)': '275012',
  'BGS': '275013',
  'BECKETT GRADING SERVICES (BGS)': '275013',
  'CSG': '275014',
  'CERTIFIED SPORTS GUARANTY (CSG)': '275014',
  'CGC': '275015',
  'CERTIFIED GUARANTY COMPANY (CGC)': '275015',
  'SGC': '275016',
  'SPORTSCARD GUARANTY CORPORATION (SGC)': '275016',
  'KSA': '275017',
  'GMA': '275018',
  'HGA': '275019',
  'ISA': '2750110',
  'PCA': '2750111',
  'GSG': '2750112',
  'PGS': '2750113',
  'MNT': '2750114',
  'TAG': '2750115',
  'RARE': '2750116',
  'RCG': '2750117',
  'PCG': '2750118',
  'ACE': '2750119',
  'CGA': '2750120',
  'TCG': '2750121',
  'ARK': '2750122'
};

const graderValue = graderMap[rawGrader] || '2750123'; // 2750123 = "Other"

      // Professional Grader (descriptor 27501)
      descriptors.push({
        name: '27501',
        values: [graderValue]
      });
      
      // Grade (descriptor 27502) - Map numerical grade to eBay's value ID
      const gradeMap = {
        '10': '275020',
        '9.5': '275021',
        '9': '275022',
        '8.5': '275023',
        '8': '275024',
        '7.5': '275025',
        '7': '275026',
        '6.5': '275027',
        '6': '275028',
        '5.5': '275029',
        '5': '275030',
        '4.5': '275031',
        '4': '275032',
        '3.5': '275033',
        '3': '275034',
        '2.5': '275035',
        '2': '275036',
        '1.5': '275037',
        '1': '275038'
      };
      
      const gradeValue = gradeMap[card.grade.toString()] || '275020';
      
      descriptors.push({
        name: '27502',
        values: [gradeValue]
      });
      
      // Certification Number (descriptor 27503) - Optional
      if (card.cert_number) {
        descriptors.push({
          name: '27503',
          additionalInfo: card.cert_number.toString()
        });
      }
      
    } else {
      // ═══════════════════════════════════════════════════════
      // RAW/UNGRADED CARD - Use Card Condition descriptor
      // ═══════════════════════════════════════════════════════
      console.log('   → Raw card detected');
      
      // Map condition to eBay's Card Condition descriptor (40001)
      const conditionMap = {
        'MINT': '400010',           // Near Mint or Better
        'NEAR_MINT': '400010',      // Near Mint or Better
        'EXCELLENT': '400011',      // Excellent
        'VERY_GOOD': '400012',      // Very Good
        'GOOD': '400013',           // Good
        'FAIR': '400014',           // Fair
        'POOR': '400015',           // Poor
        'NEW': '400010',
        'LIKE_NEW': '400010',
        'USED_EXCELLENT': '400011',
        'USED_VERY_GOOD': '400012',
        'USED_GOOD': '400013'
      };
      
      const cardCondition = card.condition?.toUpperCase() || 'NEAR_MINT';
      const conditionValue = conditionMap[cardCondition] || '400010';
      
      // Card Condition (descriptor 40001)
      descriptors.push({
        name: '40001',
        values: [conditionValue]
      });
    }
    
    console.log('✅ Built condition descriptors:', descriptors.length, 'descriptors');
    console.log('📋 Descriptors:', JSON.stringify(descriptors, null, 2));
    return descriptors;
  }

  // ═══════════════════════════════════════════════════════
  // 📋 BUSINESS POLICIES
  // ═══════════════════════════════════════════════════════

  async getFulfillmentPolicyByShipping(userToken, shippingCost, handlingTime = 3) {
    try {
      console.log(`🔍 Looking for fulfillment policy with $${shippingCost} shipping...`);
      
      const response = await axios.get(
        'https://api.ebay.com/sell/account/v1/fulfillment_policy',
        {
          params: { marketplace_id: this.MARKETPLACE_ID },
          headers: { 'Authorization': `Bearer ${userToken}` }
        }
      );

      const policies = response.data.fulfillmentPolicies || [];
      
      // ✅ SPECIAL HANDLING FOR FREE SHIPPING
      if (parseFloat(shippingCost) === 0) {
        const freePolicy = policies.find(p => {
          const isFree = p.shippingOptions?.[0]?.shippingServices?.[0]?.freeShipping === true;
          const cost = parseFloat(p.shippingOptions?.[0]?.shippingServices?.[0]?.shippingCost?.value || 0);
          return isFree && cost === 0;
        });
        
        if (freePolicy) {
          console.log(`✅ Found existing free shipping policy: ${freePolicy.name}`);
          return freePolicy.fulfillmentPolicyId;
        }
        
        console.log(`🆕 Creating new FREE shipping policy...`);
        return await this.createFreeShippingPolicy(userToken, handlingTime);
      }
      
      // Look for a policy matching this shipping cost (non-free)
      const matchingPolicy = policies.find(p => {
        const policyShippingCost = p.shippingOptions?.[0]?.shippingServices?.[0]?.shippingCost?.value;
        return parseFloat(policyShippingCost) === parseFloat(shippingCost);
      });
      
      if (matchingPolicy) {
        console.log(`✅ Found existing policy: ${matchingPolicy.name} ($${shippingCost})`);
        return matchingPolicy.fulfillmentPolicyId;
      }
      
      // Create new policy for this shipping cost
      console.log(`🆕 Creating new policy for $${shippingCost} shipping...`);
      return await this.createFulfillmentPolicyForShipping(userToken, shippingCost, handlingTime);
      
    } catch (error) {
      console.error('Error getting fulfillment policy:', error.response?.status, error.message);
      
      if (error.response?.status === 400 || error.response?.status === 403) {
        console.log('⚠️ User not eligible for business policies');
        return null;
      }
      
      throw error;
    }
  }

  async createFulfillmentPolicyForShipping(userToken, shippingCost, handlingTime = 3, useStandardEnvelope = false) {
    const cost = parseFloat(shippingCost);
    
    // eBay Standard Envelope - special handling
    if (useStandardEnvelope) {
      return await this.createStandardEnvelopePolicy(userToken, cost, handlingTime);
    }
    
    const policyName = cost === 0 ? 'SlabTrack Free Shipping' :
                       cost === 1.00 ? 'SlabTrack PWE - $1.00' :
                       cost === 4.99 ? 'SlabTrack BMWT - $4.99' :
                       cost === 8.99 ? 'SlabTrack Priority - $8.99' :
                       `SlabTrack - $${cost}`;
    
    const serviceCode = cost === 8.99 ? 'USPSPriority' : 'USPSFirstClass';
    
    const policy = {
      name: policyName,
      marketplaceId: this.MARKETPLACE_ID,
      categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
      handlingTime: { value: handlingTime, unit: 'DAY' },
      shippingOptions: [{
        optionType: 'DOMESTIC',
        costType: 'FLAT_RATE',
        shippingServices: [{
          shippingServiceCode: serviceCode,
          shippingCost: { value: cost.toFixed(2), currency: 'USD' },
          freeShipping: cost === 0
        }]
      }]
    };

    const response = await axios.post(
      'https://api.ebay.com/sell/account/v1/fulfillment_policy',
      policy,
      {
        headers: {
          'Authorization': `Bearer ${userToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`✅ Created policy: ${policyName}`);
    return response.data.fulfillmentPolicyId;
  }

  async getCalculatedShippingPolicy(userToken, weight, packageType, handlingTime = 3) {
    try {
      console.log(`🔍 Looking for calculated shipping policy (${weight}oz, ${packageType})...`);
      
      const response = await axios.get(
        'https://api.ebay.com/sell/account/v1/fulfillment_policy',
        {
          params: { marketplace_id: this.MARKETPLACE_ID },
          headers: { 'Authorization': `Bearer ${userToken}` }
        }
      );

      const policies = response.data.fulfillmentPolicies || [];
      
      // Look for existing calculated shipping policy
      const calculatedPolicy = policies.find(p => 
        p.shippingOptions?.[0]?.costType === 'CALCULATED'
      );
      
      if (calculatedPolicy) {
        console.log(`✅ Found existing calculated policy: ${calculatedPolicy.name}`);
        return calculatedPolicy.fulfillmentPolicyId;
      }
      
      // Create new calculated shipping policy
      console.log(`🆕 Creating calculated shipping policy...`);
      return await this.createCalculatedShippingPolicy(userToken, weight, packageType, handlingTime);
      
    } catch (error) {
      console.error('Error getting calculated shipping policy:', error.response?.status, error.message);
      throw error;
    }
  }

  async createCalculatedShippingPolicy(userToken, weight, packageType, handlingTime = 3) {
    const policy = {
      name: 'SlabTrack Calculated Shipping',
      marketplaceId: this.MARKETPLACE_ID,
      categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
      handlingTime: { value: handlingTime, unit: 'DAY' },
      shippingOptions: [{
        optionType: 'DOMESTIC',
        costType: 'CALCULATED', // 🔥 Buyer pays actual USPS cost
        packageHandlingCost: {
          value: '0.00',
          currency: 'USD'
        },
        // 🔥 Package dimensions for USPS calculation
        shippingPackageDetails: {
          packageType: packageType,
          weight: {
            value: weight,
            unit: 'OUNCE'
          },
          dimensions: {
            length: 6,
            width: 4,
            height: 1,
            unit: 'INCH'
          }
        },
        shippingServices: [
  {
    shippingCarrierCode: 'USPS',
    shippingServiceCode: 'USPSFirstClass',
    freeShipping: false,
    buyerResponsibleForShipping: true,
    sortOrder: 1
  },
  {
    shippingCarrierCode: 'USPS',
    shippingServiceCode: 'USPSPriority',
    freeShipping: false,
    buyerResponsibleForShipping: true,
    sortOrder: 2
  }
]
      }]
    };

    const response = await axios.post(
      'https://api.ebay.com/sell/account/v1/fulfillment_policy',
      policy,
      {
        headers: {
          'Authorization': `Bearer ${userToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`✅ Created calculated shipping policy`);
    return response.data.fulfillmentPolicyId;
  }

  async createFreeShippingPolicy(userToken, handlingTime = 3) {
    console.log('🎁 Creating FREE shipping policy...');
    
    const policy = {
      name: 'SlabTrack Free Shipping',
      marketplaceId: this.MARKETPLACE_ID,
      categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
      handlingTime: { value: handlingTime, unit: 'DAY' },
      shippingOptions: [{
        optionType: 'DOMESTIC',
        costType: 'FLAT_RATE',
        shippingServices: [{
          shippingServiceCode: 'USPSFirstClass',
          shippingCost: { value: '0.00', currency: 'USD' },
          freeShipping: true,
          sortOrder: 1
        }]
      }]
    };

    try {
      const response = await axios.post(
        'https://api.ebay.com/sell/account/v1/fulfillment_policy',
        policy,
        {
          headers: {
            'Authorization': `Bearer ${userToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log(`✅ Created free shipping policy`);
      return response.data.fulfillmentPolicyId;
    } catch (error) {
      console.error('❌ Free shipping policy error:', error.response?.data || error.message);
      throw error;
    }
  }

  async createStandardEnvelopePolicy(userToken, shippingCost = 0, handlingTime = 3) {
    console.log('📧 Creating eBay Standard Envelope policy...');
    
    const cost = parseFloat(shippingCost);
    const policyName = cost === 0 ? 'SlabTrack Standard Envelope - Free' : `SlabTrack Standard Envelope - $${cost.toFixed(2)}`;
    
    const policy = {
      name: policyName,
      marketplaceId: this.MARKETPLACE_ID,
      categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
      handlingTime: { value: handlingTime, unit: 'DAY' },
      shippingOptions: [{
        optionType: 'DOMESTIC',
        costType: 'FLAT_RATE',
        // ✅ ADD PACKAGE DETAILS FOR STANDARD ENVELOPE
        shippingPackageDetails: {
          packageType: 'LETTER',
          weight: {
            value: 1,
            unit: 'OUNCE'
          },
          dimensions: {
            length: 11.5,
            width: 6.125,
            height: 0.25,
            unit: 'INCH'
          }
        },
        shippingServices: [{
          shippingCarrierCode: 'USPS',
          shippingServiceCode: 'US_eBayStandardEnvelope',
          shippingCost: { value: cost.toFixed(2), currency: 'USD' },
          freeShipping: cost === 0,
          sortOrder: 1
        }]
      }]
    };

    try {
      const response = await axios.post(
        'https://api.ebay.com/sell/account/v1/fulfillment_policy',
        policy,
        {
          headers: {
            'Authorization': `Bearer ${userToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log(`✅ Created Standard Envelope policy: ${policyName}`);
      return response.data.fulfillmentPolicyId;
    } catch (error) {
      console.error('❌ Standard Envelope policy error:', error.response?.data || error.message);
      throw error;
    }
  }

  async getStandardEnvelopePolicy(userToken, shippingCost = 0, handlingTime = 3) {
    try {
      console.log('🔍 Looking for Standard Envelope policy...');
      
      const response = await axios.get(
        'https://api.ebay.com/sell/account/v1/fulfillment_policy',
        {
          params: { marketplace_id: this.MARKETPLACE_ID },
          headers: { 'Authorization': `Bearer ${userToken}` }
        }
      );

      const policies = response.data.fulfillmentPolicies || [];
      
      // Look for existing Standard Envelope policy
      const sePolicy = policies.find(p => 
        p.shippingOptions?.[0]?.shippingServices?.[0]?.shippingServiceCode === 'US_eBayStandardEnvelope'
      );
      
      if (sePolicy) {
        console.log(`✅ Found existing Standard Envelope policy: ${sePolicy.name}`);
        return sePolicy.fulfillmentPolicyId;
      }
      
      // Create new Standard Envelope policy
      console.log('🆕 Creating Standard Envelope policy...');
      return await this.createStandardEnvelopePolicy(userToken, shippingCost, handlingTime);
      
    } catch (error) {
      console.error('Error getting Standard Envelope policy:', error.response?.status, error.message);
      throw error;
    }
  }

  async createDefaultFulfillmentPolicy(userToken) {
    const policy = {
      name: 'SlabTrack Standard Shipping',
      marketplaceId: this.MARKETPLACE_ID,
      categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
      handlingTime: { value: this.DEFAULT_HANDLING_TIME, unit: 'BUSINESS_DAY' },
      shippingOptions: [{
        optionType: 'DOMESTIC',
        costType: 'FLAT_RATE',
        shippingServices: [{
          shippingServiceCode: 'USPSPriority',
          shippingCost: { value: this.DEFAULT_SHIPPING_COST.toString(), currency: 'USD' },
          freeShipping: false
        }]
      }]
    };

    const response = await axios.post(
      'https://api.ebay.com/sell/account/v1/fulfillment_policy',
      policy,
      {
        headers: {
          'Authorization': `Bearer ${userToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data.fulfillmentPolicyId;
  }

  async getDefaultPaymentPolicy(userToken) {
    try {
      const response = await axios.get(
        'https://api.ebay.com/sell/account/v1/payment_policy',
        {
          params: { marketplace_id: this.MARKETPLACE_ID },
          headers: { 'Authorization': `Bearer ${userToken}` }
        }
      );

      if (response.data.paymentPolicies?.length > 0) {
        return response.data.paymentPolicies[0].paymentPolicyId;
      }

      return await this.createDefaultPaymentPolicy(userToken);
    } catch (error) {
      console.error('Error getting payment policy:', error.response?.status, error.message);
      if (error.response?.status === 400 || error.response?.status === 403) {
        return null;
      }
      throw error;
    }
  }

  async getAuctionPaymentPolicy(userToken) {
    try {
      console.log('🔍 Looking for auction payment policy (no immediate payment)...');
      
      const response = await axios.get(
        'https://api.ebay.com/sell/account/v1/payment_policy',
        {
          params: { marketplace_id: this.MARKETPLACE_ID },
          headers: { 'Authorization': `Bearer ${userToken}` }
        }
      );

      const policies = response.data.paymentPolicies || [];
      
      // Look for a policy WITHOUT immediate payment
      const auctionPolicy = policies.find(p => p.immediatePay === false);
      
      if (auctionPolicy) {
        console.log(`✅ Found auction payment policy: ${auctionPolicy.name}`);
        return auctionPolicy.paymentPolicyId;
      }

      // Create new auction payment policy
      console.log('🆕 Creating auction payment policy...');
      return await this.createAuctionPaymentPolicy(userToken);
      
    } catch (error) {
      console.error('❌ GET AUCTION PAYMENT POLICY FAILED:');
      console.error('   Status:', error.response?.status);
      console.error('   eBay Error:', JSON.stringify(error.response?.data, null, 2));
      throw error; // 🔥 DON'T RETURN NULL - THROW THE ERROR SO WE SEE IT
    }
  }

  async createAuctionPaymentPolicy(userToken) {
    try {
      const policy = {
        name: 'SlabTrack Auction Payment',
        marketplaceId: this.MARKETPLACE_ID,
        categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
        immediatePay: false
      };

      console.log('📤 Creating auction payment policy:', JSON.stringify(policy, null, 2));

      const response = await axios.post(
        'https://api.ebay.com/sell/account/v1/payment_policy',
        policy,
        {
          headers: {
            'Authorization': `Bearer ${userToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('✅ Created auction payment policy:', response.data.paymentPolicyId);
      return response.data.paymentPolicyId;
    } catch (error) {
      console.error('❌ CREATE AUCTION PAYMENT POLICY ERROR:');
      console.error('Status:', error.response?.status);
      console.error('eBay Response:', JSON.stringify(error.response?.data, null, 2));
      throw error;
    }
  }

  async createDefaultPaymentPolicy(userToken) {
    const policy = {
      name: 'SlabTrack Immediate Payment',
      marketplaceId: this.MARKETPLACE_ID,
      categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
      paymentMethods: [{
        paymentMethodType: 'PAYPAL'
      }],
      immediatePay: true
    };

    const response = await axios.post(
      'https://api.ebay.com/sell/account/v1/payment_policy',
      policy,
      {
        headers: {
          'Authorization': `Bearer ${userToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data.paymentPolicyId;
  }

  async getDefaultReturnPolicy(userToken) {
    try {
      const response = await axios.get(
        'https://api.ebay.com/sell/account/v1/return_policy',
        {
          params: { marketplace_id: this.MARKETPLACE_ID },
          headers: { 'Authorization': `Bearer ${userToken}` }
        }
      );

      if (response.data.returnPolicies?.length > 0) {
        return response.data.returnPolicies[0].returnPolicyId;
      }

      return await this.createDefaultReturnPolicy(userToken);
    } catch (error) {
      console.error('Error getting return policy:', error.response?.status, error.message);
      if (error.response?.status === 400 || error.response?.status === 403) {
        return null;
      }
      throw error;
    }
  }

  async getReturnPolicyBySettings(userToken, returnsAccepted, returnPeriod) {
    try {
      console.log(`🔍 Looking for return policy: ${returnsAccepted ? returnPeriod + ' days' : 'No returns'}...`);
      
      const response = await axios.get(
        'https://api.ebay.com/sell/account/v1/return_policy',
        {
          params: { marketplace_id: this.MARKETPLACE_ID },
          headers: { 'Authorization': `Bearer ${userToken}` }
        }
      );

      const policies = response.data.returnPolicies || [];
      
      if (!returnsAccepted || returnPeriod === 0) {
        // Look for NO RETURNS policy
        const noReturnsPolicy = policies.find(p => p.returnsAccepted === false);
        
        if (noReturnsPolicy) {
          console.log(`✅ Found existing no returns policy: ${noReturnsPolicy.name}`);
          return noReturnsPolicy.returnPolicyId;
        }
        
        console.log(`🆕 Creating no returns policy...`);
        return await this.createReturnPolicy(userToken, false, 0);
      } else {
        // Look for matching returns period
        const matchingPolicy = policies.find(p => 
          p.returnsAccepted === true && 
          p.returnPeriod?.value === returnPeriod
        );
        
        if (matchingPolicy) {
          console.log(`✅ Found existing ${returnPeriod}-day returns policy: ${matchingPolicy.name}`);
          return matchingPolicy.returnPolicyId;
        }
        
        console.log(`🆕 Creating ${returnPeriod}-day returns policy...`);
        return await this.createReturnPolicy(userToken, true, returnPeriod);
      }
      
    } catch (error) {
      console.error('Error getting return policy:', error.response?.status, error.message);
      if (error.response?.status === 400 || error.response?.status === 403) {
        return null;
      }
      throw error;
    }
  }

  async createReturnPolicy(userToken, returnsAccepted, returnPeriod) {
    const policyName = returnsAccepted 
      ? `SlabTrack ${returnPeriod}-Day Returns`
      : 'SlabTrack No Returns';
    
    const policy = {
      name: policyName,
      marketplaceId: this.MARKETPLACE_ID,
      categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
      returnsAccepted: returnsAccepted
    };
    
    if (returnsAccepted && returnPeriod > 0) {
      policy.returnPeriod = { value: returnPeriod, unit: 'DAY' };
      policy.refundMethod = 'MONEY_BACK';
      policy.returnShippingCostPayer = 'BUYER';
    }

    try {
      const response = await axios.post(
        'https://api.ebay.com/sell/account/v1/return_policy',
        policy,
        {
          headers: {
            'Authorization': `Bearer ${userToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log(`✅ Created return policy: ${policyName}`);
      return response.data.returnPolicyId;
    } catch (error) {
      console.error('❌ Return policy error:', error.response?.data || error.message);
      throw error;
    }
  }

  async createDefaultReturnPolicy(userToken) {
    const policy = {
      name: 'SlabTrack 30-Day Returns',
      marketplaceId: this.MARKETPLACE_ID,
      categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
      returnsAccepted: true,
      returnPeriod: { value: 30, unit: 'DAY' },
      refundMethod: 'MONEY_BACK',
      returnShippingCostPayer: 'BUYER'
    };

    const response = await axios.post(
      'https://api.ebay.com/sell/account/v1/return_policy',
      policy,
      {
        headers: {
          'Authorization': `Bearer ${userToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data.returnPolicyId;
  }

  async endListing(userToken, offerId, reason = 'NOT_AVAILABLE') {
    try {
      console.log('🛑 Ending eBay listing (offer):', offerId);
      
      await axios.delete(
        `https://api.ebay.com/sell/inventory/v1/offer/${offerId}`,
        {
          headers: {
            'Authorization': `Bearer ${userToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('✅ Listing ended successfully');

      return {
        success: true
      };

    } catch (error) {
      console.error('❌ End listing error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.errors?.[0]?.message || error.message
      };
    }
  }

  // ═══════════════════════════════════════════════════════
  // 📊 LEGACY METHODS (Backwards Compatibility)
  // ═══════════════════════════════════════════════════════
  
  async getSoldPrices(searchQuery) {
    try {
      console.log('🔍 Quick price check for:', searchQuery);
      
      const params = {
        'OPERATION-NAME': 'findCompletedItems',
        'SERVICE-VERSION': '1.13.0',
        'SECURITY-APPNAME': this.clientId,
        'RESPONSE-DATA-FORMAT': 'JSON',
        'REST-PAYLOAD': '',
        'keywords': searchQuery,
        'itemFilter(0).name': 'SoldItemsOnly',
        'itemFilter(0).value': 'true',
        'itemFilter(1).name': 'Condition',
        'itemFilter(1).value': 'New',
        'sortOrder': 'EndTimeSoonest',
        'paginationInput.entriesPerPage': '100'
      };

      const response = await axios.get(this.findingApiUrl, { params });
      
      const searchResult = response.data.findCompletedItemsResponse?.[0]?.searchResult?.[0];
      const items = searchResult?.item || [];

      const prices = items
        .filter(item => item.sellingStatus?.[0]?.sellingState?.[0] === 'EndedWithSales')
        .map(item => parseFloat(item.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || 0))
        .filter(price => price > 0)
        .sort((a, b) => a - b);

      if (prices.length === 0) {
        return { found: false, message: 'No sold listings found' };
      }

      const low = prices[0];
      const high = prices[prices.length - 1];
      const average = prices.reduce((a, b) => a + b, 0) / prices.length;

      return {
        found: true,
        count: prices.length,
        prices: {
          low: low.toFixed(2),
          high: high.toFixed(2),
          average: average.toFixed(2)
        }
      };

    } catch (error) {
      console.error('❌ Price check error:', error.message);
      return { found: false, error: error.message };
    }
  }

  async getRecentSoldListings(searchQuery, daysBack = 90, limit = 200) {
    try {
      console.log(`🔍 Searching sold listings for: ${searchQuery}`);
      
      const token = await this.getAccessToken();
      
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysBack);
      
      const params = {
        q: searchQuery,
        filter: `buyingOptions:{FIXED_PRICE},itemEndDate:[${startDate.toISOString()}..${endDate.toISOString()}]`,
        limit: limit,
        sort: '-itemEndDate'
      };

      const response = await axios.get(`${this.browseApiUrl}/item_summary/search`, {
        params,
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': this.MARKETPLACE_ID
        }
      });

      const items = response.data.itemSummaries || [];

      const soldItems = items
        .map(item => ({
          title: item.title || '',
          price: parseFloat(item.price?.value || 0),
          soldDate: item.itemEndDate || new Date().toISOString(),
          searchUrl: item.itemWebUrl || `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(searchQuery)}&LH_Sold=1`,
          image: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || null,
          condition: item.condition || 'Used'
        }))
        .filter(item => item.price > 0)
        .sort((a, b) => new Date(b.soldDate) - new Date(a.soldDate));

      console.log(`✅ Found ${soldItems.length} sold items`);
      return soldItems;

    } catch (error) {
      console.error('❌ eBay Recent Sales Error:', error.message);
      return [];
    }
  }

  async getSalesAnalytics(searchQuery) {
    try {
      console.log('📊 Fetching sales analytics for:', searchQuery);
      
      const allSales = await this.getRecentSoldListings(searchQuery, 365);
      
      if (!allSales || allSales.length === 0) {
        return {
          periods: {
            days30: { count: 0, avg: 0, low: 0, high: 0, sales: [] },
            days60: { count: 0, avg: 0, low: 0, high: 0, sales: [] },
            days90: { count: 0, avg: 0, low: 0, high: 0, sales: [] },
            months6: { count: 0, avg: 0, low: 0, high: 0, sales: [] },
            year: { count: 0, avg: 0, low: 0, high: 0, sales: [] }
          },
          totalSales: 0,
          searchQuery
        };
      }

      const now = new Date();
      
      const calculatePeriodStats = (sales) => {
        if (sales.length === 0) {
          return { count: 0, avg: 0, low: 0, high: 0, sales: [] };
        }
        
        const prices = sales.map(s => s.price);
        const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
        const low = Math.min(...prices);
        const high = Math.max(...prices);
        
        return {
          count: sales.length,
          avg: parseFloat(avg.toFixed(2)),
          low: parseFloat(low.toFixed(2)),
          high: parseFloat(high.toFixed(2)),
          sales: sales.slice(0, 10)
        };
      };

      const filterByDays = (days) => {
        return allSales.filter(s => {
          const saleDate = new Date(s.soldDate);
          const daysAgo = (now - saleDate) / (1000 * 60 * 60 * 24);
          return daysAgo <= days;
        });
      };

      return {
        periods: {
          days30: calculatePeriodStats(filterByDays(30)),
          days60: calculatePeriodStats(filterByDays(60)),
          days90: calculatePeriodStats(filterByDays(90)),
          months6: calculatePeriodStats(filterByDays(180)),
          year: calculatePeriodStats(allSales)
        },
        totalSales: allSales.length,
        searchQuery
      };

    } catch (error) {
      console.error('❌ Sales Analytics Error:', error.message);
      return {
        periods: {
          days30: { count: 0, avg: 0, low: 0, high: 0, sales: [] },
          days60: { count: 0, avg: 0, low: 0, high: 0, sales: [] },
          days90: { count: 0, avg: 0, low: 0, high: 0, sales: [] },
          months6: { count: 0, avg: 0, low: 0, high: 0, sales: [] },
          year: { count: 0, avg: 0, low: 0, high: 0, sales: [] }
        },
        totalSales: 0,
        searchQuery
      };
    }
  }

  // ═══════════════════════════════════════════════════════
  // ✏️ REVISE LISTING PRICE
  // ═══════════════════════════════════════════════════════

  async reviseListingPrice(userToken, itemId, newPrice) {
    try {
      console.log(`✏️ Revising eBay listing ${itemId} to $${newPrice}...`);
      
      const updateData = {
        requests: [{
          offerId: itemId,
          pricingSummary: {
            price: {
              currency: 'USD',
              value: newPrice.toString()
            }
          }
        }]
      };

      const response = await axios.post(
        'https://api.ebay.com/sell/inventory/v1/bulk_update_price_quantity',
        updateData,
        {
          headers: {
            'Authorization': `Bearer ${userToken}`,
            'Content-Type': 'application/json',
            'Content-Language': 'en-US'
          }
        }
      );

      console.log('✅ Price updated on eBay');
      return { success: true };

    } catch (error) {
      console.error('❌ Revise price error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.errors?.[0]?.message || error.message
      };
    }
  }

  // ═══════════════════════════════════════════════════════
  // 🔄 TOKEN REFRESH
  // ═══════════════════════════════════════════════════════

  async refreshUserToken(refreshToken) {
    try {
      console.log('🔄 Refreshing eBay user token...');
      
      const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      
      const response = await axios.post(
        this.oauthUrl,
        `grant_type=refresh_token&refresh_token=${refreshToken}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${auth}`
          }
        }
      );

      console.log('✅ Token refreshed successfully');
      return {
        success: true,
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in
      };

    } catch (error) {
      console.error('❌ Token refresh error:', error.response?.data || error.message);
      return {
        success: false,
        error: 'Failed to refresh token'
      };
    }
  }

  // ═══════════════════════════════════════════════════════
  // 🔍 GET OFFER ID FROM LISTING ID
  // ═══════════════════════════════════════════════════════

  async getOfferIdFromListingId(userToken, listingId) {
    try {
      console.log(`🔍 Fetching current offer ID for listing ${listingId}...`);
      
      // Get all offers and find the one matching this listing ID
      const response = await axios.get(
        'https://api.ebay.com/sell/inventory/v1/offer',
        {
          params: {
            limit: 100 // Get up to 100 offers
          },
          headers: {
            'Authorization': `Bearer ${userToken}`,
            'Content-Type': 'application/json',
            'Content-Language': 'en-US'
          }
        }
      );

      const offers = response.data.offers || [];
      
      // Find offer with matching listing ID
      const matchingOffer = offers.find(offer => offer.listingId === listingId);
      
      if (matchingOffer) {
        console.log(`✅ Found current offer ID: ${matchingOffer.offerId}`);
        return matchingOffer.offerId;
      }

      console.log('⚠️ No active offer found for this listing');
      return null;

    } catch (error) {
      console.error('❌ Error fetching offer ID:', error.response?.data || error.message);
      return null;
    }
  }
}

module.exports = new EbayOAuthService();