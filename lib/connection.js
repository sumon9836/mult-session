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
import { saveSession as dbSaveSession, deleteSession as dbDeleteSession } from "./database/sessions.js";
import fs from 'fs-extra';
import path from 'path';
import serialize from "./serialize.js";
import config from "../config.js";
import os from 'os';
import tar from 'tar';

const sentGoodbye = new Set();

export async function createBaileysConnection(sessionId) {
  try {
    // Check if already connected
    if (manager.isConnected(sessionId)) {
      console.log(`✓ [${sessionId}] Already connected`);
      return manager.getConnection(sessionId);
    }
    // Check if already connecting
    if (manager.isConnecting(sessionId)) {
      console.log(
        `⏳ [${sessionId}] Already connecting, skipping duplicate call`
      );
      return null;
    }

    const { state, saveCreds } = await useMultiFileAuthState(
      `./auth/${sessionId}`
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
          await personalDB(
            ["lid_mapping"],
            { mapping: JSON.stringify(mapping) },
            "set",
            sessionId
          );
        } catch (err) {
          console.error(`❌ [${sessionId}] Error saving LID mapping:`, err.message);
        }
      }
    });

    // Connection update handler
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (connection === "connecting") {
        manager.addConnecting(sessionId);
      }
      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.output?.payload?.error;
        console.log(`❌ [${sessionId}] Closed: ${statusCode} - ${reason}`);
        try {
          console.error(`❗ [${sessionId}] lastDisconnect full payload:`, JSON.stringify(lastDisconnect, null, 2));
        } catch (e) {
          console.error(`❗ [${sessionId}] lastDisconnect (raw):`, lastDisconnect);
        }
        const shouldReconnect =
          lastDisconnect?.error instanceof Boom &&
          lastDisconnect.error.output?.statusCode !==
          DisconnectReason.loggedOut;
        manager.removeConnection(sessionId);
        manager.removeConnecting(sessionId);
        console.log(
          `⚠️ Connection closed for ${sessionId}. Reconnecting: ${shouldReconnect}`
        );
        if (shouldReconnect) {
          // Exponential backoff for reconnection
          setTimeout(() => createBaileysConnection(sessionId), 3000);
        } else {
          console.log(`❌ [${sessionId}] Session logged out (no reconnect)`);
          await logoutSession(sessionId)
          // Do NOT call logoutSession here - it will be called explicitly via API if needed
          // This prevents cascading cleanup on normal logouts
        }
      } else if (connection === "open") {
        const botjid = jidNormalizedUser(sock.user.id);
        const fullJid = sock.user.id;
        const botNumber = fullJid.split(":")[0];
        manager.addConnection(sessionId, sock);
        console.log(`✅ [${sessionId}] Bot connected - ${botNumber}`);

        // Persist current creds under the official botNumber key
        try {
          if (state?.creds) {
            await dbSaveSession(botNumber, state.creds).catch(() => null);
            // If sessionId differs from botNumber (e.g., temp id), remove old record
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
        sock.ev.on("group-participants.update", async (update) => {
          try {
            const { id: groupJid, participants, action } = update;
            // handle welcome/exit as before; also handle promote/demote notifications
            if (!["add", "remove", "promote", "demote"].includes(action)) return;

            // Fetch group info
            const groupMetadata = await sock
              .groupMetadata(groupJid)
              .catch(() => null);
            const groupName = groupMetadata?.subject || "Group";
            const groupSize = groupMetadata?.participants?.length || "Unknown";

            // --- Welcome / Goodbye (respect personal/global settings, fallback to group custom message) ---
            if (action === "add" || action === "remove") {
              const personalKey = action === "add" ? "welcome" : "exit";
              // Prefer bot-level (personal) configuration from the welcome/goodbye plugin
              const personalCfg =
                (await personalDB([personalKey], {}, "get", botNumber).catch(() => ({}))) || {};
              const pCfg = personalCfg?.[personalKey] || {};
              const personalEnabled = pCfg?.status === "true";
              const personalMsg = pCfg?.message;

              // Allow per-group override for message template (but keep personal enabled flag primary)
              const msgKey = action === "add" ? "welcome_msg" : "exit_msg";
              const groupMsgCfg = await groupDB([msgKey], { jid: groupJid }, "get").catch(() => ({}));
              const groupRawMessage = groupMsgCfg?.[msgKey];

              // Determine whether to proceed: personalEnabled or group has a custom message
              const shouldRun = personalEnabled || (typeof groupRawMessage === "string" && groupRawMessage.length > 0);
              if (!shouldRun) return; // not enabled

              const rawMessage = personalEnabled
                ? personalMsg || (action === "add" ? "👋 Welcome &mention to &name!" : "👋 Goodbye &mention from &name!")
                : groupRawMessage;

              for (const p of participants) {
                // Extract JID safely (Baileys 7.0.0 supports LID formats)
                let userJid =
                  typeof p === "string"
                    ? p
                    : p?.id || p?.jid || (typeof p === "object" && Object.keys(p)[0]);

                if (!userJid) continue;

                // Avoid duplicate goodbye triggers
                const key = `${groupJid}_${userJid}`;
                if (action === "remove" && sentGoodbye.has(key)) continue;
                if (action === "remove") {
                  sentGoodbye.add(key);
                  setTimeout(() => sentGoodbye.delete(key), 10000);
                }

                const userId = userJid.split("@")[0].split(":")[0];
                const mentionTag = `@${userId}`;

                // Replace variables in message
                const text = rawMessage
                  .replace(/&mention/g, mentionTag)
                  .replace(/&size/g, groupSize)
                  .replace(/&name/g, groupName);

                // Send message
                await sock.sendMessage(groupJid, {
                  text,
                  mentions: [userJid],
                });
              }

              return;
            }

            // --- Promote / Demote notifications (send beautiful mention-rich text) ---
            if (action === "promote" || action === "demote") {
              // Attempt to find the actor (who performed the promote/demote)
              const actorJid = update.actor || update.author || update?.initiator || update?.actorJid || null;

              // Extract targets (the participants array contains the affected members)
              const targetJids = (participants || []).map((p) =>
                typeof p === "string"
                  ? p
                  : p?.id || p?.jid || (typeof p === "object" && Object.keys(p)[0])
              ).filter(Boolean);

              if (!targetJids.length) return;

              // Build mention lists
              const mentions = [...new Set([...(actorJid ? [actorJid] : []), ...targetJids])];
              const actorTag = actorJid ? `@${String(actorJid).split("@")[0].split(":")[0]}` : null;
              const targetTags = targetJids.map(t => `@${String(t).split("@")[0].split(":")[0]}`).join(
                targetJids.length > 1 ? ", " : ""
              );

              let text = "";
              if (action === "promote") {
                if (actorTag) {
                  text = `🎉 ${actorTag} has promoted ${targetTags} to admin.`;
                } else {
                  text = `🎉 Congratulations ${targetTags}! You've been promoted to admin.`;
                }
              } else {
                if (actorTag) {
                  text = `💔 ${actorTag} has demoted ${targetTags} from admin.`;
                } else {
                  text = `💔 ${targetTags} were removed from admin.`;
                }
              }

              await sock.sendMessage(groupJid, {
                text,
                mentions,
              }).catch(() => null);

              return;
            }
          } catch (err) {
            console.error(`❌ [${sessionId}] Group participant update error:`, err.message);
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

            try {
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
            } catch (err) {
              console.error(
                `❌ [${sessionId}] Command handler error:`,
                err.message
              );
            }
          });
        }
      }
    });

    // Save credentials: write multi-file auth via saveCreds and persist to sessions DB
    sock.ev.on("creds.update", async () => {
      try {
        await saveCreds();
      } catch (e) {
        // ignore
      }
      try {
        // Prefer persisting under the canonical WhatsApp number if available
        const botNumber = sock?.user?.id ? String(sock.user.id).split(":")[0] : sessionId;
        // Attempt to create a tar.gz of the entire auth folder and attach as base64
        try {
          const authDir = path.join(process.cwd(), 'auth', String(sessionId));
          const tmpTar = path.join(os.tmpdir(), `auth-${sessionId}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tar.gz`);
          const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024; // 5 MB limit for safety
          if (await fs.pathExists(authDir)) {
            try {
              // Create tar.gz of the session folder using Node tar (no shell)
              await tar.c({ gzip: true, file: tmpTar, cwd: path.join(process.cwd(), 'auth') }, [sessionId]);
              const stats = await fs.stat(tmpTar);
              if (stats.size > MAX_ARCHIVE_BYTES) {
                console.warn(`⚠️ [${sessionId}] Archive too large (${stats.size} bytes), skipping DB archive`);
                // Save just creds (no archive)
                await dbSaveSession(botNumber, state.creds).catch(() => null);
                await fs.remove(tmpTar).catch(() => null);
              } else {
                const buf = await fs.readFile(tmpTar);
                // Attach base64 encoded archive to creds under a reserved key
                const credsWithArchive = Object.assign({}, state.creds, {
                  _auth_archive: buf.toString('base64'),
                });
                await dbSaveSession(botNumber, credsWithArchive).catch(() => null);
                await fs.remove(tmpTar).catch(() => null);
              }
            } catch (e) {
              // Fallback: save creds without archive
              console.warn(`⚠️ [${sessionId}] Failed to create archive:`, e?.message || e);
              await dbSaveSession(botNumber, state.creds).catch(() => null);
            }
          } else {
            await dbSaveSession(botNumber, state.creds).catch(() => null);
          }
        } catch (e) {
          // If anything goes wrong, still try saving creds
          await dbSaveSession(botNumber, state.creds).catch(() => null);
        }
      } catch (e) {
        // ignore
      }
    });

    return sock;
  } catch (err) {
    console.error(`❌ Failed to create connection for ${sessionId}:`, err.message);
    manager.removeConnecting(sessionId);
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

    // Step 2: Remove from manager
    try {
      console.log(`  ↳ Removing from manager...`);
      manager.removeConnection(sessionId);
      console.log(`  ✅ Removed from manager`);
    } catch (e) {
      console.warn(`  ⚠️ Failed to remove from manager:`, e.message);
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

