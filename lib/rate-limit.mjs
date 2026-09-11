/**
 * Token-bucket rate limiting with a small per-IP cache.
 *
 * Each bucket refills at `rate` tokens per second up to `capacity`. A request
 * consumes one token; when the bucket is empty the request is rate-limited.
 * Per-IP buckets are pruned so the map cannot grow without bound.
 */
export class TokenBucket {
  constructor({ capacity, rate, windowMs = 60_000 }) {
    this.capacity = capacity;
    this.rate = rate;
    this.windowMs = windowMs;
    this._buckets = new Map();
  }

  _bucket(key) {
    let entry = this._buckets.get(key);
    const now = Date.now();
    if (!entry || now - entry.stamp >= this.windowMs) {
      entry = { tokens: this.capacity, stamp: now };
      this._buckets.set(key, entry);
    }
    const elapsed = (now - entry.stamp) / 1000;
    entry.tokens = Math.min(this.capacity, entry.tokens + elapsed * this.rate);
    entry.stamp = now;
    return entry;
  }

  tryConsume(key) {
    const entry = this._bucket(key);
    if (entry.tokens >= 1) {
      entry.tokens -= 1;
      return { allowed: true, retryAfter: 0 };
    }
    const refill = (1 - entry.tokens) / this.rate;
    return { allowed: false, retryAfter: Math.max(1, Math.ceil(refill)) };
  }

  size() {
    return this._buckets.size;
  }

  prune() {
    const now = Date.now();
    for (const [key, entry] of this._buckets) {
      if (now - entry.stamp > this.windowMs) this._buckets.delete(key);
    }
  }
}

/**
 * Simple per-second center: applies a global ceiling plus a per-client ceiling.
 */
export class RateLimiter {
  /**
   * @param {object} opts
   * @param {number} opts.globalCapacity max requests per window across all clients
   * @param {number} opts.perIpCapacity max requests per window per client
   * @param {number} opts.rate refill tokens/second
   * @param {number} opts.windowMs sliding window length
   */
  constructor(opts = {}) {
    this.global = new TokenBucket({
      capacity: opts.globalCapacity ?? 120,
      rate: opts.rate ?? opts.globalCapacity ?? 120,
      windowMs: opts.windowMs ?? 60_000,
    });
    this.perIp = new TokenBucket({
      capacity: opts.perIpCapacity ?? 40,
      rate: opts.rate ?? opts.perIpCapacity ?? 40,
      windowMs: opts.windowMs ?? 60_000,
    });
    this._pruneTimer = setInterval(() => {
      this.global.prune();
      this.perIp.prune();
    }, this.windowMs).unref?.();
  }

  clientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const first = String(forwarded).split(',')[0].trim();
      if (first) return first;
    }
    const socket = req.socket;
    return socket?.remoteAddress || socket?.localAddress || '0.0.0.0';
  }

  /**
   * @returns {{allowed:boolean, retryAfter:number}}
   */
  check(req) {
    const global = this.global.tryConsume('global');
    if (!global.allowed) return global;
    const ip = this.clientIp(req);
    const perIp = this.perIp.tryConsume(ip);
    if (!perIp.allowed) return { ...perIp, scope: 'per-ip' };
    return { allowed: true, retryAfter: 0 };
  }
}

export function rateLimitResponse(res, retryAfter) {
  if (!res.headersSent) {
    res.writeHead(429, {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': String(retryAfter),
    });
  }
  try { res.end(JSON.stringify({ error: 'Too many requests. Try again shortly.' })); } catch {}
}