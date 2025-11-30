import { DataTypes } from "sequelize";
import config from "../../config.js";
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const Session = config.DATABASE.define(
  "sessions",
  {
    number: { type: DataTypes.STRING, unique: true },
    // Use JSON for portability across SQLite and Postgres
    creds: { type: DataTypes.JSON },
    lid_mapping: { type: DataTypes.JSON, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: DataTypes.NOW },
  },
  {
    // We manage the updatedAt field manually in code, disable automatic timestamps
    timestamps: false,
  }
);

// Make sure table exists
export async function initSessions() {
  try {
    await Session.sync();
    console.log("✅ Sessions table initialized");
  } catch (err) {
    console.error("❌ Failed to initialize sessions table:", err);
  }
}

// Save/update creds
export async function saveSession(number, creds) {
  try {
    // Accept optional lid_mapping argument
    let lid_mapping = creds.lid_mapping || null;
    // Remove lid_mapping from creds if present
    if (lid_mapping) delete creds.lid_mapping;
    await Session.upsert({ number, creds, lid_mapping, updatedAt: new Date() });
    return true;
  } catch (err) {
    console.error(`❌ Failed to save session ${number}:`, err);
    return false;
  }
}

// Get one session
export async function getSession(number) {
  try {
    return await Session.findOne({ where: { number } });
  } catch (err) {
    console.error(`❌ Failed to get session ${number}:`, err);
    return null;
  }
}

// Get all sessions
export async function getAllSessions() {
  try {
    return await Session.findAll();
  } catch (err) {
    console.error("❌ Failed to get all sessions:", err);
    return [];
  }
}

// Delete session
export async function deleteSession(number) {
  try {
    await Session.destroy({ where: { number } });
    console.log(`✅ Session ${number} deleted from database`);
  } catch (err) {
    console.error(`❌ Failed to delete session ${number}:`, err);
  }
}
