/**
 * @fileoverview Which build of Fire-V-Player this server runs, shown in the in-world panel so people
 * can tell an old one from a new one. It's the date of the last commit and its short hash, read from
 * git when the server starts (or the commit Render deployed, RENDER_GIT_COMMIT, when git isn't there).
 * @module server/version
 */

const { execFileSync } = require('child_process');
const path = require('path');

/** Runs a git command in the repository, or returns '' when git or the repository isn't there. */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: path.join(__dirname, '..'), timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (e) {
    return '';
  }
}

/**
 * The build's label, such as "2026-11-05 (8a0f13e)", or '' when it can't be told.
 * @returns {string}
 */
function readVersion() {
  const date = git(['log', '-1', '--format=%cs']);
  const commit = git(['rev-parse', '--short', 'HEAD']) || String(process.env.RENDER_GIT_COMMIT || '').slice(0, 7);
  if (date && commit) return `${date} (${commit})`;
  return date || commit;
}

module.exports = readVersion();
