/**
 * PendingAction Model - PostgreSQL Compatible
 * Represents pending user actions in the SoleVault platform
 */
const db = require('../database/db');

class PendingAction {
  static tableName = 'pending_actions';

  // Find pending action by ID
  static async findById(id) {
    try {
      const result = await db.query(
        'SELECT * FROM pending_actions WHERE id = $1',
        [id]
      );
      return result.rows[0] || null;
    } catch (error) {
      console.error('PendingAction.findById error:', error);
      return null;
    }
  }

  // Find pending actions for a user
  static async findByUser(userId, options = {}) {
    try {
      const { limit = 50, offset = 0, type, status = 'pending' } = options;
      let query = 'SELECT * FROM pending_actions WHERE user_id = $1';
      const params = [userId];
      let paramIndex = 2;

      if (status) {
        query += ` AND status = $${paramIndex++}`;
        params.push(status);
      }
      if (type) {
        query += ` AND action_type = $${paramIndex++}`;
        params.push(type);
      }

      query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
      params.push(limit, offset);

      const result = await db.query(query, params);
      return result.rows;
    } catch (error) {
      console.error('PendingAction.findByUser error:', error);
      return [];
    }
  }

  // Create a new pending action
  static async create(actionData) {
    try {
      const { user_id, action_type, reference_id, details, expires_at } = actionData;

      const result = await db.query(
        `INSERT INTO pending_actions (user_id, action_type, reference_id, details, status, expires_at, created_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, NOW())
         RETURNING *`,
        [user_id, action_type, reference_id, JSON.stringify(details || {}), expires_at]
      );
      return result.rows[0];
    } catch (error) {
      console.error('PendingAction.create error:', error);
      return null;
    }
  }

  // Mark action as completed
  static async complete(id) {
    try {
      const result = await db.query(
        "UPDATE pending_actions SET status = 'completed', completed_at = NOW() WHERE id = $1 RETURNING *",
        [id]
      );
      return result.rows[0];
    } catch (error) {
      console.error('PendingAction.complete error:', error);
      return null;
    }
  }

  // Cancel a pending action
  static async cancel(id, reason) {
    try {
      const result = await db.query(
        "UPDATE pending_actions SET status = 'cancelled', cancel_reason = $2, cancelled_at = NOW() WHERE id = $1 RETURNING *",
        [id, reason]
      );
      return result.rows[0];
    } catch (error) {
      console.error('PendingAction.cancel error:', error);
      return null;
    }
  }

  // Count pending actions for a user
  static async countPending(userId) {
    try {
      const result = await db.query(
        "SELECT COUNT(*) FROM pending_actions WHERE user_id = $1 AND status = 'pending'",
        [userId]
      );
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      console.error('PendingAction.countPending error:', error);
      return 0;
    }
  }

  // Cleanup expired actions
  static async cleanupExpired() {
    try {
      const result = await db.query(
        "UPDATE pending_actions SET status = 'expired' WHERE status = 'pending' AND expires_at < NOW() RETURNING id"
      );
      return result.rows.length;
    } catch (error) {
      console.error('PendingAction.cleanupExpired error:', error);
      return 0;
    }
  }
}

module.exports = PendingAction;
