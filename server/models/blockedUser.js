/**
 * @fileoverview BlockedUser Sequelize model: people on the player's blacklist (see server/blacklist.js).
 * @module server/models/blockedUser
 */

'use strict';
const { Model } = require('sequelize');

/**
 * @param {import('sequelize').Sequelize} sequelize - Sequelize database instance.
 * @param {typeof import('sequelize').DataTypes} DataTypes - Sequelize data types.
 * @returns {typeof Model} The initialized BlockedUser model.
 */
module.exports = (sequelize, DataTypes) => {
  /**
   * @property {string} userId - Banter user ID (localUser.uid).
   * @property {string} name - Their name when they were blocked, to recognise them by.
   * @property {string} reason - A note on why.
   */
  class BlockedUser extends Model {}
  BlockedUser.init({
    userId: { type: DataTypes.STRING, primaryKey: true, allowNull: false, field: 'user_id' },
    name: { type: DataTypes.STRING, allowNull: true, field: 'name' },
    reason: { type: DataTypes.STRING(300), allowNull: true, field: 'reason' }
  }, {
    sequelize,
    modelName: 'BlockedUser',
    tableName: 'blocked_users',
    underscored: true,
    timestamps: true
  });
  return BlockedUser;
};
