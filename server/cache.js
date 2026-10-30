/**
 * @fileoverview Small in-memory TTL + LRU cache for upstream lookups (searches, Archive items).
 * Entries expire after their TTL, and the least recently used one goes once the cap is reached.
 * The pending promise is cached too, so identical requests made at the same time share one
 * upstream call. A failed lookup is not kept, so the next caller tries again.
 * @module server/cache
 */

class TtlCache {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxEntries=500] - Most entries kept at once.
   */
  constructor({ maxEntries = 500 } = {}) {
    this.maxEntries = maxEntries;
    this.map = new Map();
  }

  /**
   * @param {string} key
   * @returns {*} The cached value, or undefined if missing or expired.
   */
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Re-insert to mark it most recently used (a Map keeps insertion order).
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /**
   * @param {string} key
   * @param {*} value
   * @param {number} ttlMs - How long the entry lives, in milliseconds.
   * @returns {*} The value.
   */
  set(key, value, ttlMs) {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value);
    return value;
  }

  /** @param {string} key */
  delete(key) {
    this.map.delete(key);
  }

  /**
   * Returns the cached result for a key, or runs the producer and caches what it returns.
   * @param {string} key
   * @param {number} ttlMs
   * @param {function(): Promise<*>} producer
   * @returns {Promise<*>}
   */
  async remember(key, ttlMs, producer) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const promise = Promise.resolve().then(producer);
    this.set(key, promise, ttlMs);
    try {
      const value = await promise;
      this.set(key, value, ttlMs);
      return value;
    } catch (err) {
      this.delete(key);
      throw err;
    }
  }
}

module.exports = { TtlCache };
