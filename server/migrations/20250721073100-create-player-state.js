'use strict';
const { DataTypes } = require('sequelize');
module.exports = {
    async up({ context: queryInterface }) {
        // The table name is 'player_state' to match existing queries.
        await queryInterface.createTable('player_state', {
            instanceId: {
                allowNull: false,
                primaryKey: true,
                type: DataTypes.STRING,
                field: 'instance_id' // Match the database column name
            },
            playerData: {
                type: DataTypes.JSONB, // Use JSONB for better performance and indexing capabilities
                field: 'player_data',
                allowNull: false
            },
            createdAt: {
                allowNull: false,
                type: DataTypes.DATE
            },
            updatedAt: {
                allowNull: false,
                type: DataTypes.DATE
            }
        });
    },
    async down({ context: queryInterface }) {
        await queryInterface.dropTable('player_state');
    }
};
