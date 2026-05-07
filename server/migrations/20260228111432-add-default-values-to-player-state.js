'use strict';
const { DataTypes } = require('sequelize');
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    // 1. Add createdAt column as nullable
    await queryInterface.addColumn('player_state', 'createdAt', {
      type: DataTypes.DATE,
      allowNull: true, // Allow null initially
    });

    // 2. Add updatedAt column as nullable
    await queryInterface.addColumn('player_state', 'updatedAt', {
      type: DataTypes.DATE,
      allowNull: true, // Allow null initially
    });

    // 3. Update existing rows to set createdAt and updatedAt values
    // This step is crucial if there are existing rows that would otherwise have NULL for these new non-nullable columns.
    await queryInterface.sequelize.query(
      `UPDATE "player_state" SET "createdAt" = NOW(), "updatedAt" = NOW() WHERE "createdAt" IS NULL;`
    );

    // 4. Change createdAt column to be non-nullable with a default
    await queryInterface.changeColumn('player_state', 'createdAt', {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.fn('NOW'),
    });

    // 5. Change updatedAt column to be non-nullable with a default
    await queryInterface.changeColumn('player_state', 'updatedAt', {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.fn('NOW'),
    });
  },

  async down (queryInterface, Sequelize) {
    // Revert the changes by removing the columns
    await queryInterface.removeColumn('player_state', 'createdAt');
    await queryInterface.removeColumn('player_state', 'updatedAt');
  }
};
