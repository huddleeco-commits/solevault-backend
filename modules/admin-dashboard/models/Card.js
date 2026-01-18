/**
 * Card Model - PostgreSQL Compatible
 * Represents collectible items (sneakers) in the SoleVault platform
 */
const db = require('../database/db');

class Card {
  static tableName = 'cards';

  // Find card by ID
  static async findById(id) {
    try {
      const result = await db.query(
        'SELECT * FROM cards WHERE id = $1',
        [id]
      );
      return result.rows[0] || null;
    } catch (error) {
      console.error('Card.findById error:', error);
      return null;
    }
  }

  // Find cards by user ID
  static async findByUserId(userId, options = {}) {
    try {
      const { limit = 50, offset = 0, sort = 'created_at DESC' } = options;
      const result = await db.query(
        `SELECT * FROM cards WHERE user_id = $1 ORDER BY ${sort} LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );
      return result.rows;
    } catch (error) {
      console.error('Card.findByUserId error:', error);
      return [];
    }
  }

  // Find all cards with optional filters
  static async find(filters = {}, options = {}) {
    try {
      const { limit = 50, offset = 0 } = options;
      let query = 'SELECT * FROM cards WHERE 1=1';
      const params = [];
      let paramIndex = 1;

      if (filters.user_id) {
        query += ` AND user_id = $${paramIndex++}`;
        params.push(filters.user_id);
      }
      if (filters.for_sale) {
        query += ` AND for_sale = $${paramIndex++}`;
        params.push(filters.for_sale);
      }
      if (filters.listing_status) {
        query += ` AND listing_status = $${paramIndex++}`;
        params.push(filters.listing_status);
      }

      query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
      params.push(limit, offset);

      const result = await db.query(query, params);
      return result.rows;
    } catch (error) {
      console.error('Card.find error:', error);
      return [];
    }
  }

  // Create a new card
  static async create(cardData) {
    try {
      const {
        user_id, name, brand, model, size, condition, price,
        description, front_image_url, back_image_url, for_sale = false
      } = cardData;

      const result = await db.query(
        `INSERT INTO cards (user_id, name, brand, model, size, condition, price, description, front_image_url, back_image_url, for_sale, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
         RETURNING *`,
        [user_id, name, brand, model, size, condition, price, description, front_image_url, back_image_url, for_sale]
      );
      return result.rows[0];
    } catch (error) {
      console.error('Card.create error:', error);
      return null;
    }
  }

  // Update a card
  static async update(id, updates) {
    try {
      const fields = [];
      const params = [];
      let paramIndex = 1;

      for (const [key, value] of Object.entries(updates)) {
        fields.push(`${key} = $${paramIndex++}`);
        params.push(value);
      }
      params.push(id);

      const result = await db.query(
        `UPDATE cards SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${paramIndex} RETURNING *`,
        params
      );
      return result.rows[0];
    } catch (error) {
      console.error('Card.update error:', error);
      return null;
    }
  }

  // Delete a card
  static async delete(id) {
    try {
      await db.query('DELETE FROM cards WHERE id = $1', [id]);
      return true;
    } catch (error) {
      console.error('Card.delete error:', error);
      return false;
    }
  }

  // Count cards
  static async count(filters = {}) {
    try {
      let query = 'SELECT COUNT(*) FROM cards WHERE 1=1';
      const params = [];
      let paramIndex = 1;

      if (filters.user_id) {
        query += ` AND user_id = $${paramIndex++}`;
        params.push(filters.user_id);
      }
      if (filters.for_sale !== undefined) {
        query += ` AND for_sale = $${paramIndex++}`;
        params.push(filters.for_sale);
      }

      const result = await db.query(query, params);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      console.error('Card.count error:', error);
      return 0;
    }
  }
}

module.exports = Card;
