// personalDB.js
import { Sequelize, DataTypes } from "sequelize";
import config from "../../config.js";
import cache from "../cache.js"; // the cache.js above

// Toggle auto-migration via env var AUTO_MIGRATE (default true)
const AUTO_MIGRATE = (process.env.AUTO_MIGRATE ?? "true").toLowerCase() !== "false";

// Field definitions (fieldName: type)
const FIELD_TYPES = {
  mention: "object",
  autoreact: "string",
  ban: "string",
  alive: "string",
  login: "string",
  shutoff: "string",
  owner_updt: "string",
  commit_key: "string",
  sticker_cmd: "object",
  plugins: "object",
  toggle: "object",
  autostatus: "string",
  autotyping: "string",
  autostatus_react: "string",
  autostatus_seen: "string",
  chatbot: "object",
  always_online: "string",
  status_view: "string",
  save_status: "string",
  anticall: "string",
  autoread: "string",
  autostatus_save: "string",
  autorecord: "string",
  lid_mapping: "string",
  welcome: "object",
  exit: "object", // goodbye
};

// Model definition (TEXT columns, objects stored JSON-stringified)
const personalDb = config.DATABASE.define(
  "personalDB",
  {
    number: { type: DataTypes.STRING, primaryKey: true },
    // create all fields dynamically as TEXT with sensible defaults
    ...Object.fromEntries(
      Object.keys(FIELD_TYPES).map((k) => {
        const def =
          FIELD_TYPES[k] === "object"
            ? "{}"
            : k === "autostatus" || k === "autotyping" || k === "autostatus_react"
            ? "false"
            : "";
        return [k, { type: DataTypes.TEXT, allowNull: true, defaultValue: def }];
      })
    ),
  },
  { timestamps: true }
);

// Auto-migration: add missing columns or create table
async function ensureAutoMigration() {
  if (!AUTO_MIGRATE) return;
  const queryInterface = config.DATABASE.getQueryInterface();
  try {
    const tableInfo = await queryInterface.describeTable(personalDb.tableName);
    const attrs = personalDb.rawAttributes;
    for (const field in attrs) {
      if (!Object.prototype.hasOwnProperty.call(tableInfo, field)) {
        const attr = attrs[field];
        const columnDef = {
          type: attr.type,
          allowNull: attr.allowNull === undefined ? true : attr.allowNull,
        };
        if (attr.defaultValue !== undefined) columnDef.defaultValue = attr.defaultValue;
        try {
          console.log(`Auto-migration: adding column '${field}'`);
          await queryInterface.addColumn(personalDb.tableName, field, columnDef);
        } catch (e) {
          console.warn(`Auto-migration failed for ${field}:`, e?.message || e);
        }
      }
    }
  } catch (e) {
    // table not present -> create via sync({ alter: true })
    try {
      console.warn("Auto-migration: table not found, syncing model...");
      await personalDb.sync({ alter: true });
      console.log("Auto-migration: table created/synced");
    } catch (err) {
      console.error("Auto-migration: sync failed:", err?.message || err);
    }
  }
}

// run auto-migration after cache init (in parallel)
(async () => {
  try {
    await cache.init();
  } catch (e) {
    console.warn("Cache init error:", e?.message || e);
  }
  if (AUTO_MIGRATE) {
    try {
      await ensureAutoMigration();
    } catch (e) {
      console.warn("Auto-migration error:", e?.message || e);
    }
  }
})();

// Helper: cache key
const buildKey = (num, field) => `personal:${num}:${field}`;

// Validate requested fields list and map to types
function normalizeRequested(fields) {
  if (!Array.isArray(fields)) fields = [fields];
  return fields.filter((f) => typeof f === "string" && FIELD_TYPES[f]);
}

/**
 * personalDB(typesArray, options = {}, method = "get", number)
 *
 * typesArray: array of field names to operate on (e.g. ['welcome','welcome2'])
 * method: 'get' | 'set' | 'add' | 'delete'
 * options.content: for set/add/delete payload
 *
 * Behavior:
 * - GET: single DB read + cache.mget; returns object { field: value, ... }
 * - SET: updates one field (object types are JSON.stringified)
 * - ADD: merges into object field (object only)
 * - DELETE: delete key entry from object field (object only)
 */
async function personalDB(types, options = {}, method = "get", number = null) {
  if (!number) {
    console.error("personalDB: number required");
    return null;
  }
  const methodLower = (method || "get").toLowerCase();
  if (!["get", "set", "add", "delete"].includes(methodLower)) {
    console.error("personalDB: invalid method", methodLower);
    return null;
  }

  const fields = normalizeRequested(types);
  if (fields.length === 0) {
    console.error("personalDB: no valid fields requested", types);
    return null;
  }

  // Fast-path: if method is set/add/delete and multiple fields passed, only first is used
  const field = fields[0];

  try {
    // --- GET (batch) ---
    if (methodLower === "get") {
      const keys = fields.map((f) => buildKey(number, f));
      const cached = await cache.mget(keys); // returns array
      const result = {};
      const misses = [];
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        const type = FIELD_TYPES[f];
        const raw = cached && Array.isArray(cached) ? cached[i] : null;
        if (raw != null) {
          // cache stores string for both object and string types
          if (type === "object") {
            try {
              result[f] = JSON.parse(raw);
            } catch (e) {
              result[f] = {};
            }
          } else {
            result[f] = raw;
          }
        } else {
          misses.push(f);
        }
      }

      if (misses.length === 0) return result;

      // fetch DB row once for misses
      const row = await personalDb.findByPk(number);
      if (!row) {
        // no DB row -> return defaults
        for (const m of misses) result[m] = FIELD_TYPES[m] === "object" ? {} : "";
        // also seed cache to avoid repeated DB hits
        for (const m of misses) {
          const strVal = FIELD_TYPES[m] === "object" ? "{}" : "";
          await cache.set(buildKey(number, m), strVal, 300).catch(() => {});
        }
        return result;
      }

      // fill misses from DB and set cache
      for (const m of misses) {
        const rawDb = row.dataValues[m];
        if (FIELD_TYPES[m] === "object") {
          try {
            result[m] = rawDb ? JSON.parse(rawDb) : {};
          } catch (e) {
            result[m] = {};
          }
          await cache.set(buildKey(number, m), JSON.stringify(result[m]), 300).catch(() => {});
        } else {
          result[m] = rawDb ?? "";
          await cache.set(buildKey(number, m), result[m], 300).catch(() => {});
        }
      }
      return result;
    }

    // For SET/ADD/DELETE ensure DB row exists
    let row = await personalDb.findByPk(number);
    if (!row && ["set", "add"].includes(methodLower)) {
      // create minimal row with number and target field
      const toCreate = { number };
      toCreate[field] = FIELD_TYPES[field] === "object" ? "{}" : "";
      try {
        // include timestamps to satisfy DBs that have createdAt/updatedAt NOT NULL
        row = await personalDb.create({ ...toCreate, createdAt: new Date(), updatedAt: new Date() });
      } catch (e) {
        // race: another process may have created it; fetch again
        row = await personalDb.findByPk(number);
        if (!row) throw e;
      }
    }

    // --- SET ---
    if (methodLower === "set") {
      let content = options.content;
      if (FIELD_TYPES[field] === "object") {
        // accept object or JSON string
        if (typeof content !== "string") content = JSON.stringify(content ?? {});
        // ensure valid JSON
        try {
          JSON.parse(content);
        } catch (e) {
          content = "{}";
        }
      } else {
        if (content == null) content = "";
        if (typeof content !== "string") content = String(content);
      }

      await (row
        ? row.update({ [field]: content })
        : personalDb.create({ number, [field]: content, createdAt: new Date(), updatedAt: new Date() })
      );
      await cache.set(buildKey(number, field), content, 300).catch(() => {});
      return true;
    }

    // --- ADD (merge object) ---
    if (methodLower === "add") {
      if (FIELD_TYPES[field] !== "object") {
        console.error("personalDB: ADD only allowed for object fields");
        return false;
      }
      const oldStr = row.dataValues[field] ?? "{}";
      let oldObj;
      try {
        oldObj = JSON.parse(oldStr);
      } catch (e) {
        oldObj = {};
      }
      const adding = options.content && typeof options.content === "object" ? options.content : {};
      // shallow merge
      Object.assign(oldObj, adding);
      const mergedStr = JSON.stringify(oldObj);
      await row.update({ [field]: mergedStr });
      await cache.set(buildKey(number, field), mergedStr, 300).catch(() => {});
      return oldObj;
    }

    // --- DELETE (delete key from object) ---
    if (methodLower === "delete") {
      if (FIELD_TYPES[field] !== "object") {
        console.error("personalDB: DELETE only allowed for object fields");
        return false;
      }
      const id = options?.content?.id;
      if (!id) return false;
      const curStr = row.dataValues[field] ?? "{}";
      let curObj;
      try {
        curObj = JSON.parse(curStr);
      } catch (e) {
        curObj = {};
      }
      if (!Object.prototype.hasOwnProperty.call(curObj, id)) return false;
      delete curObj[id];
      const newStr = JSON.stringify(curObj);
      await row.update({ [field]: newStr });
      await cache.set(buildKey(number, field), newStr, 300).catch(() => {});
      return true;
    }
  } catch (err) {
    console.error("personalDB Error:", err?.message || err);
    return null;
  }
}

export { personalDB, personalDb, FIELD_TYPES };
export default personalDB;