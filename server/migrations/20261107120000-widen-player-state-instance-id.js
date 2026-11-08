'use strict';
const { DataTypes } = require('sequelize');
// Rooms are named by the space's address and its room code (public/core.js setRoom), which can
// be longer than the 255 characters the column first allowed.
// Runs from both sequelize-cli, which passes the queryInterface itself, and Umzug (server/db.js),
// which passes { context: queryInterface }.
const qi = (arg) => (arg && arg.context ? arg.context : arg);
module.exports = {
  async up(arg) {
    await qi(arg).changeColumn('player_state', 'instance_id', { type: DataTypes.TEXT, allowNull: false });
  },
  async down(arg) {
    await qi(arg).changeColumn('player_state', 'instance_id', { type: DataTypes.STRING, allowNull: false });
  }
};
