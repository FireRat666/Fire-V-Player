'use strict';
const { DataTypes } = require('sequelize');
// The player's blacklist (see server/blacklist.js).
module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.createTable('blocked_users', {
      userId: { allowNull: false, primaryKey: true, type: DataTypes.STRING, field: 'user_id' },
      name: { allowNull: true, type: DataTypes.STRING, field: 'name' },
      reason: { allowNull: true, type: DataTypes.STRING(300), field: 'reason' },
      createdAt: { allowNull: false, type: DataTypes.DATE, field: 'created_at' },
      updatedAt: { allowNull: false, type: DataTypes.DATE, field: 'updated_at' }
    });
  },
  async down({ context: queryInterface }) {
    await queryInterface.dropTable('blocked_users');
  }
};
