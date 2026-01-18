/**
 * Analytics API Routes
 *
 * Comprehensive analytics for admin dashboard.
 * Includes revenue, customers, traffic, and performance metrics.
 */

const express = require('express');
const router = express.Router();

// GET /api/admin/analytics/metrics - Main dashboard metrics
router.get('/metrics', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json({
        revenue: { value: 0, change: 0, trend: 'neutral' },
        customers: { value: 0, change: 0, trend: 'neutral' },
        orders: { value: 0, change: 0, trend: 'neutral' },
        views: { value: 0, change: 0, trend: 'neutral' }
      });
    }

    const period = req.query.period || '30d';
    let interval = '30 days';
    if (period === '7d') interval = '7 days';
    if (period === '90d') interval = '90 days';

    // Get current period metrics
    const currentResult = await pool.query(`
      SELECT
        COALESCE(SUM(o.total), 0) as revenue,
        COUNT(DISTINCT c.id) as customers,
        COUNT(o.id) as orders
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      WHERE o.created_at >= NOW() - INTERVAL '${interval}'
        AND o.status != 'cancelled'
    `);

    // Get previous period for comparison
    const previousResult = await pool.query(`
      SELECT
        COALESCE(SUM(o.total), 0) as revenue,
        COUNT(DISTINCT c.id) as customers,
        COUNT(o.id) as orders
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      WHERE o.created_at >= NOW() - INTERVAL '${interval}' * 2
        AND o.created_at < NOW() - INTERVAL '${interval}'
        AND o.status != 'cancelled'
    `);

    // Get page views
    const viewsResult = await pool.query(`
      SELECT COUNT(*) as views
      FROM analytics_events
      WHERE event_type = 'page_view'
        AND created_at >= NOW() - INTERVAL '${interval}'
    `);

    const previousViewsResult = await pool.query(`
      SELECT COUNT(*) as views
      FROM analytics_events
      WHERE event_type = 'page_view'
        AND created_at >= NOW() - INTERVAL '${interval}' * 2
        AND created_at < NOW() - INTERVAL '${interval}'
    `);

    const current = currentResult.rows[0];
    const previous = previousResult.rows[0];
    const views = parseInt(viewsResult.rows[0].views);
    const previousViews = parseInt(previousViewsResult.rows[0].views);

    const calcChange = (curr, prev) => {
      if (prev === 0) return curr > 0 ? 100 : 0;
      return Math.round(((curr - prev) / prev) * 100);
    };

    const getTrend = (change) => {
      if (change > 0) return 'up';
      if (change < 0) return 'down';
      return 'neutral';
    };

    const revenueChange = calcChange(parseFloat(current.revenue), parseFloat(previous.revenue));
    const customersChange = calcChange(parseInt(current.customers), parseInt(previous.customers));
    const ordersChange = calcChange(parseInt(current.orders), parseInt(previous.orders));
    const viewsChange = calcChange(views, previousViews);

    res.json({
      revenue: {
        value: parseFloat(current.revenue),
        change: revenueChange,
        trend: getTrend(revenueChange)
      },
      customers: {
        value: parseInt(current.customers),
        change: customersChange,
        trend: getTrend(customersChange)
      },
      orders: {
        value: parseInt(current.orders),
        change: ordersChange,
        trend: getTrend(ordersChange)
      },
      views: {
        value: views,
        change: viewsChange,
        trend: getTrend(viewsChange)
      }
    });
  } catch (error) {
    console.error('Error fetching metrics:', error);
    res.json({
      revenue: { value: 0, change: 0, trend: 'neutral' },
      customers: { value: 0, change: 0, trend: 'neutral' },
      orders: { value: 0, change: 0, trend: 'neutral' },
      views: { value: 0, change: 0, trend: 'neutral' }
    });
  }
});

// GET /api/admin/analytics/revenue - Revenue over time
router.get('/revenue', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json([]);
    }

    const period = req.query.period || '30d';
    let interval = '30 days';
    let groupBy = 'day';
    if (period === '7d') { interval = '7 days'; groupBy = 'day'; }
    if (period === '90d') { interval = '90 days'; groupBy = 'week'; }
    if (period === '1y') { interval = '1 year'; groupBy = 'month'; }

    const result = await pool.query(`
      SELECT
        DATE_TRUNC('${groupBy}', created_at) as date,
        SUM(total) as revenue,
        COUNT(*) as orders
      FROM orders
      WHERE created_at >= NOW() - INTERVAL '${interval}'
        AND status != 'cancelled'
      GROUP BY DATE_TRUNC('${groupBy}', created_at)
      ORDER BY date ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching revenue:', error);
    res.json([]);
  }
});

// GET /api/admin/analytics/customers - Customer metrics over time
router.get('/customers', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json([]);
    }

    const period = req.query.period || '30d';
    let interval = '30 days';
    if (period === '7d') interval = '7 days';
    if (period === '90d') interval = '90 days';

    const result = await pool.query(`
      SELECT
        DATE_TRUNC('day', created_at) as date,
        COUNT(*) as new_customers
      FROM customers
      WHERE created_at >= NOW() - INTERVAL '${interval}'
      GROUP BY DATE_TRUNC('day', created_at)
      ORDER BY date ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching customer metrics:', error);
    res.json([]);
  }
});

// GET /api/admin/analytics/traffic - Traffic/page view metrics
router.get('/traffic', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json({ views: [], sources: [], pages: [] });
    }

    const period = req.query.period || '30d';
    let interval = '30 days';
    if (period === '7d') interval = '7 days';

    // Views over time
    const viewsResult = await pool.query(`
      SELECT
        DATE_TRUNC('day', created_at) as date,
        COUNT(*) as views,
        COUNT(DISTINCT session_id) as sessions
      FROM analytics_events
      WHERE event_type = 'page_view'
        AND created_at >= NOW() - INTERVAL '${interval}'
      GROUP BY DATE_TRUNC('day', created_at)
      ORDER BY date ASC
    `);

    // Top pages
    const pagesResult = await pool.query(`
      SELECT
        page,
        COUNT(*) as views
      FROM analytics_events
      WHERE event_type = 'page_view'
        AND created_at >= NOW() - INTERVAL '${interval}'
      GROUP BY page
      ORDER BY views DESC
      LIMIT 10
    `);

    // Traffic sources
    const sourcesResult = await pool.query(`
      SELECT
        COALESCE(metadata->>'source', 'direct') as source,
        COUNT(*) as visits
      FROM analytics_events
      WHERE event_type = 'page_view'
        AND created_at >= NOW() - INTERVAL '${interval}'
      GROUP BY COALESCE(metadata->>'source', 'direct')
      ORDER BY visits DESC
      LIMIT 10
    `);

    res.json({
      views: viewsResult.rows,
      pages: pagesResult.rows,
      sources: sourcesResult.rows
    });
  } catch (error) {
    console.error('Error fetching traffic:', error);
    res.json({ views: [], sources: [], pages: [] });
  }
});

// GET /api/admin/analytics/products - Product performance
router.get('/products', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json([]);
    }

    const period = req.query.period || '30d';
    let interval = '30 days';
    if (period === '7d') interval = '7 days';
    if (period === '90d') interval = '90 days';

    // This assumes orders.items is JSONB array with product_id, quantity, price
    const result = await pool.query(`
      SELECT
        p.id,
        p.name,
        p.sku,
        p.price,
        COALESCE(SUM((item->>'quantity')::int), 0) as units_sold,
        COALESCE(SUM((item->>'quantity')::int * (item->>'price')::decimal), 0) as revenue
      FROM products p
      LEFT JOIN orders o ON o.created_at >= NOW() - INTERVAL '${interval}' AND o.status != 'cancelled'
      LEFT JOIN LATERAL jsonb_array_elements(o.items) item ON (item->>'product_id')::int = p.id
      GROUP BY p.id, p.name, p.sku, p.price
      ORDER BY revenue DESC
      LIMIT 20
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching product analytics:', error);
    res.json([]);
  }
});

// POST /api/admin/analytics/track - Track analytics event
router.post('/track', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json({ success: true });
    }

    const { event_type, page, user_id, session_id, metadata } = req.body;

    await pool.query(`
      INSERT INTO analytics_events (event_type, page, user_id, session_id, metadata, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `, [event_type, page, user_id, session_id, JSON.stringify(metadata || {})]);

    res.json({ success: true });
  } catch (error) {
    console.error('Error tracking event:', error);
    res.json({ success: true }); // Don't fail on tracking errors
  }
});

// GET /api/admin/analytics/realtime - Real-time metrics
router.get('/realtime', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    if (!pool) {
      return res.json({
        activeUsers: 0,
        recentOrders: 0,
        recentRevenue: 0
      });
    }

    // Active users in last 5 minutes
    const activeResult = await pool.query(`
      SELECT COUNT(DISTINCT session_id) as active
      FROM analytics_events
      WHERE created_at >= NOW() - INTERVAL '5 minutes'
    `);

    // Orders in last hour
    const ordersResult = await pool.query(`
      SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as revenue
      FROM orders
      WHERE created_at >= NOW() - INTERVAL '1 hour'
        AND status != 'cancelled'
    `);

    res.json({
      activeUsers: parseInt(activeResult.rows[0].active),
      recentOrders: parseInt(ordersResult.rows[0].count),
      recentRevenue: parseFloat(ordersResult.rows[0].revenue)
    });
  } catch (error) {
    console.error('Error fetching realtime metrics:', error);
    res.json({ activeUsers: 0, recentOrders: 0, recentRevenue: 0 });
  }
});

module.exports = router;
