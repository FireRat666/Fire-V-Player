'use strict';
const { DataTypes } = require('sequelize');
// The player's blacklist (see server/blacklist.js).
// Runs from both sequelize-cli (the build command), which passes the queryInterface itself, and
// Umzug (server/db.js), which passes { context: queryInterface }.
const qi = (arg) => (arg && arg.context ? arg.context : arg);
module.exports = {
  async up(arg) {
    const queryInterface = qi(arg);
    await queryInterface.createTable('blocked_users', {
      userId: { allowNull: false, primaryKey: true, type: DataTypes.STRING, field: 'user_id' },
      name: { allowNull: true, type: DataTypes.STRING, field: 'name' },
      reason: { allowNull: true, type: DataTypes.STRING(300), field: 'reason' },
      createdAt: { allowNull: false, type: DataTypes.DATE, field: 'created_at' },
      updatedAt: { allowNull: false, type: DataTypes.DATE, field: 'updated_at' }
    });
  },
  async down(arg) {
    const queryInterface = qi(arg);
    await queryInterface.dropTable('blocked_users');
  }
};
