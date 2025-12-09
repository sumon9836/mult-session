// ============================================
// lib/connection.js - Connection Handler (ESM + LID Mapping)
// ============================================
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  getContentType,
  jidNormalizedUser,
  Browsers,
} from "baileys";
import pino from "pino";
import { Boom } from "@hapi/boom";
import manager from "./manager.js";
import { loadPlugins } from "./plugins.js";
import { personalDB } from "./database/index.js";
import { groupDB } from "./database/index.js";
import { saveSession as dbSaveSession, deleteSession as dbDeleteSession, getSession as dbGetSession } from "./database/sessions.js";
import { persistSelectedFiles, restoreSelectedFiles } from './auth-persist.js';
import fs from 'fs-extra';
import path from 'path';
import serialize from "./serialize.js";
import config from "../config.js";
import os from 'os';
import tar from 'tar';

const sentGoodbye = new Set();

// ============================================
// GLOBAL RETRY COUNTER SYSTEM
// ============================================
const retryCounter = {}; // Track retries per sessionId
const MAX_RETRIES = 10;
const RECONNECT_DELAY_MS = 3000;

/**
 * Initialize retry counter for a session
 * @param {string} sessionId
 */
function initRetryCounter(sessionId) {
  if (!retryCounter[sessionId]) {
    retryCounter[sessionId] = 0;
  }
}

/**
 * Increment retry counter
 * @param {string} sessionId
 * @returns {number} - Updated retry count
 */
function incrementRetry(sessionId) {
  if (!retryCounter[sessionId]) {
    retryCounter[sessionId] = 0;
  }
  retryCounter[sessionId]++;
  return retryCounter[sessionId];
}

/**
 * Reset retry counter to 0
 * @param {string} sessionId
 */
function resetRetry(sessionId) {
  if (retryCounter[sessionId] !== undefined && retryCounter[sessionId] > 0) {
    console.log(`🔄 [${sessionId}] Retry counter reset from ${retryCounter[sessionId]} to 0`);
    retryCounter[sessionId] = 0;
  }
}

/**
 * Delete retry counter (permanent cleanup)
 * @param {string} sessionId
 */
function deleteRetryCounter(sessionId) {
  if (retryCounter[sessionId] !== undefined) {
    console.log(`🗑️ [${sessionId}] Retry counter deleted (permanent session removal)`);
    delete retryCounter[sessionId];
  }
}

/**
 * Get current retry count
 * @param {string} sessionId
 * @returns {number}
 */
function getRetryCount(sessionId) {
  return retryCounter[sessionId] || 0;
}

export async function createBaileysConnection(sessionId) {
  try {
    // Check if already connected
    if (manager.isConnected(sessionId)) {
      console.log(`✓ [${sessionId}] Already connected`);
      return manager.getConnection(sessionId);
    }

    // Ensure auth directory exists before useMultiFileAuthState
    const authDir = path.join(process.cwd(), 'auth', sessionId);
    await fs.ensureDir(authDir);

    const { state, saveCreds } = await useMultiFileAuthState(
      authDir
    );
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      browser: Browsers.macOS("opera"),
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(
          state.keys,
          pino({ level: "silent" })
        ),
      },
      generateHighQualityLinkPreview: true,
      getMessage: async (key) => {
        return;
      },
    });

    // ✅ LID Mapping Event Handler (Baileys v7.0.0+)
    sock.ev.on("lid-mapping.update", async (mapping) => {
      console.log(`🆔 [${sessionId}] LID mapping updated:`, Object.keys(mapping).slice(0, 3), "...");
      // Store LID mapping to maintain participant identity across device changes
      if (mapping && Object.keys(mapping).length > 0) {
        try {
          // personalDB expects payload under `options.content` for set operations
          await personalDB(
            ["lid_mapping"],
            { content: JSON.stringify(mapping) },
            "set",
            sessionId
          );
        } catch (err) {
          console.error(`❌ [${sessionId}] Error saving LID mapping:`, err.message);
        }
      }
    });

    // Initialize retry counter for this session
    initRetryCounter(sessionId);

    // ================================================================================
    // CONNECTION UPDATE HANDLER WITH RETRY LOGIC
    // ================================================================================
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (connection === "connecting") {
        console.log(`⏳ [${sessionId}] Connecting...`);
      }

      // ========== CONNECTION CLOSED ==========
      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.output?.statusCode;

        console.log(`❌ [${sessionId}] Closed: Status ${statusCode} - Reason ${reason}`);

        try {
          console.error(`❗ [${sessionId}] lastDisconnect full payload:`, JSON.stringify(lastDisconnect, null, 2));
        } catch (e) {
          console.error(`❗ [${sessionId}] lastDisconnect (raw):`, lastDisconnect);
        }

        // --------- DETERMINE IF SHOULD RECONNECT ---------
        // Check if error reason is in the NO-RECONNECT list (intentional logouts)
        const noReconnectReasons = [
          DisconnectReason.loggedOut,          // 401
          DisconnectReason.badSession,         // 403
          DisconnectReason.connectionReplaced, // 440
          DisconnectReason.forbidden,          // 403
          DisconnectReason.multideviceMismatch, // 530
        ];

        const isIntentionalLogout =
          lastDisconnect?.error instanceof Boom &&
          noReconnectReasons.includes(reason);

        // Remove from active connections
        manager.removeConnection(sessionId);

        if (isIntentionalLogout) {
          // ===== NO RECONNECT: INTENTIONAL LOGOUT =====
          console.log(`🛑 [${sessionId}] Intentional logout detected (reason: ${reason}). Not reconnecting.`);

          // Cleanup: delete session and retry counter
          try {
            await logoutSession(sessionId);
            deleteRetryCounter(sessionId);
          } catch (err) {
            console.error(`❌ [${sessionId}] Error during logout cleanup:`, err.message);
            deleteRetryCounter(sessionId);
          }
          return;
        }

        // ===== RECONNECT WITH RETRY LOGIC =====
        const currentRetry = incrementRetry(sessionId);
        console.log(`🔄 [${sessionId}] Reconnection attempt ${currentRetry}/${MAX_RETRIES}...`);

        if (currentRetry > MAX_RETRIES) {
          // ===== MAX RETRIES EXCEEDED: PERMANENT LOGOUT =====
          console.error(`💥 [${sessionId}] MAX RETRIES EXCEEDED (${MAX_RETRIES}+). Permanent session removal initiated.`);

          try {
            // Cleanup all storage
            await logoutSession(sessionId);
            deleteRetryCounter(sessionId);
            console.log(`✅ [${sessionId}] Session permanently removed after ${MAX_RETRIES} failed attempts.`);
          } catch (err) {
            console.error(`❌ [${sessionId}] Error during permanent removal:`, err.message);
            deleteRetryCounter(sessionId);
          }
          return;
        }

        // Schedule reconnection with delay
        console.log(`⏱️ [${sessionId}] Scheduling reconnect in ${RECONNECT_DELAY_MS}ms...`);
        setTimeout(async () => {
          try {
            console.log(`🔌 [${sessionId}] Attempting to reconnect...`);
            await createBaileysConnection(sessionId);
          } catch (err) {
            console.error(`❌ [${sessionId}] Reconnection failed:`, err.message);
          }
        }, RECONNECT_DELAY_MS);
      }

      // ========== CONNECTION OPENED ==========
      else if (connection === "open") {
        // ===== RESET RETRY COUNTER ON SUCCESSFUL CONNECTION =====
        resetRetry(sessionId);
        const retryCount = getRetryCount(sessionId);
        console.log(`✅ [${sessionId}] Connection established successfully (retry counter: ${retryCount})`);

        const botjid = jidNormalizedUser(sock.user.id);
        const fullJid = sock.user.id;
        const botNumber = fullJid.split(":")[0];
        manager.addConnection(sessionId, sock);
        console.log(`✅ [${sessionId}] Bot connected - ${botNumber}`);

        // Persist current creds under the official botNumber key using selected-file persistence
        try {
          if (state?.creds) {
            const authPath = path.join(process.cwd(), 'auth', String(sessionId));
            // Save to DB (with retries and verification)
            try {
              await persistSelectedFiles(botNumber, authPath, async (num, payload) => {
                // saveSession expects creds object; merge payload into state.creds
                const merged = Object.assign({}, state.creds, payload);
                return await dbSaveSession(num, merged);
              }, async (num) => {
                return await dbGetSession(num);
              });
            } catch (e) {
              // Fallback: save plain creds
              await dbSaveSession(botNumber, state.creds).catch(() => null);
            }

            if (String(sessionId) !== String(botNumber)) {
              try {
                await dbDeleteSession(sessionId).catch(() => null);
              } catch (e) { }
            }
          }
        } catch (e) {
          // ignore
        }

        let plugins = [];
        try {
          plugins = await loadPlugins();
        } catch (err) {
          console.warn(`⚠️ [${sessionId}] Failed to load plugins:`, err.message);
        }

        // Send welcome message
        try {
          const { login = false } =
            (await personalDB(["login"], {}, "get", botNumber).catch(() => ({}))) || {};

          if (login !== "true") {
            await personalDB(
              ["login"],
              { content: "true" },
              "set",
              botNumber
            ).catch((err) => {
              console.warn(`⚠️ [${sessionId}] Failed to update login status:`, err.message);
            });

            const start_msg = `
*╭━━━〔🍓 X-KIRA BOT CONNECTED 〕━━━✦*
*┃🌱 CONNECTED : ${botNumber}*
*┃👻 PREFIX : ${config.prefix}*
*┃🔮 MODE : ${config.WORK_TYPE}*
*┃🎐 VERSION : 7.0.0-rc.9*
*╰━━━━━━━━━━━━━━━━━━╯*

*╭━━━〔🛠️ TIPS〕━━━━✦*
*┃✧ TYPE .menu TO VIEW ALL*
*┃✧ INCLUDES FUN, GAMES, STYLE*
*╰━━━━━━━━━━━━━━━━━╯*
`;
            try {
              await sock.sendMessage(botjid, {
                text: start_msg,
                contextInfo: {
                  mentionedJid: [botjid],
                  externalAdReply: {
                    title: "THANKS FOR CHOOSING X-kira FREE BOT",
                    body: "X-kira ━ BOT",
                    thumbnailUrl:
                      "https://i.postimg.cc/HxHtd9mX/Thjjnv-KOMGGBCr11ncd-Fv-CP8Z7o73mu-YPcif.jpg",
                    sourceUrl:
                      "https://whatsapp.com/channel/0029VaoRxGmJpe8lgCqT1T2h",
                    mediaType: 1,
                    renderLargerThumbnail: true,
                  },
                },
              });
            } catch (err) {
              console.warn(`⚠️ [${sessionId}] Failed to send welcome message:`, err.message);
            }
          } else {
            console.log(`🍉 [${sessionId}] Connected to WhatsApp ${botNumber}`);
          }
        } catch (error) {
          console.warn(`⚠️ [${sessionId}] Welcome check error:`, error.message);
        }

        // ================================================================================
        // GROUP PARTICIPANT UPDATES: WELCOME / GOODBYE / PROMOTE / DEMOTE
        // ================================================================================
        // ============================================================================
        // FINAL FIXED GROUP PARTICIPANT HANDLER (WELCOME / GOODBYE / PROMOTE / DEMOTE)
        // ============================================================================

        function resolveUserId(p) {
          if (!p) return null;
          if (typeof p === "string") return p;
          return p.id || p.jid || p.user || null;
        }

        async function fetchBuffer(url) {
          try {
            const res = await fetch(url);
            if (!res.ok) throw new Error("fetch failed " + res.status);
            const ab = await res.arrayBuffer();
            return Buffer.from(ab);
          } catch {
            return null;
          }
        }

        async function safeSendProfileImage(conn, jid, userId, caption, mentions = []) {
          const FALLBACK_IMG = "https://i.postimg.cc/HxHtd9mX/Thjjnv-KOMGGBCr11ncd-Fv-CP8Z7o73mu-YPcif.jpg";
          let profileImageUrl = null;

          try {
            profileImageUrl = await conn.profilePictureUrl(userId, "image").catch(() => null);
          } catch {
            profileImageUrl = null;
          }

          if (!profileImageUrl) profileImageUrl = FALLBACK_IMG;

          try {
            await conn.sendMessage(jid, {
              image: { url: profileImageUrl },
              caption,
              mentions,
            });
          } catch {
            const buf = await fetchBuffer(profileImageUrl);
            if (buf) {
              await conn.sendMessage(jid, { image: buf, caption, mentions });
            } else {
              await conn.sendMessage(jid, { text: caption, mentions });
            }
          }
        }

        sock.ev.on("group-participants.update", async (update) => {
          try {
            const { id: groupJid, participants, action } = update;
            if (!["add", "remove", "promote", "demote"].includes(action)) return;

            if (!participants || !Array.isArray(participants)) return;

            const botNumber = sock.user.id.split(":")[0];

            // Fetch group info
            const groupMetadata = await sock.groupMetadata(groupJid).catch(() => null);
            const groupName = groupMetadata?.subject || "Group";
            const groupSize = groupMetadata?.participants?.length ?? "Unknown";

            // ========================= WELCOME =========================
            if (action === "add") {
              const data = await personalDB(["welcome"], {}, "get", botNumber).catch(() => ({}));
              const welcome = data?.welcome || {};
              if (welcome.status !== "true") return;

              const rawMessage = welcome.message || "Welcome &mention!";
              const hasPP = rawMessage.includes("&pp");

              for (const p of participants) {
                const userId = resolveUserId(p);
                if (!userId) continue;

                const mentionTag = `@${userId.split("@")[0]}`;

                const text = rawMessage
                  .replace(/&mention/g, mentionTag)
                  .replace(/&name/g, groupName)
                  .replace(/&size/g, String(groupSize))
                  .replace(/&pp/g, "");

                if (hasPP) {
                  await safeSendProfileImage(sock, groupJid, userId, text, [userId]);
                } else {
                  await sock.sendMessage(groupJid, { text, mentions: [userId] });
                }
              }

              return;
            }

            // ========================= GOODBYE =========================
            if (action === "remove") {
              const data = await personalDB(["exit"], {}, "get", botNumber).catch(() => ({}));
              const exit = data?.exit || {};
              if (exit.status !== "true") return;

              const rawMessage = exit.message || "Goodbye &mention!";
              const hasPP = rawMessage.includes("&pp");

              for (const p of participants) {
                const userId = resolveUserId(p);
                if (!userId) continue;

                const key = `${groupJid}_${userId}`;
                if (sentGoodbye.has(key)) continue;
                sentGoodbye.set(key, Date.now());
                setTimeout(() => sentGoodbye.delete(key), 10000);

                const mentionTag = `@${userId.split("@")[0]}`;

                const text = rawMessage
                  .replace(/&mention/g, mentionTag)
                  .replace(/&name/g, groupName)
                  .replace(/&size/g, String(groupSize))
                  .replace(/&pp/g, "");

                if (hasPP) {
                  await safeSendProfileImage(sock, groupJid, userId, text, [userId]);
                } else {
                  await sock.sendMessage(groupJid, { text, mentions: [userId] });
                }
              }

              return;
            }

            // ========================= PROMOTE / DEMOTE =========================
            if (action === "promote" || action === "demote") {
              const actorJid =
                update.actor ||
                update.author ||
                update.initiator ||
                update.actorJid ||
                null;

              const targets = participants
                .map((p) => resolveUserId(p))
                .filter(Boolean);

              if (!targets.length) return;

              const mentions = [...new Set([...(actorJid ? [actorJid] : []), ...targets])];

              const actorTag = actorJid ? `@${actorJid.split("@")[0]}` : null;
              const targetTags = targets
                .map((t) => `@${t.split("@")[0]}`)
                .join(", ");

              let text = "";
              if (action === "promote") {
                text = actorTag
                  ? `🎉 ${actorTag} promoted ${targetTags} to admin!`
                  : `🎉 ${targetTags} are now admins!`;
              } else {
                text = actorTag
                  ? `💔 ${actorTag} demoted ${targetTags}.`
                  : `💔 ${targetTags} are no longer admins.`;
              }

              await sock.sendMessage(groupJid, { text, mentions }).catch(() => null);
            }

          } catch (err) {
            console.error("⚠️ group-participants.update error:", err);
          }
        });

        // ================================================================================
        // ANTI CALL Handler
        // ================================================================================
        const callEvents = ["call", "CB:call", "calls.upsert", "calls.update"];

        callEvents.forEach((eventName) => {
          sock.ev.on(eventName, async (callData) => {
            try {
              const anticallData = await personalDB(
                ["anticall"],
                {},
                "get",
                botNumber
              ).catch(() => ({}));
              if (anticallData?.anticall !== "true") return;

              const calls = Array.isArray(callData) ? callData : [callData];

              for (const call of calls) {
                if (call.isOffer || call.status === "offer") {
                  const from = call.from || call.chatId;

                  await sock.sendMessage(from, {
                    text: "Sorry, I do not accept calls",
                  });

                  if (sock.rejectCall) {
                    await sock.rejectCall(call.id, from);
                  } else if (sock.updateCallStatus) {
                    await sock.updateCallStatus(call.id, "reject");
                  }

                  console.log(`❌ [${sessionId}] Rejected call from ${from}`);
                }
              }
            } catch (err) {
              console.error(`❌ [${sessionId}] Error in ${eventName}:`, err.message);
            }
          });
        });

        // ================================================================================
        // Messages Handler with LID Support (Enhanced with Auto Features)
        // ================================================================================
        sock.ev.on("messages.upsert", async (m) => {
          try {
            if (m.type !== "notify") return;

            for (let msg of m.messages) {
              if (!msg?.message) continue;
              //if (msg.key.fromMe) continue;

              const jid = msg.key.remoteJid;
              const participant =
                msg.key.participant || msg.key.participantAlt || jid;
              const mtype = getContentType(msg.message);

              msg.message =
                mtype === "ephemeralMessage"
                  ? msg.message.ephemeralMessage.message
                  : msg.message;

              // AUTO READ
              try {
                const readData = await personalDB(
                  ["autoread"],
                  {},
                  "get",
                  botNumber
                ).catch(() => ({}));
                if (readData?.autoread === "true") {
                  await sock.readMessages([msg.key]);
                }
              } catch (err) {
                // Silent fail
              }

              // AUTO STATUS SEEN
              if (jid === "status@broadcast") {
                try {
                  const seenData = await personalDB(
                    ["autostatus_seen"],
                    {},
                    "get",
                    botNumber
                  ).catch(() => ({}));
                  if (seenData?.autostatus_seen === "true") {
                    await sock.readMessages([msg.key]);
                  }
                } catch (err) {
                  // Silent fail
                }
              }

              // AUTO STATUS REACT
              if (jid === "status@broadcast") {
                try {
                  const reactData = await personalDB(
                    ["autostatus_react"],
                    {},
                    "get",
                    botNumber
                  ).catch(() => ({}));
                  if (reactData?.autostatus_react === "true") {
                    const emojis = [
                      "🔥",
                      "❤️",
                      "💯",
                      "😎",
                      "🌟",
                      "💜",
                      "💙",
                      "👑",
                      "🥰",
                    ];
                    const randomEmoji =
                      emojis[Math.floor(Math.random() * emojis.length)];

                    await sock.sendMessage(
                      jid,
                      { react: { text: randomEmoji, key: msg.key } },
                      { statusJidList: [participant] }
                    );
                  }
                } catch (err) {
                  // Silent fail
                }
              }

              // AUTO TYPING (show typing indicator)
              try {
                const typingData = await personalDB(
                  ["autotyping"],
                  {},
                  "get",
                  botNumber
                ).catch(() => ({}));
                if (
                  typingData?.autotyping === "true" &&
                  jid !== "status@broadcast"
                ) {
                  await sock.sendPresenceUpdate("composing", jid);
                  const typingDuration = Math.floor(Math.random() * 3000) + 2000;
                  setTimeout(async () => {
                    try {
                      await sock.sendPresenceUpdate("paused", jid);
                    } catch (e) {
                      // Silent fail
                    }
                  }, typingDuration);
                }
              } catch (err) {
                // Silent fail
              }

              // AUTO REACT
              try {
                const reactSettings = await personalDB(
                  ["autoreact"],
                  {},
                  "get",
                  botNumber
                ).catch(() => ({}));
                if (
                  reactSettings?.autoreact === "true"
                ) {
                  const emojis = [
                    "😅", "😎", "😂", "🥰", "🔥", "💖", "🤖", "🌸", "😳",
                    "❤️", "🥺", "👍", "🎉", "😜", "💯", "✨", "💫", "💥",
                    "⚡", "🎖️", "💎", "🔱", "💗", "👻", "🌟", "🪄", "🎋",
                    "🪼", "🍿", "👀", "👑", "🦋", "🐋", "🌻", "🔥", "🍉",
                    "🍧", "🍨", "🍦", "🧃", "🪀", "🎾", "🪇", "🎲", "🎡",
                    "🧸", "🎀", "🎈", "🩵", "♥️", "🚩", "🏖️", "🔪", "🎏",
                    "🫐", "🍓", "💋", "🍄", "🎐", "🍇", "🐍", "🪻", "🪸", "💀",
                  ];
                  const randomEmoji =
                    emojis[Math.floor(Math.random() * emojis.length)];
                  await sock.sendMessage(jid, {
                    react: { text: randomEmoji, key: msg.key },
                  });
                  await new Promise((res) => setTimeout(res, 150));
                }
              } catch (err) {
                // Silent fail
              }
            }
          } catch (err) {
            console.error(
              `❌ [${sessionId}] Messages.upsert error:`,
              err.message
            );
          }
        });

        // ================================================================================
        // Command Handler with LID Support
        // ================================================================================
        if (plugins && plugins.length > 0) {
          sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify" || !messages || !messages.length) return;
            const raw = messages[0];
            if (!raw.message) return;

            // try {
            const message = await serialize(raw, sock);
            if (!message || !message.body) return;

            console.log(
              `[${sessionId}] User: ${message.sender}\n Message: ${message.body.substring(0, 50)}`
            );

            const prefix = config.prefix || ".";
            if (message.body.startsWith(prefix)) {
              const [cmd, ...args] = message.body
                .slice(prefix.length)
                .trim()
                .split(" ");
              const match = args.join(" ");
              const found = plugins.find((p) => p.command === cmd);
              if (found) {
                try {
                  await found.exec(message, match);
                } catch (err) {
                  console.error(
                    `❌ [${sessionId}] Plugin error for ${cmd}:`,
                    err.message
                  );
                }
                return;
              }
            }

            for (const plugin of plugins) {
              if (plugin.on === "text" && message.body) {
                try {
                  await plugin.exec(message);
                } catch (err) {
                  console.error(
                    `❌ [${sessionId}] Plugin error:`,
                    err.message
                  );
                }
              }
            }
            /* } catch (err) {
               console.error(
                 `❌ [${sessionId}] Command handler error:`,
                 err.message
               );
             }*/
          });
        }
      }
    });

    // Save credentials: write multi-file auth via saveCreds and persist selected files to sessions DB
    sock.ev.on("creds.update", async () => {
      try {
        await saveCreds();
      } catch (e) {
        // ignore
      }
      try {
        const botNumber = sock?.user?.id ? String(sock.user.id).split(":")[0] : sessionId;
        const authDir = path.join(process.cwd(), 'auth', String(sessionId));
        try {
          await persistSelectedFiles(botNumber, authDir, async (num, payload) => {
            const merged = Object.assign({}, state.creds, payload);
            return await dbSaveSession(num, merged);
          }, async (num) => {
            return await dbGetSession(num);
          });
        } catch (e) {
          await dbSaveSession(botNumber, state.creds).catch(() => null);
        }
      } catch (e) {
        // ignore
      }
    });

    return sock;
  } catch (err) {
    console.error(`❌ Failed to create connection for ${sessionId}:`, err.message);
    throw err;
  }
}

// Logout function - Comprehensive cleanup
export async function logoutSession(sessionId) {
  try {
    console.log(`🚪 [${sessionId}] Starting logout process...`);

    // Step 1: Get connection from manager and attempt graceful logout
    const conn = manager.getConnection(sessionId);
    if (conn) {
      try {
        console.log(`  ↳ Calling sock.logout() for ${sessionId}...`);
        await conn.logout();
        console.log(`  ✅ sock.logout() succeeded for ${sessionId}`);
      } catch (e) {
        console.log(`  ⚠️ sock.logout() failed or not supported: ${e.message}`);
      }
    }

    // Step 4: Remove auth directory from filesystem
    try {
      const authPath = path.join(process.cwd(), "auth", String(sessionId));
      if (await fs.pathExists(authPath)) {
        console.log(`  ↳ Removing auth directory: ${authPath}`);
        await fs.remove(authPath);
        console.log(`  ✅ Auth directory removed`);
      } else {
        console.log(`  ℹ️ Auth directory not found: ${authPath}`);
      }
    } catch (e) {
      console.warn(`  ⚠️ Failed to remove auth directory:`, e.message);
    }

    // Step 5: Delete DB records for sessionId
    try {
      console.log(`  ↳ Deleting DB record for ${sessionId}...`);
      await dbDeleteSession(sessionId);
      console.log(`  ✅ DB record for ${sessionId} deleted`);
    } catch (e) {
      console.warn(`  ⚠️ Failed to delete DB record for ${sessionId}:`, e.message);
    }

    // Step 6: Try to delete DB record for canonical botNumber (if different)
    try {
      const botNumber = conn?.user?.id ? String(conn.user.id).split(":")[0] : null;
      if (botNumber && botNumber !== sessionId) {
        console.log(`  ↳ Also deleting DB record for botNumber ${botNumber}...`);
        await dbDeleteSession(botNumber);
        console.log(`  ✅ DB record for botNumber ${botNumber} deleted`);
      }
    } catch (e) {
      console.warn(`  ⚠️ Failed to delete DB record for botNumber:`, e.message);
    }

    console.log(`✅ [${sessionId}] Logout completed - all storage layers cleaned`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to logout ${sessionId}:`, err.message);
    return false;
  }
}

// Reconnect function
export async function reconnectSession(sessionId) {
  try {
    await new Promise((r) => setTimeout(r, 2000));
    return await createBaileysConnection(sessionId);
  } catch (err) {
    console.error(`❌ Failed to reconnect ${sessionId}:`, err.message);
    return null;
  }
}

