import { Sequelize, DataTypes } from "sequelize";
import config from "../../config.js";
import cache from "../cache.js";

const methods = ["get", "set", "add", "delete"];

// Allowed type definitions
const types = [
  { bot: "string" }, { delete: "string" }, { fake: "object" },
  { link: "string" }, { word: "object" }, { demote: "string" },
  { promote: "string" }, { filter: "object" }, { warn: "object" },
  { welcome: "object" }, { exit: "object" }, { pdm: "string" },
  { chatbot: "object" }
];

// Helper: merge JSON objects
function jsonConcat(o1, o2) {
  for (const key in o2) o1[key] = o2[key];
  return o1;
}

/* ============================================================
   DATABASE MODEL (OPTIMIZED)
   ============================================================ */
const groupDb = config.DATABASE.define(
  "groupDB",
  {
    jid: {
      type: DataTypes.STRING,
      allowNull: false
    },
    bot: { type: DataTypes.STRING, allowNull: true, defaultValue: "false" },
    delete: { type: DataTypes.STRING, allowNull: true, defaultValue: "false" },
    fake: { type: DataTypes.TEXT, allowNull: true, defaultValue: "{}" },
    link: { type: DataTypes.STRING, allowNull: true, defaultValue: "false" },
    word: { type: DataTypes.TEXT, allowNull: true, defaultValue: "{}" },
    demote: { type: DataTypes.STRING, allowNull: true, defaultValue: "false" },
    promote: { type: DataTypes.STRING, allowNull: true, defaultValue: "false" },
    filter: { type: DataTypes.TEXT, allowNull: true, defaultValue: "{}" },
    warn: { type: DataTypes.TEXT, allowNull: true, defaultValue: "{}" },

    // FIXED: welcome MUST be TEXT and ALWAYS JSON
    welcome: { type: DataTypes.TEXT, allowNull: true, defaultValue: "{}" },
    exit: { type: DataTypes.TEXT, allowNull: true, defaultValue: "{}" },

    chatbot: { type: DataTypes.TEXT, allowNull: true, defaultValue: "{}" },
    pdm: { type: DataTypes.STRING, allowNull: true, defaultValue: "false" }
  },
  { timestamps: true }
);

/* ============================================================
   AUTO-MIGRATION (NEVER BREAK DB)
   ============================================================ */
async function migrate() {
  const qi = config.DATABASE.getQueryInterface();
  const table = await qi.describeTable("groupDB");

  const needed = {
    fake: "TEXT",
    word: "TEXT",
    filter: "TEXT",
    warn: "TEXT",
    welcome: "TEXT",
    exit: "TEXT",
    chatbot: "TEXT"
  };

  for (const col in needed) {
    if (!table[col]) {
      console.log(`🛠 Adding column: groupDB.${col}`);
      await qi.addColumn("groupDB", col, {
        type: DataTypes[needed[col]],
        allowNull: true,
        defaultValue: "{}"
      });
    }
  }
}

migrate().catch(() => {});

/* ============================================================
   MAIN groupDB FUNCTION — ULTRA FAST VERSION
   ============================================================ */

async function groupDB(type, options, method) {
  if (!Array.isArray(type) || typeof options !== "object" || !options.jid) return;

  let filter = type.map((t) => types.find((a) => a[t])).filter(Boolean);
  if (!filter.length || !methods.includes(method)) return;

  if (["set", "add", "delete"].includes(method)) {
    filter = filter[0];
    type = type[0];
  }

  // Get DB row ONCE
  const dbData = await groupDb.findOne({ where: { jid: options.jid } });

  /* ============================================================
     SET
     ============================================================ */
  if (method === "set") {
    if (typeof options.content !== filter[type]) return;

    const content =
      filter[type] === "object"
        ? JSON.stringify(options.content)
        : options.content;

    if (!dbData) {
      await groupDb.create({ jid: options.jid, [type]: content });
    } else {
      await dbData.update({ [type]: content });
    }

    await cache.set(`group:${options.jid}:${type}`, content, 300);
    return true;
  }

  /* ============================================================
     ADD
     ============================================================ */
  if (method === "add") {
    let existing =
      dbData?.dataValues[type] ||
      (filter[type] === "object" ? "{}" : "");

    if (filter[type] === "object") {
      const merged = JSON.stringify(
        jsonConcat(JSON.parse(existing || "{}"), options.content)
      );

      if (dbData) await dbData.update({ [type]: merged });
      else await groupDb.create({ jid: options.jid, [type]: merged });

      await cache.set(`group:${options.jid}:${type}`, merged, 300);
      return JSON.parse(merged);
    } else {
      if (dbData) await dbData.update({ [type]: options.content });
      else await groupDb.create({ jid: options.jid, [type]: options.content });

      await cache.set(`group:${options.jid}:${type}`, options.content, 300);
      return options.content;
    }
  }

  /* ============================================================
     DELETE (JSON OBJECT)
     ============================================================ */
  if (method === "delete") {
    if (!dbData || !options.content?.id || filter[type] !== "object")
      return false;

    const json = JSON.parse(dbData.dataValues[type] || "{}");
    if (!json[options.content.id]) return false;

    delete json[options.content.id];
    const updated = JSON.stringify(json);

    await dbData.update({ [type]: updated });
    await cache.set(`group:${options.jid}:${type}`, updated, 300);
    return true;
  }

  /* ============================================================
     GET — ULTRA FAST CACHE FIRST
     ============================================================ */
  if (method === "get") {
    const keys = filter.map((f) => {
      let k = Object.keys(f)[0];
      return `group:${options.jid}:${k}`;
    });

    const cached = await cache.mget(keys);

    const result = {};

    let i = 0;
    for (const f of filter) {
      const k = Object.keys(f)[0];
      const isObj = f[k] === "object";

      if (cached[i]) {
        try {
          result[k] = isObj ? JSON.parse(cached[i]) : cached[i];
        } catch {
          result[k] = isObj ? {} : cached[i];
        }
        i++;
        continue;
      }

      const dbVal = dbData?.dataValues[k];
      if (!dbVal) {
        result[k] = isObj ? {} : "false";
      } else {
        result[k] = isObj ? JSON.parse(dbVal || "{}") : dbVal;
        await cache.set(
          `group:${options.jid}:${k}`,
          isObj ? JSON.stringify(result[k]) : result[k],
          300
        );
      }
      i++;
    }
    return result;
  }

  return;
}

export { groupDB };