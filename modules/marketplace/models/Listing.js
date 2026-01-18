/**
 * Listing Model - PostgreSQL Compatible
 * Represents marketplace listings in the SoleVault platform
 */
const db = require('../database/db');

class Listing {
  static tableName = 'listings';

  // Find listing by ID
  static async findById(id) {
    try {
      const result = await db.query(
        `SELECT l.*, c.name as card_name, c.brand, c.model, c.front_image_url,
                u.full_name as seller_name
         FROM listings l
         LEFT JOIN cards c ON l.card_id = c.id
         LEFT JOIN users u ON l.seller_id = u.id
         WHERE l.id = $1`,
        [id]
      );
      return result.rows[0] || null;
    } catch (error) {
      console.error('Listing.findById error:', error);
      return null;
    }
  }

  // Find active listings
  static async findActive(options = {}) {
    try {
      const { limit = 50, offset = 0, category, minPrice, maxPrice } = options;
      let query = `
        SELECT l.*, c.name as card_name, c.brand, c.model, c.front_image_url,
               u.full_name as seller_name
        FROM listings l
        LEFT JOIN cards c ON l.card_id = c.id
        LEFT JOIN users u ON l.seller_id = u.id
        WHERE l.status = 'active'
      `;
      const params = [];
      let paramIndex = 1;

      if (category) {
        query += ` AND c.brand = $${paramIndex++}`;
        params.push(category);
      }
      if (minPrice) {
        query += ` AND l.price >= $${paramIndex++}`;
        params.push(minPrice);
      }
      if (maxPrice) {
        query += ` AND l.price <= $${paramIndex++}`;
        params.push(maxPrice);
      }

      query += ` ORDER BY l.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
      params.push(limit, offset);

      const result = await db.query(query, params);
      return result.rows;
    } catch (error) {
      console.error('Listing.findActive error:', error);
      return [];
    }
  }

  // Find listings by seller
  static async findBySeller(sellerId, options = {}) {
    try {
      const { limit = 50, offset = 0, status } = options;
      let query = 'SELECT * FROM listings WHERE seller_id = $1';
      const params = [sellerId];
      let paramIndex = 2;

      if (status) {
        query += ` AND status = $${paramIndex++}`;
        params.push(status);
      }

      query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
      params.push(limit, offset);

      const result = await db.query(query, params);
      return result.rows;
    } catch (error) {
      console.error('Listing.findBySeller error:', error);
      return [];
    }
  }

  // Create a new listing
  static async create(listingData) {
    try {
      const { card_id, seller_id, price, description, status = 'active' } = listingData;

      const result = await db.query(
        `INSERT INTO listings (card_id, seller_id, price, description, status, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING *`,
        [card_id, seller_id, price, description, status]
      );
      return result.rows[0];
    } catch (error) {
      console.error('Listing.create error:', error);
      return null;
    }
  }

  // Update listing status
  static async updateStatus(id, status) {
    try {
      const result = await db.query(
        'UPDATE listings SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [status, id]
      );
      return result.rows[0];
    } catch (error) {
      console.error('Listing.updateStatus error:', error);
      return null;
    }
  }

  // Delete a listing
  static async delete(id) {
    try {
      await db.query('DELETE FROM listings WHERE id = $1', [id]);
      return true;
    } catch (error) {
      console.error('Listing.delete error:', error);
      return false;
    }
  }

  // Count active listings
  static async countActive() {
    try {
      const result = await db.query("SELECT COUNT(*) FROM listings WHERE status = 'active'");
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      console.error('Listing.countActive error:', error);
      return 0;
    }
  }
}

module.exports = Listing;
