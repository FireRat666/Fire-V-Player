/**
 * @fileoverview Database environment configurations for Sequelize CLI and migrations.
 * Defines connection settings and SSL parameters for development, test, and production.
 * @module server/config/config
 */

const path = require('path');

/**
 * Common base configuration across all environments.
 * Uses the DATABASE_URL environment variable with PostgreSQL SSL enabled.
 * @type {import('sequelize').Options}
 */
const baseConfig = {
  use_env_variable: "DATABASE_URL",
  dialect: 'postgres',
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false
    }
  }
};

module.exports = {
  development: {
    ...baseConfig,
    logging: console.log, // Log all queries in development
  },
  test: {
    ...baseConfig,
    logging: false, // Disable logging for tests
  },
  production: {
    ...baseConfig,
    logging: false, // Disable logging in production
  }
};
