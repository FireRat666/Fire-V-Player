'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
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