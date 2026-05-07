'use strict';
const { DataTypes } = require('sequelize');
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    // First, add the columns if they don't exist
    await queryInterface.addColumn('player_state', 'createdAt', {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('NOW()'), // Use Sequelize.literal for database functions
    });
    await queryInterface.addColumn('player_state', 'updatedAt', {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('NOW()'), // Use Sequelize.literal for database functions
    });

    // Then, if needed, change them to ensure default values are set (redundant if added with default, but safe)
    await queryInterface.changeColumn('player_state', 'createdAt', {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('NOW()'),
    });
    await queryInterface.changeColumn('player_state', 'updatedAt', {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('NOW()'),
    });
  },

  async down (queryInterface, Sequelize) {
    // Revert the changes by removing the columns
    await queryInterface.removeColumn('player_state', 'createdAt');
    await queryInterface.removeColumn('player_state', 'updatedAt');
  }
};
