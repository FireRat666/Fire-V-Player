/**
 * @fileoverview Database initialization, connection management, schema migrations,
 * and security policy enforcement for Fire-V-Player.
 * Configures Sequelize with PostgreSQL pooling, keep-alives, automatic retries,
 * Umzug schema migrations, and optional one-time data migration between databases.
 * @module server/db
 */

const { Sequelize, DataTypes, Op } = require('sequelize');
const { Umzug, SequelizeStorage } = require('umzug');

const mainDbUrl = process.env.NEW_DATABASE_URL || process.env.DATABASE_URL;

const { types } = require('pg');
// By default, node-postgres (the driver for Sequelize) queries pg_timezone_names on
// each new connection to correctly parse TIMESTAMPTZ columns. This is very slow on some platforms.
// The fix is to override the type parser and return the raw string value instead.
// This is safe as the application logic handles timestamps as numbers or lets Sequelize manage them.
const TIMESTAMPTZ_OID = 1184;
const TIMESTAMP_OID = 1114;
types.setTypeParser(TIMESTAMPTZ_OID, val => val);
types.setTypeParser(TIMESTAMP_OID, val => val);

/**
 * Creates and configures a Sequelize PostgreSQL instance from a connection string.
 * Configures connection pooling, query retries for network resilience, keep-alives,
 * and modern SSL parameters.
 *
 * @param {string} dbUrl - PostgreSQL connection URL.
 * @returns {import('sequelize').Sequelize} Configured Sequelize instance.
 */
const createSequelizeInstance = (dbUrl) => {
  const options = {
    logging: false, // Set to console.log for debugging
    // Pool settings optimized for a persistent server environment
    pool: {
      max: 10,
      min: 1,  // Keep at least one connection warm to reduce latency on new requests
      acquire: 30000,
      // Increased idle time to 60 seconds to prevent frequent disconnects/reconnects
      idle: 60000
    },
    // --- Automatic Retry Configuration ---
    // This adds resilience against transient network errors by automatically
    // retrying failed database queries. This prevents the application from
    // crashing on temporary connection issues.
    retry: {
      max: 3, // Maximum number of retries
      // Match against a list of error types or message regexes.
      match: [
        /Connection terminated unexpectedly/, // Specific error from the logs
        /read ETIMEDOUT/, // Common network timeout error
        /read ECONNRESET/, // Explicitly handle connection resets
        'SequelizeConnectionError',
        'SequelizeConnectionRefusedError',
        'SequelizeHostNotFoundError',
        'SequelizeHostNotReachableError',
        'SequelizeInvalidConnectionError',
        'SequelizeConnectionTimedOutError'
      ]
    }
  };
  options.dialect = 'postgres';
  options.dialectOptions = {
    // Enable TCP keep-alives to prevent idle connections from being
    // terminated by the database server or intermediate proxies.
    // This is crucial for long-running applications on cloud platforms.
    // A 30-second interval is a safe and common value.
    keepalives: true,
    keepalives_idle: 30000
    // The 'useUTC: false' option was not effective for the 'pg' driver
    // and did not prevent the slow timezone query. The type parser override above is the correct solution.
  };

  // To address the 'pg-connection-string' warning and prepare for future updates,
  // we explicitly add the recommended SSL parameters to the connection URL.
  // 'uselibpqcompat=true' opts into the modern libpq-compatible behavior.
  // 'sslmode=require' ensures SSL is used without strict certificate verification,
  // matching the original intent of 'ssl: { require: true, rejectUnauthorized: false }'.
  let newDbUrl = dbUrl;
  const sslParams = 'uselibpqcompat=true&sslmode=require';
  if (!newDbUrl.includes('sslmode')) {
    if (newDbUrl.includes('?')) {
      newDbUrl += `&${sslParams}`;
    } else {
      newDbUrl += `?${sslParams}`;
    }
  }
  return new Sequelize(newDbUrl, options);
};

// --- Singleton Sequelize Instance ---
// Use the NEW_DATABASE_URL for the main connection if it exists, otherwise fall back to the old one.
// This ensures the app connects to the correct database after a potential migration.
const sequelize = mainDbUrl ? createSequelizeInstance(mainDbUrl) : null;

// --- Helper Functions ---

/**
 * Turns on Row Level Security (RLS) for a PostgreSQL table with a "Deny All" policy, so roles
 * subject to RLS (such as a hosting provider's public API roles) can't read or write its rows.
 * It doesn't block the table's owner (the app's own connection) or roles with BYPASSRLS or
 * superuser, since RLS isn't forced on the table.
 *
 * @param {string} tableName - Name of the database table.
 * @returns {Promise<void>}
 */
const applyRlsPolicy = async (tableName) => {
  if (!sequelize || sequelize.getDialect() !== 'postgres') return;
  try {
    console.log(`Applying RLS policy to "${tableName}" table for security...`);
    await sequelize.query(`ALTER TABLE "${tableName}" ENABLE ROW LEVEL SECURITY;`);
    await sequelize.query(`DROP POLICY IF EXISTS "Deny All on ${tableName}" ON "${tableName}";`);
    await sequelize.query(`
      CREATE POLICY "Deny All on ${tableName}" ON "${tableName}"
      FOR ALL
      USING (false)
      WITH CHECK (false);
    `);
    console.log(`Successfully applied RLS policy to "${tableName}".`);
  } catch (rlsError) {
    if (rlsError.name === 'SequelizeDatabaseError' && rlsError.original.code === '42P01') { // 42P01 is undefined_table in Postgres
      console.warn(`"${tableName}" table not found, skipping RLS policy. It will be applied on next startup.`);
    } else {
      console.error(`!!! WARNING: Failed to apply RLS policy to "${tableName}" table. !!!`, rlsError.message);
    }
  }
};

/**
 * Executes all pending Sequelize schema migrations using Umzug.
 * Reads migration scripts from `server/migrations/*.js`.
 *
 * @returns {Promise<void>}
 */
const runMigrations = async () => {
  if (!sequelize) return;
  const umzug = new Umzug({
    migrations: { glob: 'server/migrations/*.js' },
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize }),
    logger: undefined,
  });
  await umzug.up();
  console.log('Migrations are up to date.');
};

/**
 * Performs a one-time automated data migration from `DATABASE_URL` to `NEW_DATABASE_URL`
 * if both environment variables are set and differ.
 * Migrates all records in a single database transaction.
 *
 * @returns {Promise<void>}
 */
const runOneTimeMigration = async () => {
  const oldDbUrl = process.env.DATABASE_URL;
  const newDbUrl = process.env.NEW_DATABASE_URL;

  if (!newDbUrl || !oldDbUrl || newDbUrl.trim() === '' || newDbUrl === oldDbUrl) {
    return; // No migration needed
  }

  console.log('!!! New database URL detected. Starting automated data migration. !!!');
  console.log(`Source:      ${oldDbUrl.substring(0, 40)}...`);
  console.log(`Destination: ${newDbUrl.substring(0, 40)}...`);

  const oldSequelize = createSequelizeInstance(oldDbUrl);
  if (!oldSequelize) {
    console.error('Could not create connection to the old database. Aborting migration.');
    return;
  }

  const PlayerStateModel = require('./models/playerState');
  const OldPlayerState = PlayerStateModel(oldSequelize, DataTypes);
  const NewPlayerState = PlayerStateModel(sequelize, DataTypes); // Use the main new sequelize instance
  const BlockedUserModel = require('./models/blockedUser');
  const OldBlockedUser = BlockedUserModel(oldSequelize, DataTypes);
  const NewBlockedUser = BlockedUserModel(sequelize, DataTypes);

  // The destination needs every table before anything is copied into it (this is a no-op for
  // tables it already has; the usual run after this finds nothing left to do).
  console.log('Applying the schema to the destination database...');
  await runMigrations();

  console.log('Fetching all data from the source database...');
  const allStates = await OldPlayerState.findAll({ raw: true });
  console.log(`Found ${allStates.length} player state records to migrate.`);
  // The blacklist (see server/blacklist.js). A source database from before it has no table yet.
  let blockedUsers = [];
  try {
    blockedUsers = await OldBlockedUser.findAll({ raw: true });
    console.log(`Found ${blockedUsers.length} blocked users to migrate.`);
  } catch (err) {
    if (err.original && err.original.code === '42P01') console.log('The source database has no blacklist table, so there are no blocked users to migrate.');
    else throw err;
  }

  if (allStates.length > 0 || blockedUsers.length > 0) {
    const transaction = await sequelize.transaction();
    try {
      console.log('Starting transaction on destination database...');
      if (allStates.length > 0) {
        await NewPlayerState.destroy({ where: {}, truncate: true, transaction });
        console.log('Destination player state table truncated.');
        await NewPlayerState.bulkCreate(allStates, { transaction });
        console.log('All player state records inserted into destination database.');
      }
      if (blockedUsers.length > 0) {
        // Keeps each entry's original dates (bulkCreate only fills in missing ones).
        await NewBlockedUser.destroy({ where: {}, truncate: true, transaction });
        await NewBlockedUser.bulkCreate(blockedUsers, { transaction });
        console.log('All blocked users inserted into destination database.');
      }
      await transaction.commit();
      console.log('Transaction committed.');
    } catch (err) {
      console.error('XXX DATABASE MIGRATION FAILED DURING TRANSACTION XXX');
      await transaction.rollback();
      console.error('Transaction has been rolled back.');
      throw err;
    }
  }
  await oldSequelize.close();
  console.log('✔✔✔ Data migration complete. Application will now use the new database. ✔✔✔');
};

/**
 * Initializes the database connection, runs pending migrations, and configures security policies.
 * If no database URL is provided or if connection fails, logs a warning and falls back to in-memory mode.
 *
 * @returns {Promise<{dbConnected: boolean}>} Object indicating whether the DB connection succeeded.
 */
const initializeDatabase = async () => {
  if (!sequelize) {
    console.warn('!!! WARNING: No database URL configured. !!!');
    console.warn('!!! Application will run in-memory only. No data will be saved. !!!');
    return { dbConnected: false };
  }

  try {
    // Run one-time data migration if needed. This must run before other DB operations.
    await runOneTimeMigration();

    // Now, initialize the main database connection.
    await sequelize.authenticate();
    console.log('Database connection established successfully.');

    await runMigrations();

    await applyRlsPolicy('SequelizeMeta');
    await applyRlsPolicy('player_state');
    await applyRlsPolicy('blocked_users');

    return { dbConnected: true };

  } catch (dbError) {
    console.warn('!!! WARNING: Could not connect to the database. !!!');
    console.warn(`!!! Application will run in-memory only. No data will be saved. !!!`);
    console.warn('Database error:', dbError.message);
    return { dbConnected: false };
  }
};

module.exports = {
  sequelize,
  initializeDatabase,
};
