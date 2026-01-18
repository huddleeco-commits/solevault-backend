const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

// GET /api/metrics/live - Live metrics endpoint
router.get('/live', (req, res) => {
  res.json({
    responseTime: process.hrtime()[1] / 1000000, // Real response time
    activeSessions: Object.keys(req.app.locals.sessions || {}).length,
    apiCalls: req.app.locals.apiCallCount || 0,
    uptime: process.uptime(),
    dbConnections: mongoose.connection.readyState,
    timestamp: new Date().toISOString(),
    status: 'healthy'
  });
});

module.exports = router;