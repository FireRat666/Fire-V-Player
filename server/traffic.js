/**
 * @fileoverview Counts what the server sends, and logs a summary every hour (TRAFFIC_LOG_MINUTES
 * changes how often), so the host's data transfer figures can be traced to their cause.
 *
 * Two kinds of traffic are counted:
 * - WebSocket messages, by command: their JSON size before compression, and the bytes the
 *   connections actually wrote (after compression), so the saving shows.
 * - Files (scripts, pages, images), by path: the bytes sent after gzip, and how many requests were
 *   answered "not changed" (304) because the browser already had the latest copy.
 * @module server/traffic
 */

const DEFAULT_MINUTES = 60;
const TOP = 8;
/** Most different paths counted between summaries; more are counted together as "(other)". */
const MAX_FILE_KEYS = 1000;

const mb = n => `${(n / (1024 * 1024)).toFixed(2)} MB`;

class Traffic {
  constructor() {
    this.reset();
    /** Sockets open now, to read how much each wrote since the last summary. */
    this.sockets = new Set();
  }

  reset() {
    this.startedAt = Date.now();
    this.messages = new Map(); // command -> { count, bytes } (JSON, before compression)
    this.files = new Map(); // path -> { count, bytes, notModified }
    this.pathKeys = 0; // entries in `files` that are paths, not "(not found)" and the like
    this.wireOut = 0; // bytes the WebSocket connections wrote, after compression
    this.wireIn = 0;
    this.connections = 0;
  }

  /** A message sent on a WebSocket, before compression. */
  message(path, payload) {
    const entry = this.messages.get(path) || { count: 0, bytes: 0 };
    entry.count++;
    entry.bytes += Buffer.byteLength(payload);
    this.messages.set(path, entry);
  }

  /** Starts counting a new WebSocket connection's bytes on the wire. */
  track(netSocket) {
    if (!netSocket) return;
    this.connections++;
    // Counting starts from what the connection has already carried: the host's proxy can send
    // page and file requests on a connection before upgrading it, and those are counted as files.
    const s = { net: netSocket, out: netSocket.bytesWritten || 0, in: netSocket.bytesRead || 0 };
    this.sockets.add(s);
    netSocket.once('close', () => {
      this.take(s);
      this.sockets.delete(s);
    });
  }

  take(s) {
    const out = s.net.bytesWritten || 0;
    const inn = s.net.bytesRead || 0;
    this.wireOut += out - s.out;
    this.wireIn += inn - s.in;
    s.out = out;
    s.in = inn;
  }

  /**
   * Express middleware counting each file response's bytes. It goes before the compression
   * middleware, so the bytes it sees are the gzipped ones that leave the server.
   */
  middleware() {
    return (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      let bytes = 0;
      const write = res.write;
      const end = res.end;
      res.write = function (chunk, encoding, cb) {
        if (chunk) bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined) : chunk.length;
        return write.call(this, chunk, encoding, cb);
      };
      res.end = function (chunk, encoding, cb) {
        if (chunk && typeof chunk !== 'function') bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined) : chunk.length;
        return end.call(this, chunk, encoding, cb);
      };
      res.on('finish', () => {
        // Missing pages and errors are folded, paths are cut short, and past MAX_FILE_KEYS paths
        // the rest share one entry, so requests for made-up addresses can't grow the list.
        let key;
        if (res.statusCode === 404) key = '(not found)';
        else if (res.statusCode >= 400) key = '(error)';
        else {
          key = req.path.slice(0, 80);
          if (!this.files.has(key) && this.pathKeys >= MAX_FILE_KEYS) key = '(other)';
          else if (!this.files.has(key)) this.pathKeys++;
        }
        const entry = this.files.get(key) || { count: 0, bytes: 0, notModified: 0 };
        entry.count++;
        entry.bytes += bytes;
        if (res.statusCode === 304) entry.notModified++;
        this.files.set(key, entry);
      });
      next();
    };
  }

  /** Logs what was sent since the last summary, then starts counting again. */
  report() {
    this.sockets.forEach(s => this.take(s));
    const minutes = Math.round((Date.now() - this.startedAt) / 60000);
    const raw = [...this.messages.values()].reduce((sum, e) => sum + e.bytes, 0);
    const fileBytes = [...this.files.values()].reduce((sum, e) => sum + e.bytes, 0);
    const requests = [...this.files.values()].reduce((sum, e) => sum + e.count, 0);
    const notModified = [...this.files.values()].reduce((sum, e) => sum + e.notModified, 0);
    if (!raw && !requests && !this.wireOut && !this.wireIn && !this.connections) {
      this.reset();
      return;
    }
    const saved = this.wireOut > 0 && raw > 0 ? ` (${mb(raw)} before compression)` : '';
    console.log(`[TRAFFIC] Last ${minutes} min: sent ${mb(this.wireOut + fileBytes)} in total. `
      + `WebSockets ${mb(this.wireOut)}${saved}, received ${mb(this.wireIn)}, ${this.connections} new connections, ${this.sockets.size} open. `
      + `Files ${mb(fileBytes)} in ${requests} requests, ${notModified} of them "not changed".`);
    const top = (map, line) => [...map.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, TOP).map(line).join(', ');
    if (this.messages.size) {
      console.log(`[TRAFFIC] Messages by size before compression: ${top(this.messages, ([p, e]) => `${p} ${mb(e.bytes)} x${e.count}`)}`);
    }
    if (this.files.size) {
      console.log(`[TRAFFIC] Files by size sent: ${top(this.files, ([p, e]) => `${p} ${mb(e.bytes)} x${e.count}${e.notModified ? ` (${e.notModified} not changed)` : ''}`)}`);
    }
    this.reset();
  }

  /** Starts the regular summary. */
  start() {
    const minutes = Number(process.env.TRAFFIC_LOG_MINUTES) > 0 ? Number(process.env.TRAFFIC_LOG_MINUTES) : DEFAULT_MINUTES;
    this.timer = setInterval(() => this.report(), minutes * 60 * 1000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }
}

module.exports = new Traffic();
