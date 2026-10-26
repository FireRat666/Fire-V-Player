/**
 * @fileoverview Makes the value for the ADMIN_PASSWORD_HASH environment variable (the blacklist's
 * admin page, see server/blacklist.js), so the password itself is never stored on the server.
 *
 * Run: npm run hash-password
 * It asks for the password twice (what you type isn't shown) and prints a line like
 * scrypt:16384:8:1:<salt>:<hash> to paste into ADMIN_PASSWORD_HASH.
 * @module server/hash-password
 */

const crypto = require('crypto');
const readline = require('readline');

/** scrypt settings: N (cost), r (block size), p (parallelisation), and the key length in bytes. */
const N = 16384, R = 8, P = 1, KEYLEN = 64;

/** Hashes a password with a new random salt, in the format server/blacklist.js reads. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt:${N}:${R}:${P}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

/** Asks a question without showing what's typed. */
function askHidden(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, answer => { rl.output.write('\n'); rl.close(); resolve(answer); });
  });
}

async function main() {
  if (!process.stdin.isTTY) {
    console.error('Run this in a terminal: npm run hash-password');
    process.exit(1);
  }
  const password = await askHidden('Admin password: ');
  if (password.length < 12) {
    console.error('Use at least 12 characters.');
    process.exit(1);
  }
  const again = await askHidden('Same password again: ');
  if (again !== password) {
    console.error("They don't match.");
    process.exit(1);
  }
  console.log('\nSet this as ADMIN_PASSWORD_HASH on your server (and remove ADMIN_PASSWORD if you set it):\n');
  console.log(hashPassword(password));
  console.log('\nSign in to /admin.html with the password itself, not this line.');
}

if (require.main === module) main();

module.exports = { hashPassword };
