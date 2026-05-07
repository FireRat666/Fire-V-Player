'use strict';
const { DataTypes } = require('sequelize');
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    await queryInterface.changeColumn('player_state', 'created_at', {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.fn('NOW'),
    });
    await queryInterface.changeColumn('player_state', 'updated_at', {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.fn('NOW'),
    });
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.changeColumn('player_state', 'created_at', {
      type: DataTypes.DATE,
      allowNull: false,
    });
    await queryInterface.changeColumn('player_state', 'updated_at', {
      type: DataTypes.DATE,
      allowNull: false,
    });
  }
};
