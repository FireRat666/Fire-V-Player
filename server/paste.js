/**
 * @fileoverview Paste from your phone. Typing a link on a headset is hard, so a person in a world
 * can ask for a short code, open /paste on their phone, enter the code and send a link. The link
 * only goes into that person's own search box in the world: it never adds anything to a playlist,
 * so they still press Add (and the lock and karaoke approval rules still apply).
 * @module server/paste
 */

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const Commands = require('../public/commands.js');

/** How long a code works. */
const CODE_TTL_MS = 10 * 60 * 1000;
/** Letters and digits that can't be mistaken for each other (no 0/O, 1/I/L). */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
/** Wrong codes allowed from one address, per window, before it has to wait. */
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
/** The longest text a phone can send. */
const MAX_TEXT = 2000;

class PasteCodes {
  /**
   * @param {Object} app - The server App (for app.send).
   */
  constructor(app) {
    this.app = app;
    this.codes = new Map(); // code -> { ws, expiresAt }
    this.fails = new Map(); // ip -> { count, resetAt }
    this.sweeper = setInterval(() => this.sweep(), 60 * 1000);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  makeCode() {
    for (;;) {
      let code = '';
      for (let k = 0; k < CODE_LENGTH; k++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
      if (!this.codes.has(code)) return code;
    }
  }

  /**
   * Gives this connection a code, replacing any it had. Sends PASTE_CODE back to it.
   * @param {Object} ws - The person's UI socket.
   */
  issue(ws) {
    if (!ws || !ws.u) return;
    this.drop(ws);
    const code = this.makeCode();
    const expiresAt = Date.now() + CODE_TTL_MS;
    this.codes.set(code, { ws, expiresAt });
    ws.pasteCode = code;
    this.app.send(ws, Commands.PASTE_CODE, { code, expiresIn: CODE_TTL_MS });
  }

  /** Forgets this connection's code (it closed, or asked for a new one). */
  drop(ws) {
    if (ws && ws.pasteCode) {
      this.codes.delete(ws.pasteCode);
      ws.pasteCode = null;
    }
  }

  sweep() {
    const now = Date.now();
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt <= now || entry.ws.readyState !== 1) {
        this.codes.delete(code);
        if (entry.ws.pasteCode === code) entry.ws.pasteCode = null;
      }
    }
    for (const [ip, f] of this.fails) if (f.resetAt <= now) this.fails.delete(ip);
  }

  // Whether this address has had too many wrong codes lately.
  limited(ip) {
    const f = this.fails.get(ip);
    return !!(f && f.resetAt > Date.now() && f.count >= MAX_FAILS);
  }

  failed(ip) {
    const now = Date.now();
    let f = this.fails.get(ip);
    if (!f || f.resetAt <= now) f = { count: 0, resetAt: now + FAIL_WINDOW_MS };
    f.count++;
    this.fails.set(ip, f);
  }

  /**
   * POST /api/paste { code, text }: sends the text to the code's person.
   * @param {Object} expressApp
   */
  setupRoutes(expressApp) {
    const router = express.Router();
    router.use(express.json({ limit: '8kb' }));
    router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.post('/paste', (req, res) => {
      const ip = req.ip || 'unknown';
      if (this.limited(ip)) return res.status(429).json({ error: 'Too many wrong codes. Wait a few minutes and try again.' });
      const body = req.body || {};
      const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const text = String(body.text || '').trim().slice(0, MAX_TEXT);
      if (!text) return res.status(400).json({ error: 'Paste a link or some text first.' });
      const entry = this.codes.get(code);
      if (!entry || entry.expiresAt <= Date.now() || entry.ws.readyState !== 1) {
        this.failed(ip);
        return res.status(404).json({ error: "That code doesn't work. Check it, or get a new one in the world." });
      }
      this.app.send(entry.ws, Commands.PASTE_RECEIVED, { text });
      console.log(`[PASTE] Sent ${text.length} characters to ${entry.ws.u ? entry.ws.u.name : 'someone'}.`);
      res.json({ ok: true, expiresIn: Math.max(0, entry.expiresAt - Date.now()) });
    });
    expressApp.use('/api', router);
    // The phone page, at a short address to type.
    expressApp.get('/paste', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'paste.html')));
  }
}

module.exports = PasteCodes;
