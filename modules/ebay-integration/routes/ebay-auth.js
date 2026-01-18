const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const pool = require('../database/db');
const { authenticateToken } = require('../middleware/auth');

// ═══════════════════════════════════════════════════════
// 🔥 AUTO-CREATE EBAY BUSINESS POLICIES (WITH USER INFO)
// ═══════════════════════════════════════════════════════

async function autoCreateBusinessPolicies(userId, accessToken) {
  try {
    console.log('🏪 Auto-creating eBay business policies for user:', userId);
    
    // 1️⃣ GET USER'S EBAY ACCOUNT INFO FIRST
    console.log('👤 Fetching user eBay account info...');
    
    let userInfo;
    try {
      const userInfoResponse = await axios.get(
        'https://apiz.ebay.com/sell/account/v1/privilege',
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Language': 'en-US'
          }
        }
      );
      
      // Extract marketplace info
      const privileges = userInfoResponse.data.sellingLimit || [];
      userInfo = {
        marketplaceId: 'EBAY_US', // Default, will be updated if found
        currency: 'USD',
        country: 'US'
      };
      
      // Try to detect marketplace from privileges
      if (privileges.length > 0 && privileges[0].amount) {
        userInfo.currency = privileges[0].amount.currency || 'USD';
      }
      
      console.log('✅ User info:', userInfo);
      
    } catch (error) {
      console.log('⚠️ Could not fetch user info, using defaults:', error.message);
      userInfo = {
        marketplaceId: 'EBAY_US',
        currency: 'USD',
        country: 'US'
      };
    }
    
    // Store marketplace info
    await pool.query(`
      UPDATE users 
      SET ebay_marketplace_id = $1,
          ebay_currency = $2,
          ebay_country_code = $3
      WHERE id = $4
    `, [userInfo.marketplaceId, userInfo.currency, userInfo.country, userId]);
    
    // 2️⃣ CREATE PAYMENT POLICY - WITH IMMEDIATE PAYMENT
console.log('💳 Creating payment policy...');
const paymentResponse = await axios.post(
  'https://api.ebay.com/sell/account/v1/payment_policy',
  {
    name: `SlabTrack Payment - User ${userId}`,
    description: 'Immediate payment required - Auto-created by SlabTrack',
    marketplaceId: userInfo.marketplaceId,
    categoryTypes: [{
      name: 'ALL_EXCLUDING_MOTORS_VEHICLES'
    }],
    immediatePay: true
  },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Content-Language': 'en-US'
        }
      }
    );
    
    const paymentPolicyId = paymentResponse.data.paymentPolicyId;
    console.log('✅ Payment policy created:', paymentPolicyId);
    
    // 3️⃣ CREATE RETURN POLICY - NO RETURNS
console.log('↩️ Creating return policy...');
const returnResponse = await axios.post(
  'https://api.ebay.com/sell/account/v1/return_policy',
  {
    name: `SlabTrack Returns - User ${userId}`,
    description: 'No returns accepted - Auto-created by SlabTrack',
    marketplaceId: userInfo.marketplaceId,
    categoryTypes: [{
      name: 'ALL_EXCLUDING_MOTORS_VEHICLES'
    }],
    returnsAccepted: false
  },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Content-Language': 'en-US'
        }
      }
    );
    
    const returnPolicyId = returnResponse.data.returnPolicyId;
    console.log('✅ Return policy created:', returnPolicyId);
    
    // 4️⃣ CREATE FULFILLMENT POLICY - SIMPLE FLAT RATE
    console.log('📦 Creating fulfillment policy...');
    const fulfillmentResponse = await axios.post(
      'https://api.ebay.com/sell/account/v1/fulfillment_policy',
      {
        name: `SlabTrack Shipping - User ${userId}`,
        description: 'USPS First Class - Auto-created by SlabTrack',
        marketplaceId: userInfo.marketplaceId,
        categoryTypes: [{
          name: 'ALL_EXCLUDING_MOTORS_VEHICLES'
        }],
        handlingTime: {
          value: 1,
          unit: 'DAY'
        },
        shipToLocations: {
          regionIncluded: [{
            regionName: userInfo.country,
            regionType: 'COUNTRY'
          }]
        },
        shippingOptions: [
          {
            optionType: 'DOMESTIC',
            costType: 'FLAT_RATE',
            shippingServices: [
              {
                shippingCarrierCode: 'USPS',
                shippingServiceCode: 'USPSFirstClass',
                shippingCost: {
                  value: '4.99',
                  currency: userInfo.currency
                },
                freeShipping: false,
                sortOrder: 1
              }
            ]
          }
        ],
        globalShipping: false,
        pickupDropOff: false
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Content-Language': 'en-US'
        }
      }
    );
    
    const fulfillmentPolicyId = fulfillmentResponse.data.fulfillmentPolicyId;
    console.log('✅ Fulfillment policy created:', fulfillmentPolicyId);
    
    // 5️⃣ SAVE POLICY IDs TO DATABASE
    await pool.query(`
      UPDATE users 
      SET ebay_payment_policy_id = $1,
          ebay_return_policy_id = $2,
          ebay_fulfillment_policy_id = $3,
          ebay_policies_created_at = CURRENT_TIMESTAMP,
          ebay_policies_onboarded = true
      WHERE id = $4
    `, [paymentPolicyId, returnPolicyId, fulfillmentPolicyId, userId]);
    
    console.log('✅ All policies saved to database');
    
    return {
      success: true,
      policies: {
        paymentPolicyId,
        returnPolicyId,
        fulfillmentPolicyId
      }
    };
    
  } catch (error) {
    console.error('❌ Failed to auto-create business policies:', error.response?.data || error.message);
    
    // Log detailed error for debugging
    if (error.response?.data?.errors) {
      error.response.data.errors.forEach(err => {
        console.error(`  - ${err.message}`);
        if (err.parameters) {
          err.parameters.forEach(param => {
            console.error(`    * ${param.name}: ${param.value}`);
          });
        }
      });
    }
    
    return {
      success: false,
      error: error.response?.data?.errors?.[0]?.message || error.message
    };
  }
}

// ═══════════════════════════════════════════════════════
// 🔒 SECURITY CONSTANTS
// ═══════════════════════════════════════════════════════
const STATE_EXPIRY_MINUTES = 10;
const TOKEN_REFRESH_BUFFER_MINUTES = 5;
const MAX_RETRIES = 3;

// ═══════════════════════════════════════════════════════
// 🛡️ INPUT VALIDATION HELPERS
// ═══════════════════════════════════════════════════════
function isValidState(state) {
  return state && typeof state === 'string' && /^[a-f0-9]{64}$/i.test(state);
}

function isValidAuthCode(code) {
  return code && typeof code === 'string' && code.length > 0 && code.length < 500;
}

function sanitizeUserId(userId) {
  const id = parseInt(userId, 10);
  if (isNaN(id) || id <= 0) {
    throw new Error('Invalid user ID');
  }
  return id;
}

// ═══════════════════════════════════════════════════════
// GET /api/ebay/status - Check if user has connected eBay
// ═══════════════════════════════════════════════════════
router.get('/status', authenticateToken, async (req, res) => {
  try {
    // Support multiple JWT payload structures
    const userIdFromToken = req.user?.id || req.user?.userId || req.user?.user_id;
    
    // Validate authentication
    if (!req.user || !userIdFromToken) {
      console.log('❌ No user ID in token. Token payload:', req.user);
      return res.status(401).json({ 
        success: false, 
        error: 'Authentication required' 
      });
    }

    const userId = sanitizeUserId(userIdFromToken);
    
    // Get token info
    const tokenResult = await pool.query(
      'SELECT created_at, ebay_user_id FROM ebay_user_tokens WHERE user_id = $1',
      [userId]
    );
    
    // Get policy IDs from users table
    const userResult = await pool.query(
      'SELECT ebay_payment_policy_id, ebay_return_policy_id, ebay_fulfillment_policy_id FROM users WHERE id = $1',
      [userId]
    );
    
    const policies = userResult.rows[0] || {};
    
    res.json({
      success: true,
      connected: tokenResult.rows.length > 0,
      connectedAt: tokenResult.rows[0]?.created_at || null,
      ebayUserId: tokenResult.rows[0]?.ebay_user_id || null,
      policies: {
        paymentPolicyId: policies.ebay_payment_policy_id || null,
        returnPolicyId: policies.ebay_return_policy_id || null,
        fulfillmentPolicyId: policies.ebay_fulfillment_policy_id || null
      }
    });
  } catch (error) {
    console.error('❌ Error checking eBay status:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to check eBay status' 
    });
  }
});

// ═══════════════════════════════════════════════════════
// GET /api/ebay/connect - Initiate OAuth flow
// ═══════════════════════════════════════════════════════
router.get('/connect', authenticateToken, async (req, res) => {
  try {
    // Support multiple JWT payload structures
    const userIdFromToken = req.user?.id || req.user?.userId || req.user?.user_id;
    
    // Validate authentication
    if (!req.user || !userIdFromToken || userIdFromToken === undefined) {
      console.error('❌ Authentication failed: Invalid or missing user ID');
      console.error('❌ Token payload:', req.user);
      return res.status(401).json({ 
        success: false, 
        error: 'Your session is invalid. Please log out and log back in.',
        needsRelogin: true
      });
    }

    const userId = sanitizeUserId(userIdFromToken);
    console.log('✅ eBay OAuth initiated by user:', userId);
    
    // Validate required env vars
    if (!process.env.EBAY_APP_ID || !process.env.EBAY_CERT_ID) {
      console.error('❌ Missing eBay credentials in environment');
      return res.status(500).json({
        success: false,
        error: 'eBay integration not configured'
      });
    }
    
    // Generate cryptographically secure state token
    const state = crypto.randomBytes(32).toString('hex');
    
    // Store state with user ID (with expiry)
    await pool.query(
      `INSERT INTO ebay_oauth_states (user_id, state, expires_at) 
       VALUES ($1, $2, NOW() + INTERVAL '${STATE_EXPIRY_MINUTES} minutes')
       ON CONFLICT (user_id) 
       DO UPDATE SET 
         state = EXCLUDED.state, 
         expires_at = EXCLUDED.expires_at`,
      [userId, state]
    );
    
    console.log('✅ OAuth state saved for user:', userId);
    
    // Build OAuth URL with validated parameters
const redirectUri = process.env.EBAY_REDIRECT_URI || 
  (process.env.NODE_ENV === 'production' 
    ? 'https://slabtrack.io/api/ebay/callback'
    : 'http://localhost:3000/api/ebay/callback');

console.log('🔗 Using redirect URI:', redirectUri);
    
    const scopes = [
      'https://api.ebay.com/oauth/api_scope/sell.inventory',
      'https://api.ebay.com/oauth/api_scope/sell.account'
    ].join(' ');
    
    const authUrl = `https://auth.ebay.com/oauth2/authorize?` +
      `client_id=${encodeURIComponent(process.env.EBAY_APP_ID)}&` +
      `response_type=code&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `scope=${encodeURIComponent(scopes)}&` +
      `state=${state}`;
    
    res.json({ success: true, authUrl });
    
  } catch (error) {
    console.error('❌ Error initiating eBay OAuth:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to initiate eBay connection'
    });
  }
});

// ═══════════════════════════════════════════════════════
// GET /api/ebay/callback - Handle OAuth redirect
// ═══════════════════════════════════════════════════════
router.get('/callback', async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;
    
    // Handle OAuth errors from eBay
    if (oauthError) {
      console.error('❌ eBay OAuth error:', oauthError);
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
return res.redirect(`${frontendUrl}/settings?ebay_error=oauth_denied`);
    }
    
    // Validate required parameters
    if (!code || !state) {
      console.error('❌ Missing OAuth parameters');
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
return res.redirect(`${frontendUrl}/settings?ebay_error=missing_params`);
    }
    
    // Validate state format (prevent injection)
    if (!isValidState(state)) {
      console.error('❌ Invalid state format');
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
return res.redirect(`${frontendUrl}/settings?ebay_error=invalid_state`);
    }
    
    // Validate auth code format
    if (!isValidAuthCode(code)) {
      console.error('❌ Invalid auth code format');
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
return res.redirect(`${frontendUrl}/settings?ebay_error=invalid_code`);
    }
    
    // Verify state and get user ID (with expiry check)
    const stateResult = await pool.query(
      `SELECT user_id FROM ebay_oauth_states 
       WHERE state = $1 AND expires_at > NOW()`,
      [state]
    );
    
    if (stateResult.rows.length === 0) {
      console.error('❌ Invalid or expired state token');
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
return res.redirect(`${frontendUrl}/settings?ebay_error=expired_state`);
    }
    
    const userId = sanitizeUserId(stateResult.rows[0].user_id);
    console.log('✅ Valid OAuth state for user:', userId);
    
    // Validate eBay credentials
    if (!process.env.EBAY_APP_ID || !process.env.EBAY_CERT_ID) {
      console.error('❌ Missing eBay credentials');
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
return res.redirect(`${frontendUrl}/settings?ebay_error=config_error`);
    }
    
    // Exchange code for tokens (with timeout)
    const auth = Buffer.from(
      `${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`
    ).toString('base64');
    
    const redirectUri = process.env.EBAY_REDIRECT_URI || 
      (process.env.NODE_ENV === 'production' 
        ? 'https://slabtrack.io/api/ebay/callback'
        : 'http://localhost:3000/api/ebay/callback');
    
    console.log('🔗 Token exchange using redirect URI:', redirectUri);
    
    const tokenResponse = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${auth}`
        },
        timeout: 10000 // 10 second timeout
      }
    );
    
    const {
      access_token,
      refresh_token,
      expires_in
    } = tokenResponse.data;
    
    // Validate token response
    if (!access_token || !refresh_token || !expires_in) {
      console.error('❌ Invalid token response from eBay');
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
return res.redirect(`${frontendUrl}/settings?ebay_error=invalid_response`);
    }
    
    // Calculate expiry with buffer
    const expiresAt = new Date(Date.now() + (expires_in * 1000));
    
    // Store tokens securely (use parameterized query)
    await pool.query(
      `INSERT INTO ebay_user_tokens 
       (user_id, access_token, refresh_token, token_expires_at, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) 
       DO UPDATE SET 
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         token_expires_at = EXCLUDED.token_expires_at,
         updated_at = CURRENT_TIMESTAMP`,
      [userId, access_token, refresh_token, expiresAt]
    );
    
    // Clean up used state token
    await pool.query(
      'DELETE FROM ebay_oauth_states WHERE user_id = $1',
      [userId]
    );
    
    console.log('✅ eBay OAuth successful for user:', userId);
    
    // 🔥 AUTO-CREATE BUSINESS POLICIES (NEW!)
    console.log('🏪 Checking if business policies need to be created...');
    
    const userCheck = await pool.query(
      'SELECT ebay_payment_policy_id FROM users WHERE id = $1',
      [userId]
    );
    
    if (!userCheck.rows[0]?.ebay_payment_policy_id) {
      console.log('📝 No policies found, auto-creating...');
      const policyResult = await autoCreateBusinessPolicies(userId, access_token);
      
      if (policyResult.success) {
        console.log('✅ Business policies auto-created successfully!');
      } else {
        console.log('⚠️ Could not auto-create policies:', policyResult.error);
        console.log('User will need to create them manually');
      }
    } else {
      console.log('✅ Business policies already exist');
    }
    
    // Redirect to settings with success
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.redirect(`${frontendUrl}/settings?ebay_success=true`);
    
  } catch (error) {
    console.error('❌ OAuth callback error:', error.message);
    
    // Don't expose internal errors to user
    if (error.response?.status === 400) {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
return res.redirect(`${frontendUrl}/settings?ebay_error=invalid_code`);
    }
    
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
res.redirect(`${frontendUrl}/settings?ebay_error=connection_failed`);
  }
});

// ═══════════════════════════════════════════════════════
// POST /api/ebay/disconnect - Remove eBay connection
// ═══════════════════════════════════════════════════════
router.post('/disconnect', authenticateToken, async (req, res) => {
  try {
    const userIdFromToken = req.user?.id || req.user?.userId || req.user?.user_id;
    
    if (!req.user || !userIdFromToken) {
      return res.status(401).json({ 
        success: false, 
        error: 'Authentication required' 
      });
    }

    const userId = sanitizeUserId(userIdFromToken);
    
    // Delete tokens
    const result = await pool.query(
      'DELETE FROM ebay_user_tokens WHERE user_id = $1 RETURNING id',
      [userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No eBay connection found'
      });
    }
    
    // 🔥 ALSO CLEAR POLICY IDs FROM USER TABLE
    await pool.query(
      `UPDATE users 
       SET ebay_payment_policy_id = NULL,
           ebay_return_policy_id = NULL,
           ebay_fulfillment_policy_id = NULL,
           ebay_policies_created_at = NULL,
           ebay_policies_onboarded = false
       WHERE id = $1`,
      [userId]
    );
    
    console.log('🔌 eBay disconnected for user:', userId);
    console.log('🗑️ eBay policies cleared for user:', userId);
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('❌ Error disconnecting eBay:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to disconnect eBay' 
    });
  }
});

// ═══════════════════════════════════════════════════════
// 🔐 HELPER: Get valid user token (with auto-refresh)
// ═══════════════════════════════════════════════════════
async function getUserEbayToken(userId) {
  // Validate user ID
  const validUserId = sanitizeUserId(userId);
  
  const result = await pool.query(
    'SELECT * FROM ebay_user_tokens WHERE user_id = $1',
    [validUserId]
  );
  
  if (result.rows.length === 0) {
    throw new Error('eBay account not connected');
  }
  
  const tokenData = result.rows[0];
  
  // Check if token needs refresh (with buffer)
  const bufferTime = TOKEN_REFRESH_BUFFER_MINUTES * 60 * 1000;
  const needsRefresh = new Date(tokenData.token_expires_at) < new Date(Date.now() + bufferTime);
  
  if (needsRefresh) {
    console.log('🔄 Refreshing eBay token for user:', validUserId);
    
    // Validate credentials
    if (!process.env.EBAY_APP_ID || !process.env.EBAY_CERT_ID) {
      throw new Error('eBay credentials not configured');
    }
    
    const auth = Buffer.from(
      `${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`
    ).toString('base64');
    
    const refreshResponse = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      `grant_type=refresh_token&refresh_token=${encodeURIComponent(tokenData.refresh_token)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${auth}`
        },
        timeout: 10000
      }
    );
    
    const { access_token, expires_in } = refreshResponse.data;
    
    if (!access_token || !expires_in) {
      throw new Error('Invalid refresh response from eBay');
    }
    
    const expiresAt = new Date(Date.now() + (expires_in * 1000));
    
    // Update token
    await pool.query(
      `UPDATE ebay_user_tokens 
       SET access_token = $1, token_expires_at = $2, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $3`,
      [access_token, expiresAt, validUserId]
    );
    
    console.log('✅ Token refreshed for user:', validUserId);
    
    return access_token;
  }
  
  return tokenData.access_token;
}

// ═══════════════════════════════════════════════════════
// 🧹 CLEANUP: Remove expired OAuth states (optional cron)
// ═══════════════════════════════════════════════════════
async function cleanupExpiredStates() {
  try {
    const result = await pool.query(
      'DELETE FROM ebay_oauth_states WHERE expires_at < NOW() RETURNING user_id'
    );
    
    if (result.rows.length > 0) {
      console.log(`🧹 Cleaned up ${result.rows.length} expired OAuth states`);
    }
  } catch (error) {
    console.error('❌ Error cleaning up OAuth states:', error.message);
  }
}

// Run cleanup every hour
setInterval(cleanupExpiredStates, 60 * 60 * 1000);

module.exports = router;
module.exports.getUserEbayToken = getUserEbayToken;