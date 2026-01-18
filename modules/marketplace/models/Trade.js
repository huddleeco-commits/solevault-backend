/**
 * Trade Model - PostgreSQL Compatible
 * Represents trade transactions in the SoleVault platform
 */
const db = require('../database/db');

class Trade {
  static tableName = 'trades';

  // Find trade by ID
  static async findById(id) {
    try {
      const result = await db.query(
        `SELECT t.*,
                c1.name as offered_card_name, c1.front_image_url as offered_image,
                c2.name as requested_card_name, c2.front_image_url as requested_image,
                u1.full_name as offerer_name, u2.full_name as receiver_name
         FROM trades t
         LEFT JOIN cards c1 ON t.offered_card_id = c1.id
         LEFT JOIN cards c2 ON t.requested_card_id = c2.id
         LEFT JOIN users u1 ON t.offerer_id = u1.id
         LEFT JOIN users u2 ON t.receiver_id = u2.id
         WHERE t.id = $1`,
        [id]
      );
      return result.rows[0] || null;
    } catch (error) {
      console.error('Trade.findById error:', error);
      return null;
    }
  }

  // Find trades for a user
  static async findByUser(userId, options = {}) {
    try {
      const { limit = 50, offset = 0, status, role = 'any' } = options;
      let query = `
        SELECT t.*, c1.name as offered_card_name, c2.name as requested_card_name
        FROM trades t
        LEFT JOIN cards c1 ON t.offered_card_id = c1.id
        LEFT JOIN cards c2 ON t.requested_card_id = c2.id
        WHERE 1=1
      `;
      const params = [];
      let paramIndex = 1;

      if (role === 'offerer') {
        query += ` AND t.offerer_id = $${paramIndex++}`;
        params.push(userId);
      } else if (role === 'receiver') {
        query += ` AND t.receiver_id = $${paramIndex++}`;
        params.push(userId);
      } else {
        query += ` AND (t.offerer_id = $${paramIndex} OR t.receiver_id = $${paramIndex++})`;
        params.push(userId);
      }

      if (status) {
        query += ` AND t.status = $${paramIndex++}`;
        params.push(status);
      }

      query += ` ORDER BY t.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
      params.push(limit, offset);

      const result = await db.query(query, params);
      return result.rows;
    } catch (error) {
      console.error('Trade.findByUser error:', error);
      return [];
    }
  }

  // Create a new trade offer
  static async create(tradeData) {
    try {
      const { offerer_id, receiver_id, offered_card_id, requested_card_id, message } = tradeData;

      const result = await db.query(
        `INSERT INTO trades (offerer_id, receiver_id, offered_card_id, requested_card_id, message, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
         RETURNING *`,
        [offerer_id, receiver_id, offered_card_id, requested_card_id, message]
      );
      return result.rows[0];
    } catch (error) {
      console.error('Trade.create error:', error);
      return null;
    }
  }

  // Update trade status
  static async updateStatus(id, status, userId) {
    try {
      const result = await db.query(
        `UPDATE trades SET status = $1, updated_at = NOW(), resolved_by = $3 WHERE id = $2 RETURNING *`,
        [status, id, userId]
      );
      return result.rows[0];
    } catch (error) {
      console.error('Trade.updateStatus error:', error);
      return null;
    }
  }

  // Count pending trades for a user
  static async countPending(userId) {
    try {
      const result = await db.query(
        "SELECT COUNT(*) FROM trades WHERE receiver_id = $1 AND status = 'pending'",
        [userId]
      );
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      console.error('Trade.countPending error:', error);
      return 0;
    }
  }
}

module.exports = Trade;
