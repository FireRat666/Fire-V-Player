const path = require('path');

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
}
