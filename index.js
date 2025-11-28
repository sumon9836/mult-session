// ============================================
// index.js - Main Server (ESM + Multi-User)
// ============================================
import express from "express";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs-extra";
import { createBaileysConnection, logoutSession } from "./lib/connection.js";
import { getAllSessions as dbGetAllSessions } from './lib/database/sessions.js';
import { generatePairingCode } from "./lib/pairing.js";
import config from "./config.js";
import cache from "./lib/cache.js";
import manager from "./lib/manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

/**
 * Start a bot instance for a given number
 */
async function startBot(number) {
  try {
    console.log(`🔄 [${number}] Starting bot...`);

    const sessionDir = path.join(__dirname, "auth", number);
    await fs.ensureDir(sessionDir);

    const conn = await createBaileysConnection(number);
    if (!conn) {
      console.error(`❌ [${number}] Failed to create connection`);
      return null;
    }

    console.log(`✅ [${number}] Connection created successfully`);
    return conn;
  } catch (err) {
    console.error(`❌ Failed to start bot for ${number}:`, err);
    return null;
  }
}

/**
 * Restore all sessions from DB + local storage
 */
async function initializeSessions() {
  const baileys = await import("baileys");
  const { delay } = baileys;

  try {
    console.log("🌱 Initializing bot sessions...");

    const baseDir = path.join(__dirname, "auth");
    await fs.ensureDir(baseDir);

    // Ensure DB sessions are reflected on disk so multi-file auth can load
    try {
      const dbSessions = await dbGetAllSessions();
      for (const s of dbSessions) {
        const number = String(s.number);
        const authDir = path.join(baseDir, number);
        const credsPath = path.join(authDir, 'creds.json');
        try {
          await fs.ensureDir(authDir);
          // If creds.json missing, write creds from DB
          if (!(await fs.pathExists(credsPath)) && s.creds) {
            await fs.writeJSON(credsPath, s.creds, { spaces: 2 });
          }
        } catch (e) {
          console.warn(`⚠️ Failed to materialize DB session ${number} to disk:`, e.message);
        }
      }
    } catch (e) {
      // ignore DB read errors
    }

    // Get all session folders
    const folders = await fs.readdir(baseDir);
    const sessionNumbers = folders.filter((f) =>
      fs.existsSync(path.join(baseDir, f, "creds.json"))
    );

    if (!sessionNumbers.length) {
      console.log("⚠️ No existing sessions found. Use /pair endpoint to add new sessions.");
      return;
    }

    console.log(
      `♻️ Restoring ${sessionNumbers.length} sessions...`
    );

    // Restore sessions with delay to avoid rate limits
    for (const number of sessionNumbers) {
      try {
        console.log(`🔄 Restoring session for ${number}...`);
        await startBot(number);
        await delay(2000); // Delay between session starts
      } catch (err) {
        // Do NOT delete session on temporary error
        console.error(`❌ Failed restoring session for ${number}:`, err);
        // Log to a file for admin review
        try {
          await fs.appendFile(
            path.join(__dirname, "restore-errors.log"),
            `[${new Date().toISOString()}] Session ${number} restore failed: ${err.message}\n`
          );
        } catch (logErr) {
          console.error("❌ Failed to log restore error:", logErr);
        }
      }
    }

    console.log(`✅ Initialization complete.  sessions active.`);
  } catch (err) {
    console.error("❌ initializeSessions() failed:", err);
  }
}

// ==================== ROUTES ====================

/**
 * Pair new device endpoint
 */
app.get("/pair", async (req, res) => {
  try {
    const { number } = req.query;
    if (!number) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required (e.g., ?number=1234567890)",
      });
    }
      // Check connection status efficiently
  if (manager.isConnected(number)) {
    return res.status(408).json({
      status: "false",
      message: "This number is already connected",
    });
  }

  if (manager.isConnecting(number)) {
    return res.status(409).json({
      status: "error",
      message: "This number is already in pairing process",
    });
  }
    const sessionId = number.replace(/[^0-9]/g, "");
    const pairingCode = await generatePairingCode(sessionId, number);

    res.json({
      success: true,
      sessionId,
      pairingCode,
      message:
        "Enter this code in WhatsApp: Settings > Linked Devices > Link a Device",
    });
  } catch (error) {
    console.error("Pairing error:", error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/**
 * Logout endpoint
 */
app.get("/logout", async (req, res) => {
  try {
    const { number } = req.query;

    if (!number) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required",
      });
    }

    const sessionId = number.replace(/[^0-9]/g, "");

    console.log(`🚪 /logout initiated for ${sessionId}`);
    const success = await logoutSession(sessionId);
    if (success) {
      console.log(`✅ /logout completed for ${sessionId}`);
      res.json({
        success: true,
        message: `Session ${sessionId} logged out successfully`,
      });
    } else {
      console.warn(`⚠️ /logout: Session ${sessionId} not found or already logged out`);
      res.status(404).json({
        success: false,
        message: "Session not found",
      });
    }
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/**
 * Reconnect endpoint
 */
app.get("/reconnect", async (req, res) => {
  try {
    const { number } = req.query;

    if (!number) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required",
      });
    }

    const sessionId = number.replace(/[^0-9]/g, "");

    // Logout first
    await logoutSession(sessionId);
    await new Promise((r) => setTimeout(r, 1000));

    // Reconnect
    const sock = await createBaileysConnection(sessionId);
    if (sock) {
      res.json({
        success: true,
        message: `Session ${sessionId} reconnected successfully`,
      });
    } else {
      throw new Error("Failed to reconnect");
    }
  } catch (error) {
    console.error("Reconnect error:", error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.get("/sessions", (req, res) => {
  const sessions = {};
  const allConnections = manager.getAllConnections();
  allConnections.forEach(({ file_path, connection, healthy }) => {
    sessions[file_path] = {
      connected: healthy,
      user: connection?.user?.name || "unknown",
      jid: connection?.user?.id || null,
      healthy: healthy,
    };
  });
  res.json({
    total: Object.keys(sessions).length,
    healthy: allConnections.filter((c) => c.healthy).length,
    sessions,
  });
});

// ==================== STARTUP ====================

app.listen(PORT, async () => {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`${"=".repeat(50)}`);
  console.log(`📱 Pair new device: http://localhost:${PORT}/pair?number=YOUR_NUMBER`);
  console.log(`📊 Check status: http://localhost:${PORT}/status`);
  console.log(`🚪 Logout: http://localhost:${PORT}/logout?number=YOUR_NUMBER`);
  console.log(`🔄 Reconnect: http://localhost:${PORT}/reconnect?number=YOUR_NUMBER`);
  console.log(`${"=".repeat(50)}\n`);

  // Initialize existing sessions
  try {
    // Initialize cache (Redis or in-memory fallback)
    try {
      await cache.init();
    } catch (e) {
      console.warn('⚠️ Cache init failed:', e.message);
    }

    // Ensure database tables are created
    if (config?.DATABASE && typeof config.DATABASE.sync === 'function') {
      await config.DATABASE.sync();
      console.log('✅ Database synced');
    }
  } catch (dbErr) {
    console.error('❌ Failed to sync database:', dbErr.message);
  }

  await initializeSessions();
});

