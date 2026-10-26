/**
 * @fileoverview The player's blacklist: people (by Banter user ID, not name) who can't control
 * Fire-V-Player in any world. They can still watch, but every control is refused, and their own
 * player is held at full volume (see Core.setBlocked in public/core.js).
 *
 * The list is kept in the database (table blocked_users) and in memory. It's managed from
 * /admin.html, whose API needs the ADMIN_PASSWORD_HASH environment variable (made by
 * `npm run hash-password`, see server/hash-password.js), or the password itself in ADMIN_PASSWORD.
 * Without either the API is off.
 *
 * The user ID is the one each client reports for itself (Banter's localUser.uid), so this stops
 * people using the normal client; a modified client could still report someone else's ID.
 * @module server/blacklist
 */

const crypto = require('crypto');
const express = require('express');
const Commands = require('../public/commands.js');

/** How many recently seen people the admin page lists. */
const RECENT_LIMIT = 300;
/** Wrong passwords allowed per address before it has to wait. */
const MAX_FAILED_LOGINS = 5;
const FAILED_LOGIN_WINDOW_MS = 10 * 60 * 1000;

/**
 * Messages a blocked person's player may still send. They come from the player itself, not from
 * a button, and keep their screen in step with everyone else's.
 */
const ALLOWED_WHEN_BLOCKED = new Set([
  Commands.INSTANCE,
  Commands.SET_WS_TYPE,
  Commands.REQUEST_STATE,
  Commands.REQUEST_SYNC,
  Commands.USER_VIDEO_PLAYER,
  Commands.SET_INSTANCE_MODE,     // follows the snippet / space admin's mode, sent on connect
  Commands.MEDIA_DURATION,        // a player reporting how long a file is
  Commands.VIDEO_UNAVAILABLE,     // a player reporting it can't play the video
  Commands.CLICK_BROWSER,         // a player asking for a click on its own screen (Twitch)
  Commands.AUTO_SYNC_STATE_CHANGED
]);

/** A Banter user ID as a plain string, or '' if it isn't one. */
const cleanId = (id) => (typeof id === 'string' || typeof id === 'number') ? String(id).trim().slice(0, 128) : '';
const cleanText = (s, max) => (typeof s === 'string' ? s.trim().slice(0, max) : '');

class Blacklist {
  /**
   * @param {Object} app - The App (server/app.js), for its players, sockets and database flag.
   * @param {Object} models - Sequelize models (server/models).
   */
  constructor(app, models) {
    this.app = app;
    this.models = models;
    /** @type {Map<string, {id: string, name: string, reason: string, addedAt: number}>} */
    this.blocked = new Map();
    /** @type {Map<string, {id: string, name: string, lastSeen: number, instance: string}>} */
    this.recent = new Map();
    /** @type {Map<string, {count: number, since: number}>} */
    this.failedLogins = new Map();
  }

  /** Loads the list from the database. */
  async load() {
    if (!this.app.dbConnected || !this.models.BlockedUser) return;
    try {
      const rows = await this.models.BlockedUser.findAll({ raw: true });
      this.blocked.clear();
      rows.forEach(r => this.blocked.set(r.userId, {
        id: r.userId, name: r.name || '', reason: r.reason || '', addedAt: new Date(r.createdAt).getTime() || 0
      }));
      console.log(`[BLACKLIST] Loaded ${this.blocked.size} blocked user(s).`);
    } catch (err) {
      console.error('[BLACKLIST] Could not load the blacklist:', err.message);
    }
  }

  has(id) {
    const key = cleanId(id);
    return !!key && this.blocked.has(key);
  }

  /**
   * Whether a message must be dropped: it's from a blocked person and isn't one their player sends
   * by itself. Dropped silently, so the player just looks frozen to them.
   */
  refuses(msg, ws) {
    const user = (msg.path === Commands.INSTANCE && msg.u) ? msg.u : ws.u;
    if (!user || !this.has(user.id)) return false;
    if (ALLOWED_WHEN_BLOCKED.has(msg.path)) return false;
    // The player loading the default playlist into an empty room, not a person loading one.
    if (msg.path === Commands.FROM_PLAYLIST && msg.data && msg.data.fromPlayer === true && !msg.data.shouldClear) return false;
    return true;
  }

  /** Notes who connected, so the admin page can list them by name. */
  seen(user, instanceId) {
    const id = cleanId(user && user.id);
    if (!id) return;
    this.recent.delete(id); // so it moves to the end (the newest)
    this.recent.set(id, { id, name: cleanText(user.name, 100), lastSeen: Date.now(), instance: cleanText(instanceId, 300) });
    while (this.recent.size > RECENT_LIMIT) this.recent.delete(this.recent.keys().next().value);
  }

  async add(id, name, reason) {
    const key = cleanId(id);
    if (!key) throw new Error('A user ID is needed.');
    const known = this.recent.get(key);
    const entry = {
      id: key,
      name: cleanText(name, 100) || (known && known.name) || '',
      reason: cleanText(reason, 300),
      addedAt: Date.now()
    };
    if (this.app.dbConnected && this.models.BlockedUser) {
      await this.models.BlockedUser.upsert({ userId: entry.id, name: entry.name, reason: entry.reason });
    }
    this.blocked.set(key, entry);
    console.log(`[BLACKLIST] Blocked ${entry.name || 'unknown'} (${key}).`);
    this.applyToConnected(key, true);
    return entry;
  }

  async remove(id) {
    const key = cleanId(id);
    if (!key || !this.blocked.has(key)) return false;
    if (this.app.dbConnected && this.models.BlockedUser) {
      await this.models.BlockedUser.destroy({ where: { userId: key } });
    }
    this.blocked.delete(key);
    console.log(`[BLACKLIST] Unblocked ${key}.`);
    this.applyToConnected(key, false);
    return true;
  }

  /** Tells one socket whether its person is blocked. Only the in-world player acts on it. */
  tell(ws) {
    if (ws && ws.u) this.app.send(ws, Commands.SET_BLOCKED, { blocked: this.has(ws.u.id) });
  }

  /**
   * Applies a change straight away to anyone connected with that ID: tells their players, and when
   * they're blocked, takes away what they already have (being host, votes, a place in the queue).
   */
  applyToConnected(id, blocked) {
    const players = this.app.videoPlayers;
    for (const instanceId in players) {
      const player = players[instanceId];
      player.sockets.filter(s => s.u && cleanId(s.u.id) === id).forEach(s => this.tell(s));
      if (!blocked) continue;

      // Anyone can take over from a blocked host.
      if (player.host && cleanId(player.host.id) === id && !player.canTakeOver) {
        player.canTakeOver = true;
        player.sockets.forEach(s => this.app.send(s, Commands.CAN_TAKE_OVER_STATE_CHANGED, { canTakeOver: true }));
        this.app.savePlayerState(instanceId);
      }
      const votes = player.votes.length;
      player.votes = player.votes.filter(v => !(v.u && cleanId(v.u.id) === id));
      if (votes !== player.votes.length) {
        this.app.updateVotes(instanceId);
        player.sockets.forEach(s => this.app.send(s, Commands.PLAYLIST_UPDATED, { playlist: player.playlist, currentTrack: player.currentTrack }));
      }
      const singers = (player.singers || []).length;
      player.singers = (player.singers || []).filter(s => !(s.user && cleanId(s.user.id) === id));
      if (singers !== player.singers.length) {
        this.app.broadcastSingerList(instanceId);
        this.app.savePlayerState(instanceId);
      }
    }
  }

  // ------------------------------------------------------------------ admin API

  /** Whether an admin password is set up (ADMIN_PASSWORD_HASH, or ADMIN_PASSWORD). */
  adminConfigured() {
    return !!(process.env.ADMIN_PASSWORD_HASH || process.env.ADMIN_PASSWORD);
  }

  /**
   * Checks a password without giving away how much of it matched. ADMIN_PASSWORD_HASH holds
   * "scrypt:N:r:p:<salt>:<hash>" (base64), from `npm run hash-password`. ADMIN_PASSWORD, the
   * password itself, still works when there's no hash.
   */
  async passwordMatches(given) {
    given = String(given || '');
    const stored = (process.env.ADMIN_PASSWORD_HASH || '').trim();
    if (stored) {
      const parts = stored.split(':');
      const [kind, n, r, p, saltB64, hashB64] = parts;
      const N = Number(n), R = Number(r), P = Number(p);
      const salt = Buffer.from(saltB64 || '', 'base64');
      const want = Buffer.from(hashB64 || '', 'base64');
      if (parts.length !== 6 || kind !== 'scrypt' || !(N > 1 && N <= 1048576) || !(R > 0 && R <= 32) || !(P > 0 && P <= 16) || !salt.length || !want.length) {
        if (!this.warnedBadHash) console.error('[BLACKLIST] ADMIN_PASSWORD_HASH is not in the format from `npm run hash-password`, so nobody can sign in.');
        this.warnedBadHash = true;
        return false;
      }
      const got = await new Promise((resolve, reject) => crypto.scrypt(given, salt, want.length, { N, r: R, p: P, maxmem: 256 * N * R + 1024 * 1024 },
        (err, key) => (err ? reject(err) : resolve(key))));
      return crypto.timingSafeEqual(got, want);
    }
    const plain = process.env.ADMIN_PASSWORD || '';
    if (!plain) return false;
    if (!this.warnedPlain) console.warn('[BLACKLIST] The admin password is stored as plain text (ADMIN_PASSWORD). Use ADMIN_PASSWORD_HASH from `npm run hash-password` instead.');
    this.warnedPlain = true;
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(plain).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /** Middleware: needs "Authorization: Bearer <ADMIN_PASSWORD>", with a limit on wrong guesses. */
  requireAdmin() {
    return async (req, res, next) => {
      if (!this.adminConfigured()) return res.status(404).json({ error: 'The admin page is turned off. Set ADMIN_PASSWORD_HASH (from npm run hash-password) to turn it on.' });
      const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
      const now = Date.now();
      const failed = this.failedLogins.get(ip);
      if (failed && now - failed.since > FAILED_LOGIN_WINDOW_MS) this.failedLogins.delete(ip);
      const tries = this.failedLogins.get(ip) || { count: 0, since: now };
      if (tries.count >= MAX_FAILED_LOGINS) {
        return res.status(429).json({ error: 'Too many wrong passwords. Try again in 10 minutes.' });
      }
      // Counted before the (slow) check, so a burst of requests can't all get past the limit.
      tries.count++;
      this.failedLogins.set(ip, tries);
      const attempt = tries.count;
      const header = req.get('authorization') || '';
      const given = header.startsWith('Bearer ') ? header.slice(7) : '';
      let ok = false;
      try { ok = await this.passwordMatches(given); } catch (err) { console.error('[BLACKLIST] Could not check the admin password:', err.message); }
      if (!ok) {
        console.warn(`[BLACKLIST] Wrong admin password from ${ip} (${attempt}).`);
        return res.status(401).json({ error: 'Wrong password.' });
      }
      this.failedLogins.delete(ip);
      next();
    };
  }

  /** Adds /admin/api/* to the Express app. */
  setupRoutes(expressApp) {
    const router = express.Router();
    router.use(express.json({ limit: '10kb' }));
    router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.use(this.requireAdmin());

    const list = () => Array.from(this.blocked.values()).sort((a, b) => b.addedAt - a.addedAt);
    const online = () => {
      const ids = new Set();
      for (const i in this.app.videoPlayers) this.app.videoPlayers[i].sockets.forEach(s => s.u && ids.add(cleanId(s.u.id)));
      return ids;
    };

    router.get('/blacklist', (req, res) => res.json({ blocked: list(), saved: !!this.app.dbConnected }));
    router.get('/recent', (req, res) => {
      const on = online();
      const people = Array.from(this.recent.values()).reverse()
        .map(p => Object.assign({}, p, { online: on.has(p.id), blocked: this.blocked.has(p.id) }));
      res.json({ recent: people });
    });
    router.post('/blacklist', async (req, res) => {
      const body = req.body || {};
      if (!cleanId(body.id)) return res.status(400).json({ error: 'A user ID is needed.' });
      try {
        res.json({ entry: await this.add(body.id, body.name, body.reason), blocked: list() });
      } catch (err) {
        console.error('[BLACKLIST] Could not block:', err);
        res.status(500).json({ error: 'Could not save it: ' + err.message });
      }
    });
    router.delete('/blacklist/:id', async (req, res) => {
      try {
        const removed = await this.remove(req.params.id);
        // 200 either way: already unblocked is fine (and the admin page signs out on a 404).
        res.json({ removed, blocked: list() });
      } catch (err) {
        console.error('[BLACKLIST] Could not unblock:', err);
        res.status(500).json({ error: 'Could not save it: ' + err.message });
      }
    });
    expressApp.use('/admin/api', router);
  }
}

module.exports = { Blacklist, ALLOWED_WHEN_BLOCKED };
