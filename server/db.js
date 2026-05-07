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

// Helper to create a sequelize instance from a URL.
// It's defined here so it can be used by both the main connection and the one-time migrator.
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
const sequelize = createSequelizeInstance(mainDbUrl);

// --- Helper Functions ---
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

  console.log('Fetching all data from the source database...');
  const allStates = await OldPlayerState.findAll({ raw: true });
  console.log(`Found ${allStates.length} records to migrate.`);

  if (allStates.length > 0) {
    const transaction = await sequelize.transaction();
    try {
      console.log('Starting transaction on destination database...');
      await NewPlayerState.destroy({ where: {}, truncate: true, transaction });
      console.log('Destination table truncated.');
      await NewPlayerState.bulkCreate(allStates, { transaction });
      console.log('All records inserted into destination database.');
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
