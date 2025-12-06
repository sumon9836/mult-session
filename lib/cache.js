// cache.js
import { createClient } from "redis";

const REDIS_URL = process.env.REDIS_URL || process.env.REDIS;
const LRU_SIZE = +(process.env.CACHE_LRU_SIZE || 2000);
const CLEANUP_INTERVAL_MS = +(process.env.CACHE_CLEANUP_MS || 30_000);

// LRU implemented via Map: insertion order = usage order (oldest first)
const mem = new Map();         // key -> string value
const expiries = new Map();    // key -> timestamp (ms)
let cleanupTimer = null;

let client = null;
let ready = false;
let backend = "memory"; // 'redis' or 'memory'
let _redisWarned = false;

async function init() {
  if (REDIS_URL) {
    try {
      client = createClient({
        url: REDIS_URL,
        socket: {
          reconnectStrategy: (retries) => {
            // aggressive but safe reconnect: 50ms for first few tries, then grow
            if (retries < 5) return 50;
            return Math.min(1000, 50 + retries * 50);
          },
          connectTimeout: 5000,
        },
      });
      client.on("error", (e) => console.warn("Redis client error:", e?.message || e));
      await client.connect();
      ready = true;
      backend = "redis";
      console.log("✅ Redis connected");
    } catch (e) {
      console.warn("⚠️ Redis connect failed, using in-memory fallback:", e?.message || e);
      client = null;
      ready = false;
    }
  }

  if (!cleanupTimer) {
    cleanupTimer = setInterval(cleanupExpired, CLEANUP_INTERVAL_MS);
    cleanupTimer.unref?.(); // allow node to exit if only this timer remains
  }
}

// LRU helpers
function promoteKey(key, value) {
  // move key to most-recent position
  if (mem.has(key)) mem.delete(key);
  mem.set(key, value);
  // enforce size
  if (mem.size > LRU_SIZE) {
    // remove oldest
    const oldest = mem.keys().next().value;
    mem.delete(oldest);
    expiries.delete(oldest);
  }
}

function cleanupExpired() {
  const now = Date.now();
  for (const [k, exp] of expiries.entries()) {
    if (exp <= now) {
      mem.delete(k);
      expiries.delete(k);
    }
  }
}

async function get(key) {
  if (ready && client) {
    try {
      // Redis returns string or null
      return await client.get(key);
    } catch (e) {
      // Redis flapped — fallback to mem
      if (!_redisWarned) {
        console.warn("Redis get error:", e?.message || e);
        _redisWarned = true;
      }
      // fallthrough to memory
    }
  }

  const exp = expiries.get(key);
  if (exp && exp <= Date.now()) {
    mem.delete(key);
    expiries.delete(key);
    return null;
  }

  const v = mem.get(key) ?? null;
  if (v !== null) promoteKey(key, v);
  return v;
}

async function mget(keys) {
  if (ready && client) {
    try {
      // redis.mGet returns array of values (strings or null)
      const vals = await client.mGet(keys);
      // ensure we always return an array with same length
      if (!Array.isArray(vals)) return keys.map(() => null);
      return vals.map((v) => (v === undefined ? null : v));
    } catch (e) {
      if (!_redisWarned) {
        console.warn("Redis mGet error:", e?.message || e);
        _redisWarned = true;
      }
      // continue to local fallback
    }
  }

  const now = Date.now();
  return keys.map((k) => {
    const exp = expiries.get(k);
    if (exp && exp <= now) {
      mem.delete(k);
      expiries.delete(k);
      return null;
    }
    const v = mem.get(k) ?? null;
    if (v !== null) promoteKey(k, v);
    return v;
  });
}

async function set(key, value, ttlSec = 300) {
  // value expected to be a string (personalDB ensures this)
  const str = typeof value === "string" ? value : String(value);

  if (ready && client) {
    try {
      if (ttlSec && ttlSec > 0) {
        await client.set(key, str, { EX: ttlSec });
      } else {
        await client.set(key, str);
      }
      return true;
    } catch (e) {
      if (!_redisWarned) {
        console.warn("Redis set error:", e?.message || e);
        _redisWarned = true;
      }
      // fallback to mem
    }
  }

  promoteKey(key, str);
  if (ttlSec && ttlSec > 0) expiries.set(key, Date.now() + ttlSec * 1000);
  else expiries.delete(key);
  return true;
}

async function del(key) {
  if (ready && client) {
    try {
      await client.del(key);
      // continue to clear local copy too
    } catch (e) {
      console.warn("Redis del error:", e?.message || e);
    }
  }
  mem.delete(key);
  expiries.delete(key);
  return true;
}

async function close() {
  if (client && ready) {
    try {
      await client.disconnect();
    } catch (e) {
      // ignore
    }
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  mem.clear();
  expiries.clear();
  ready = false;
}

export default {
  init,
  get,
  mget,
  set,
  del,
  close,
  isReady: () => ready,
  backend: () => backend,
  isRedis: () => backend === "redis",
};