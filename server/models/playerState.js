/**
 * @fileoverview PlayerState Sequelize model definition.
 * Stores persistent room/instance player state (queue, playback mode, locks, volume, etc.).
 * @module server/models/playerState
 */

'use strict';
const {
  Model
} = require('sequelize');

/**
 * Initializes and exports the PlayerState model.
 *
 * @param {import('sequelize').Sequelize} sequelize - Sequelize database instance.
 * @param {typeof import('sequelize').DataTypes} DataTypes - Sequelize data types.
 * @returns {typeof Model} The initialized PlayerState model.
 */
module.exports = (sequelize, DataTypes) => {
  /**
   * Entity representing the persisted state of a player instance/room.
   * @class PlayerState
   * @extends {Model}
   * @property {string} instanceId - Unique identifier for the player room or world instance.
   * @property {Object} playerData - Serialized JSON payload containing playback status, playlist items, and host state.
   */
  class PlayerState extends Model {}
  PlayerState.init({
    instanceId: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false,
      field: 'instance_id'
    },
    playerData: {
      type: DataTypes.JSON,
      allowNull: false,
      field: 'player_data'
    }
  }, {
    sequelize,
    modelName: 'PlayerState',
    tableName: 'player_state',
    underscored: true,
    // Explicitly disable timestamps to match the production schema.
    timestamps: false,
  });
  return PlayerState;
};