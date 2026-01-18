/**
 * SpendingLog Model - PostgreSQL Compatible
 * Tracks spending and transactions in the SoleVault platform
 */
const db = require('../database/db');

class SpendingLog {
  static tableName = 'spending_logs';

  // Find spending log by ID
  static async findById(id) {
    try {
      const result = await db.query(
        'SELECT * FROM spending_logs WHERE id = $1',
        [id]
      );
      return result.rows[0] || null;
    } catch (error) {
      console.error('SpendingLog.findById error:', error);
      return null;
    }
  }

  // Find spending logs for a user
  static async findByUser(userId, options = {}) {
    try {
      const { limit = 50, offset = 0, type, startDate, endDate } = options;
      let query = 'SELECT * FROM spending_logs WHERE user_id = $1';
      const params = [userId];
      let paramIndex = 2;

      if (type) {
        query += ` AND transaction_type = $${paramIndex++}`;
        params.push(type);
      }
      if (startDate) {
        query += ` AND created_at >= $${paramIndex++}`;
        params.push(startDate);
      }
      if (endDate) {
        query += ` AND created_at <= $${paramIndex++}`;
        params.push(endDate);
      }

      query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
      params.push(limit, offset);

      const result = await db.query(query, params);
      return result.rows;
    } catch (error) {
      console.error('SpendingLog.findByUser error:', error);
      return [];
    }
  }

  // Create a new spending log
  static async create(logData) {
    try {
      const { user_id, transaction_type, amount, description, reference_id, balance_after } = logData;

      const result = await db.query(
        `INSERT INTO spending_logs (user_id, transaction_type, amount, description, reference_id, balance_after, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING *`,
        [user_id, transaction_type, amount, description, reference_id, balance_after]
      );
      return result.rows[0];
    } catch (error) {
      console.error('SpendingLog.create error:', error);
      return null;
    }
  }

  // Get user's total spending
  static async getTotalSpending(userId, type = null) {
    try {
      let query = 'SELECT COALESCE(SUM(amount), 0) as total FROM spending_logs WHERE user_id = $1 AND amount < 0';
      const params = [userId];

      if (type) {
        query += ' AND transaction_type = $2';
        params.push(type);
      }

      const result = await db.query(query, params);
      return Math.abs(parseFloat(result.rows[0].total));
    } catch (error) {
      console.error('SpendingLog.getTotalSpending error:', error);
      return 0;
    }
  }

  // Get user's total earnings
  static async getTotalEarnings(userId, type = null) {
    try {
      let query = 'SELECT COALESCE(SUM(amount), 0) as total FROM spending_logs WHERE user_id = $1 AND amount > 0';
      const params = [userId];

      if (type) {
        query += ' AND transaction_type = $2';
        params.push(type);
      }

      const result = await db.query(query, params);
      return parseFloat(result.rows[0].total);
    } catch (error) {
      console.error('SpendingLog.getTotalEarnings error:', error);
      return 0;
    }
  }
}

module.exports = SpendingLog;
