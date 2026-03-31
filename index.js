const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const app = express();
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// =============================
// ENV
// =============================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ADMIN_PHONE_RAW = process.env.ADMIN_PHONE;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET;

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN =
  process.env.UPSTASH_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// ✅ CHATWOOT
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CHATWOOT_INBOX_ID = process.env.CHATWOOT_INBOX_ID;
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN;

// ✅ BOTHUB / CRM
const BOTHUB_WEBHOOK_URL = (process.env.BOTHUB_WEBHOOK_URL || "").trim();
const BOTHUB_WEBHOOK_SECRET = (process.env.BOTHUB_WEBHOOK_SECRET || "").trim();
const BOTHUB_TIMEOUT_MS = Number(process.env.BOTHUB_TIMEOUT_MS || 6000);
const BOTHUB_API_BASE_URL =
  (process.env.BOTHUB_API_BASE_URL || process.env.CRM_API_BASE_URL || "").trim();
const BOTHUB_JWT_TOKEN =
  (process.env.BOTHUB_JWT_TOKEN || process.env.CRM_JWT_TOKEN || "").trim();
const BOTHUB_BOT_ID = (process.env.BOTHUB_BOT_ID || "").trim();
const BOT_PUBLIC_BASE_URL = (process.env.BOT_PUBLIC_BASE_URL || "").replace(/\/$/, "");
const HUB_MEDIA_SECRET =
  (process.env.HUB_MEDIA_SECRET || BOTHUB_WEBHOOK_SECRET || VERIFY_TOKEN || "").trim();
const HUB_MEDIA_TTL_SEC = parseInt(process.env.HUB_MEDIA_TTL_SEC || "900", 10);
const META_GRAPH_VERSION =
  process.env.WHATSAPP_GRAPH_VERSION || process.env.META_GRAPH_VERSION || "v20.0";
const HUMAN_MODE_NOTIFY_USER =
  String(process.env.HUMAN_MODE_NOTIFY_USER || "0") === "1";

// ✅ MODO MANUAL: Solo Chatwoot (sin respuestas automáticas)
const MANUAL_MODE = String(process.env.MANUAL_MODE || "")
  .trim()
  .toLowerCase() === "true";

// ✅ LINK REAL DEL CATÁLOGO (CTA URL)
const WHATSAPP_CATALOG_URL = "https://wa.me/c/18495828578";

// ✅ COOLDOWN BIENVENIDA: 24 horas
const WELCOME_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// =============================
// ✅ FOLLOW-UP / RECORDATORIOS (EXISTENTE)
// - Cada 4 horas por las primeras 24 horas (máx 6)
// - Solo si: fue el primer mensaje y NO volvió a escribir (2do mensaje) y NO envió carrito (order)
// =============================
const REMINDER_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h
const REMINDER_MAX_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const REMINDER_MAX_COUNT = 6;

// Timers en memoria (por usuario). Nota: si el server se reinicia, los timers no sobreviven,
// pero el estado queda en Redis; al re-escribir el usuario, se cancela igual.
const reminderTimers = new Map();

function clearUserReminderTimer(userPhone) {
  const t = reminderTimers.get(String(userPhone));
  if (t) clearTimeout(t);
  reminderTimers.delete(String(userPhone));
}

async function cancelReminders(userPhone, session, reason = "cancel") {
  try {
    session = session || (await getSession(userPhone)) || {};
    if (!session.order) session.order = {};
    if (!session.state) session.state = "INIT";

    if (!session.followup) session.followup = {};
    session.followup.active = false;
    session.followup.cancelled = true;
    session.followup.cancel_reason = reason;
    session.followup.cancelled_ts = Date.now();

    clearUserReminderTimer(userPhone);
    await setSession(userPhone, session);
  } catch (_) {}
}

async function startRemindersIfEligible(userPhone, session) {
  if (MANUAL_MODE) return; // si está manual, no recordatorios automáticos
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return; // sin Redis no hacemos followups persistentes

  session = session || (await getSession(userPhone)) || {};
  if (!session.order) session.order = {};
  if (!session.state) session.state = "INIT";

  // ✅ si estamos usando la cola /tick, no usamos timers en memoria (NUEVO)
  if (session.followup && session.followup.use_tick === true) return;

  // contador de mensajes entrantes del usuario
  if (!session.inbound_text_count) session.inbound_text_count = 0;

  // si ya escribió 2+ veces, no aplica
  if (session.inbound_text_count >= 2) return;

  // si ya envió carrito, no aplica
  if (session.followup?.active === false) return;

  // inicializa followup
  if (!session.followup) session.followup = {};
  session.followup.active = true;
  session.followup.cancelled = false;
  session.followup.started_ts = session.followup.started_ts || Date.now();
  session.followup.last_sent_ts = session.followup.last_sent_ts || 0;
  session.followup.count = session.followup.count || 0;

  await setSession(userPhone, session);

  // programa el próximo
  scheduleNextReminder(userPhone);
}

async function scheduleNextReminder(userPhone) {
  if (MANUAL_MODE) return;
  clearUserReminderTimer(userPhone);

  // Calcula delay basado en last_sent_ts (para que sea cada 4h exactas)
  const session = (await getSession(userPhone)) || {};
  const fu = session.followup || {};

  // ✅ si estamos usando la cola /tick, no usamos timers en memoria (NUEVO)
  if (fu.use_tick === true) return;

  if (!fu.active) return;

  const started = fu.started_ts || Date.now();
  const now = Date.now();

  // Ventana 24h
  if (now - started > REMINDER_MAX_WINDOW_MS) {
    await cancelReminders(userPhone, session, "window_expired");
    return;
  }

  // Máx 6 mensajes
  if ((fu.count || 0) >= REMINDER_MAX_COUNT) {
    await cancelReminders(userPhone, session, "max_count_reached");
    return;
  }

  // Si ya escribió 2+ mensajes, cancelar
  if ((session.inbound_text_count || 0) >= 2) {
    await cancelReminders(userPhone, session, "user_sent_second_message");
    return;
  }

  // Si ya llegó carrito (order), cancelar
  if (
    session.order &&
    session.order.items &&
    Array.isArray(session.order.items) &&
    session.order.items.length > 0
  ) {
    await cancelReminders(userPhone, session, "order_received");
    return;
  }

  const last = fu.last_sent_ts || 0;
  const nextDue = last
    ? last + REMINDER_INTERVAL_MS
    : started + REMINDER_INTERVAL_MS;
  const delay = Math.max(1000, nextDue - now);

  const timer = setTimeout(async () => {
    try {
      // re-check al disparar
      let s = (await getSession(userPhone)) || {};
      if (!s.order) s.order = {};
      if (!s.state) s.state = "INIT";
      if (!s.followup) s.followup = {};

      // ✅ si estamos usando la cola /tick, no usamos timers en memoria (NUEVO)
      if (s.followup.use_tick === true) return;

      // condiciones de cancelación
      if (!s.followup.active) return;
      if ((s.inbound_text_count || 0) >= 2) {
        await cancelReminders(userPhone, s, "user_sent_second_message");
        return;
      }
      if (
        s.order &&
        s.order.items &&
        Array.isArray(s.order.items) &&
        s.order.items.length > 0
      ) {
        await cancelReminders(userPhone, s, "order_received");
        return;
      }

      const startedTs = s.followup.started_ts || Date.now();
      const nowTs = Date.now();
      if (nowTs - startedTs > REMINDER_MAX_WINDOW_MS) {
        await cancelReminders(userPhone, s, "window_expired");
        return;
      }

      if ((s.followup.count || 0) >= REMINDER_MAX_COUNT) {
        await cancelReminders(userPhone, s, "max_count_reached");
        return;
      }

      // ✅ enviar recordatorio (CTA al catálogo)
      const reminderText =
        "👋✨ Solo paso por aquí rapidito…\n" +
        "¿Quieres ver el catálogo y elegir tus productos? 💗";

      await sendWhatsAppCtaUrl(
        userPhone,
        reminderText,
        "🛍️ Ver catálogo",
        WHATSAPP_CATALOG_URL
      );

      // log a Chatwoot (privado)
      await sendBotToChatwoot({
        session: s,
        from: userPhone,
        name: userPhone,
        message: `BOT: Recordatorio catálogo enviado (${
          (s.followup.count || 0) + 1
        }/${REMINDER_MAX_COUNT}).`,
      });

      // actualizar estado
      s.followup.last_sent_ts = nowTs;
      s.followup.count = (s.followup.count || 0) + 1;

      await setSession(userPhone, s);

      // programa el siguiente
      await scheduleNextReminder(userPhone);
    } catch (e) {
      // si falla, intentamos programar otra vez más tarde sin romper
      console.error("❌ Error recordatorio:", e?.response?.data || e.message || e);
      try {
        await scheduleNextReminder(userPhone);
      } catch (_) {}
    }
  }, delay);

  reminderTimers.set(String(userPhone), timer);
}

// =============================
// ✅ FOLLOW-UP ROBUSTO (NUEVO) - Upstash Queue + /tick
// - Guarda en Upstash (ZSET) cuándo toca el próximo recordatorio
// - UptimeRobot pega a /tick para procesar vencidos
// =============================
const TICK_TOKEN = process.env.TICK_TOKEN || "";

const FOLLOWUP_ZSET_KEY = "followup:due";
const FOLLOWUP_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h
const FOLLOWUP_MAX_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const FOLLOWUP_MAX_COUNT = 6;
const FOLLOWUP_BATCH_LIMIT = 25;

async function redisCmd(cmdArr) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;

  try {
    const res = await axios.post(UPSTASH_URL, cmdArr, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    return res.data?.result ?? null;
  } catch (e) {
    console.error("❌ Redis cmd error:", e?.response?.data || e.message);
    return null;
  }
}

async function scheduleFollowupTick(userPhone, session) {
  if (MANUAL_MODE) return;
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;

  const now = Date.now();
  session = session || (await getSession(userPhone)) || {};
  if (!session.order) session.order = {};
  if (!session.state) session.state = "INIT";
  if (typeof session.inbound_text_count !== "number")
    session.inbound_text_count = 0;

  // Solo si es 1er mensaje (texto) y todavía no hay carrito
  if (session.inbound_text_count !== 1) return;
  if (session.order?.items?.length) return;

  if (!session.followup) session.followup = {};
  session.followup.use_tick = true; // ✅ marca que usamos cola /tick
  session.followup.active = true;
  session.followup.cancelled = false;
  session.followup.started_ts = session.followup.started_ts || now;
  session.followup.count = session.followup.count || 0;

  // Para que el primer recordatorio salga 4h después del primer mensaje
  session.followup.next_due_ts =
    session.followup.next_due_ts || now + FOLLOWUP_INTERVAL_MS;

  // Evita duplicar timers en memoria si ya existían
  clearUserReminderTimer(userPhone);

  await setSession(userPhone, session);

  // ZADD score=next_due_ts member=userPhone
  await redisCmd([
    "ZADD",
    FOLLOWUP_ZSET_KEY,
    String(session.followup.next_due_ts),
    String(userPhone),
  ]);
}

async function cancelFollowupTick(userPhone, session, reason = "cancelled") {
  session = session || (await getSession(userPhone)) || {};
  if (!session.order) session.order = {};
  if (!session.state) session.state = "INIT";
  if (!session.followup) session.followup = {};

  session.followup.use_tick = true; // mantiene la marca
  session.followup.active = false;
  session.followup.cancelled = true;
  session.followup.cancel_reason = reason;
  session.followup.cancelled_ts = Date.now();
  session.followup.next_due_ts = 0;

  clearUserReminderTimer(userPhone);
  await setSession(userPhone, session);

  await redisCmd(["ZREM", FOLLOWUP_ZSET_KEY, String(userPhone)]);
}

async function processDueFollowupsTick(limit = FOLLOWUP_BATCH_LIMIT) {
  if (MANUAL_MODE) return;
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;

  const now = Date.now();

  const due = await redisCmd([
    "ZRANGEBYSCORE",
    FOLLOWUP_ZSET_KEY,
    "-inf",
    String(now),
    "LIMIT",
    "0",
    String(limit),
  ]);

  if (!due || !Array.isArray(due) || due.length === 0) return;

  for (const userPhone of due) {
    try {
      let session = (await getSession(userPhone)) || {};
      if (!session.order) session.order = {};
      if (!session.state) session.state = "INIT";
      if (!session.followup) session.followup = {};
      if (typeof session.inbound_text_count !== "number")
        session.inbound_text_count = 0;

      // Si humano está atendiendo, reprograma 10 min
      if (session.human_until && Date.now() < session.human_until) {
        session.followup.use_tick = true;
        session.followup.next_due_ts = Date.now() + 10 * 60 * 1000;
        await setSession(userPhone, session);
        await redisCmd([
          "ZADD",
          FOLLOWUP_ZSET_KEY,
          String(session.followup.next_due_ts),
          String(userPhone),
        ]);
        continue;
      }

      // Cancelaciones
      if (session.followup.active !== true) {
        await redisCmd(["ZREM", FOLLOWUP_ZSET_KEY, String(userPhone)]);
        continue;
      }

      if ((session.inbound_text_count || 0) >= 2) {
        await cancelFollowupTick(userPhone, session, "user_sent_second_message");
        continue;
      }

      if (session.order?.items?.length) {
        await cancelFollowupTick(userPhone, session, "order_received");
        continue;
      }

      const started = session.followup.started_ts || now;
      if (now - started > FOLLOWUP_MAX_WINDOW_MS) {
        await cancelFollowupTick(userPhone, session, "window_expired");
        continue;
      }

      if ((session.followup.count || 0) >= FOLLOWUP_MAX_COUNT) {
        await cancelFollowupTick(userPhone, session, "max_count_reached");
        continue;
      }

      // ✅ enviar recordatorio
      await sendWhatsAppCtaUrl(
        userPhone,
        "👋✨ Solo paso por aquí rapidito…\n¿Quieres ver el catálogo y elegir tus productos? 💗",
        "🛍️ Ver catálogo",
        WHATSAPP_CATALOG_URL
      );

      await sendBotToChatwoot({
        session,
        from: userPhone,
        name: userPhone,
        message: `BOT: Follow-up /tick enviado (${
          (session.followup.count || 0) + 1
        }/${FOLLOWUP_MAX_COUNT}).`,
      });

      session.followup.use_tick = true;
      session.followup.count = (session.followup.count || 0) + 1;

      if (session.followup.count >= FOLLOWUP_MAX_COUNT) {
        await cancelFollowupTick(userPhone, session, "max_count_reached");
        continue;
      }

      session.followup.next_due_ts = Date.now() + FOLLOWUP_INTERVAL_MS;
      await setSession(userPhone, session);

      await redisCmd([
        "ZADD",
        FOLLOWUP_ZSET_KEY,
        String(session.followup.next_due_ts),
        String(userPhone),
      ]);
    } catch (e) {
      console.error(
        "❌ processDueFollowupsTick item error:",
        e?.response?.data || e.message || e
      );
      // reprograma 10 min para evitar loop
      try {
        const fallback = Date.now() + 10 * 60 * 1000;
        await redisCmd([
          "ZADD",
          FOLLOWUP_ZSET_KEY,
          String(fallback),
          String(userPhone),
        ]);
      } catch (_) {}
    }
  }
}

// =============================
// Helpers
// =============================
function onlyDigits(phone) {
  return String(phone || "").replace(/\D/g, "");
}

// ✅ FIX E164 (Chatwoot exige +1XXXXXXXXXX para RD)
function toE164(phone) {
  const d = onlyDigits(phone);
  if (!d) return null;

  // RD usa +1 (NANP)
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;

  return `+${d}`;
}

// ✅ WhatsApp Cloud API requiere número con código país SIN "+"
function toWARecipient(phone) {
  const e164 = toE164(phone);
  if (!e164) return null;
  return onlyDigits(e164);
}

function normalizeText(text) {
  let normalized = (text || "").toLowerCase();
  normalized = normalized.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  normalized = normalized.replace(/[^\w\s]/g, " ");
  normalized = normalized.trim().replace(/\s+/g, " ");
  return normalized;
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return String(value);
  }
}

function debugLog(label, data) {
  const ts = new Date().toISOString();
  if (typeof data === "undefined") {
    console.log(`🔎 [${ts}] ${label}`);
    return;
  }
  console.log(`🔎 [${ts}] ${label}:`, data);
}

function debugJson(label, data) {
  const ts = new Date().toISOString();
  console.log(`🔎 [${ts}] ${label}:
${safeJson(data)}`);
}

function ensureSessionDefaults(session) {
  const next = session && typeof session === "object" ? { ...session } : {};

  if (!next.order || typeof next.order !== "object") next.order = {};
  if (!next.state) next.state = "INIT";
  if (!next.conversationMode || !["bot", "human"].includes(next.conversationMode)) {
    next.conversationMode = "bot";
  }

  return next;
}

function stableStringify(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",")}}`;
}

function removeUndefinedDeep(value) {
  if (Array.isArray(value)) return value.map(removeUndefinedDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => typeof v !== "undefined")
        .map(([k, v]) => [k, removeUndefinedDeep(v)])
    );
  }
  return value;
}

function bothubEnabled() {
  return Boolean(BOTHUB_WEBHOOK_URL && BOTHUB_WEBHOOK_SECRET);
}

function bothubHmacStable(payload, secret) {
  const raw = stableStringify(payload);
  return crypto.createHmac("sha256", secret).update(raw).digest("hex");
}

function bothubHmacJson(payload, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(JSON.stringify(payload))
    .digest("hex");
}

function getHubSignature(req) {
  const h =
    req.get("X-HUB-SIGNATURE") ||
    req.get("X-Hub-Signature") ||
    req.get("x-hub-signature") ||
    req.get("X-HUB-SIGNATURE-256") ||
    req.get("X-Hub-Signature-256") ||
    req.get("x-hub-signature-256") ||
    "";

  const sig = String(h || "").trim();
  if (!sig) return "";
  return sig.startsWith("sha256=") ? sig.slice("sha256=".length) : sig;
}

function timingSafeEqualHex(aHex, bHex) {
  const a = Buffer.from(String(aHex || ""), "utf8");
  const b = Buffer.from(String(bHex || ""), "utf8");
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyHubSignature(reqBody, signatureHex, secret) {
  if (!signatureHex || !secret) return false;

  const expectedStable = bothubHmacStable(reqBody, secret);
  if (timingSafeEqualHex(signatureHex, expectedStable)) return true;

  const expectedJson = bothubHmacJson(reqBody, secret);
  if (timingSafeEqualHex(signatureHex, expectedJson)) return true;

  return false;
}

function verifyMetaSignature(req) {
  if (!META_APP_SECRET) return true;
  const signature = req.get("X-Hub-Signature-256");
  if (!signature) return false;

  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", META_APP_SECRET)
      .update(req.rawBody || Buffer.from(""))
      .digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (_) {
    return false;
  }
}

function getStaticPublicBaseUrl() {
  return (
    BOT_PUBLIC_BASE_URL ||
    String(process.env.RENDER_EXTERNAL_URL || "").trim().replace(/\/$/, "") ||
    String(process.env.RENDER_PUBLIC_URL || "").trim().replace(/\/$/, "") ||
    ""
  );
}

function signHubMediaToken(mediaId, ts) {
  if (!HUB_MEDIA_SECRET) return "";
  return crypto
    .createHmac("sha256", HUB_MEDIA_SECRET)
    .update(`${String(mediaId)}:${String(ts)}`)
    .digest("hex");
}

function verifyHubMediaToken(mediaId, ts, sig) {
  if (!HUB_MEDIA_SECRET) return false;
  if (!mediaId || !ts || !sig) return false;

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;

  const ageMs = Math.abs(Date.now() - tsNum);
  if (ageMs > HUB_MEDIA_TTL_SEC * 1000) return false;

  const expected = signHubMediaToken(mediaId, ts);
  return timingSafeEqualHex(sig, expected);
}

function buildHubMediaUrlStatic(mediaId) {
  const safeBase = getStaticPublicBaseUrl();
  if (!mediaId || !safeBase || !HUB_MEDIA_SECRET) return "";

  const ts = String(Date.now());
  const sig = signHubMediaToken(mediaId, ts);

  return `${safeBase}/hub_media/${encodeURIComponent(mediaId)}?ts=${encodeURIComponent(
    ts
  )}&sig=${encodeURIComponent(sig)}`;
}

async function bothubReportMessage(payload) {
  if (!bothubEnabled()) {
    debugJson("ℹ️ Bothub deshabilitado", {
      hasWebhookUrl: Boolean(BOTHUB_WEBHOOK_URL),
      hasWebhookSecret: Boolean(BOTHUB_WEBHOOK_SECRET),
    });
    return null;
  }

  try {
    const cleanPayload = removeUndefinedDeep(payload);
    const raw = stableStringify(cleanPayload);
    const sig = crypto
      .createHmac("sha256", BOTHUB_WEBHOOK_SECRET)
      .update(raw)
      .digest("hex");

    debugJson("📤 Bothub report payload", cleanPayload);

    const res = await axios.post(BOTHUB_WEBHOOK_URL, raw, {
      headers: {
        "Content-Type": "application/json",
        "X-HUB-SIGNATURE": sig,
      },
      timeout: BOTHUB_TIMEOUT_MS,
      transformRequest: [(data) => data],
    });

    debugJson("✅ Bothub report ack", res?.data || {});
    return res?.data || null;
  } catch (e) {
    console.error("❌ Bothub report failed:", e?.response?.data || e?.message || e);
    return null;
  }
}

function extractBothubConversationId(ack) {
  return (
    ack?.conversationId ||
    ack?.conversation_id ||
    ack?.conversation?.id ||
    ack?.payload?.conversationId ||
    ack?.payload?.conversation?.id ||
    ""
  );
}

function updateSessionHubConversationId(session, ack) {
  const conversationId = String(extractBothubConversationId(ack) || "").trim();
  if (conversationId) session.hubConversationId = conversationId;
}

function extFromMimeType(mime) {
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "application/pdf": ".pdf",
  };
  return map[String(mime || "").toLowerCase()] || "";
}

function sanitizeFileName(name, fallback = "file") {
  const raw = String(name || fallback).trim() || fallback;
  return raw.replace(/[\\/:*?"<>|]+/g, "_");
}

function guessFilenameFromUrl(url, fallbackBase = "file", mimeType = "") {
  try {
    const pathname = new URL(String(url || "")).pathname || "";
    const candidate = decodeURIComponent(path.basename(pathname));
    if (candidate) return sanitizeFileName(candidate, `${fallbackBase}${extFromMimeType(mimeType)}`);
  } catch (_) {}
  return sanitizeFileName(`${fallbackBase}${extFromMimeType(mimeType) || ""}`, fallbackBase);
}

function normalizeAgentMediaType(type, mimeType = "", filename = "", url = "") {
  const rawType = String(type || "").trim().toLowerCase();
  if (["text", "location", "image", "video", "audio", "document"].includes(rawType)) {
    return rawType;
  }

  const haystack = `${String(mimeType || "").toLowerCase()} ${String(filename || "").toLowerCase()} ${String(url || "").toLowerCase()}`;
  if (haystack.includes("image/")) return "image";
  if (haystack.includes("video/")) return "video";
  if (haystack.includes("audio/")) return "audio";
  if (haystack.includes("application/pdf")) return "document";
  if (/\.(jpg|jpeg|png|webp|gif)(\?|#|$)/i.test(haystack)) return "image";
  if (/\.(mp4|mov|3gp)(\?|#|$)/i.test(haystack)) return "video";
  if (/\.(ogg|mp3|m4a|aac|amr|wav)(\?|#|$)/i.test(haystack)) return "audio";
  if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt)(\?|#|$)/i.test(haystack)) return "document";
  return "";
}

function getNestedValue(obj, pathExpr) {
  const parts = String(pathExpr || "").split(".").filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function firstNonEmptyString(obj, paths) {
  for (const pathExpr of paths) {
    const value = getNestedValue(obj, pathExpr);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstDefinedValue(obj, paths) {
  for (const pathExpr of paths) {
    const value = getNestedValue(obj, pathExpr);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function extractAgentMessagePayload(body) {
  const raw = body || {};
  const waTo = firstNonEmptyString(raw, [
    "waTo",
    "wa_to",
    "to",
    "phone",
    "recipient",
    "contact.phone",
    "conversation.phone",
    "conversation.contact.phone",
    "message.waTo",
    "message.to",
  ]);

  const filename = firstNonEmptyString(raw, [
    "filename",
    "fileName",
    "name",
    "message.filename",
    "message.fileName",
    "message.media.filename",
    "media.filename",
    "attachment.filename",
    "attachments.0.filename",
  ]);

  const mimeType = firstNonEmptyString(raw, [
    "mimeType",
    "mime_type",
    "contentType",
    "content_type",
    "message.mimeType",
    "message.media.mimeType",
    "media.mimeType",
    "attachment.mimeType",
    "attachments.0.mimeType",
  ]);

  const genericMediaUrl = firstNonEmptyString(raw, [
    "mediaUrl",
    "media_url",
    "url",
    "link",
    "message.mediaUrl",
    "message.url",
    "message.media.url",
    "media.url",
    "attachment.url",
    "attachments.0.url",
  ]);

  const explicitType = normalizeAgentMediaType(
    firstNonEmptyString(raw, [
      "type",
      "kind",
      "messageType",
      "mediaType",
      "message.type",
      "message.kind",
      "message.media.type",
      "media.type",
      "attachment.type",
      "attachments.0.type",
    ]),
    mimeType,
    filename,
    genericMediaUrl
  );

  const imageUrl =
    firstNonEmptyString(raw, ["imageUrl", "image_url", "message.imageUrl"]) ||
    (explicitType === "image" ? genericMediaUrl : "");
  const videoUrl =
    firstNonEmptyString(raw, ["videoUrl", "video_url", "message.videoUrl"]) ||
    (explicitType === "video" ? genericMediaUrl : "");
  const audioUrl =
    firstNonEmptyString(raw, ["audioUrl", "audio_url", "voiceUrl", "message.audioUrl"]) ||
    (explicitType === "audio" ? genericMediaUrl : "");
  const documentUrl =
    firstNonEmptyString(raw, ["documentUrl", "document_url", "fileUrl", "message.documentUrl"]) ||
    (explicitType === "document" ? genericMediaUrl : "");
  const mediaId = firstNonEmptyString(raw, [
    "mediaId",
    "media_id",
    "message.mediaId",
    "message.media.id",
    "media.id",
    "attachment.mediaId",
    "attachments.0.mediaId",
  ]);
  const text = firstNonEmptyString(raw, ["text", "body", "messageText", "message.text", "message.body"]);
  const caption = firstNonEmptyString(raw, [
    "caption",
    "mediaCaption",
    "message.caption",
    "message.media.caption",
    "media.caption",
    "attachment.caption",
    "attachments.0.caption",
  ]);

  const latitude = firstDefinedValue(raw, [
    "latitude",
    "lat",
    "location.latitude",
    "location.lat",
    "message.location.latitude",
    "message.location.lat",
  ]);
  const longitude = firstDefinedValue(raw, [
    "longitude",
    "lng",
    "lon",
    "location.longitude",
    "location.lng",
    "message.location.longitude",
    "message.location.lng",
  ]);
  const locationName = firstNonEmptyString(raw, ["location.name", "message.location.name"]);
  const locationAddress = firstNonEmptyString(raw, [
    "location.address",
    "message.location.address",
  ]);

  let inferredType = explicitType;
  if (!inferredType) {
    if (latitude !== undefined && longitude !== undefined) inferredType = "location";
    else if (imageUrl) inferredType = "image";
    else if (videoUrl) inferredType = "video";
    else if (audioUrl) inferredType = "audio";
    else if (documentUrl) inferredType = "document";
    else if (genericMediaUrl || mediaId)
      inferredType =
        normalizeAgentMediaType("", mimeType, filename, genericMediaUrl || filename) ||
        "document";
    else if (text) inferredType = "text";
  }

  return {
    waTo,
    text,
    caption,
    filename,
    mimeType,
    mediaId,
    imageUrl,
    videoUrl,
    audioUrl,
    documentUrl,
    mediaUrl: genericMediaUrl,
    type: inferredType,
    location: {
      latitude,
      longitude,
      name: locationName,
      address: locationAddress,
    },
  };
}

function extractInboundMeta(msg) {
  if (!msg) return {};

  if (msg?.type === "audio") {
    return {
      kind: "AUDIO",
      mediaId: msg?.audio?.id,
      mimeType: msg?.audio?.mime_type,
      voice: msg?.audio?.voice,
      mediaUrl: msg?.audio?.id ? buildHubMediaUrlStatic(msg.audio.id) : undefined,
    };
  }

  if (msg?.type === "location") {
    return {
      kind: "LOCATION",
      latitude: msg?.location?.latitude,
      longitude: msg?.location?.longitude,
      name: msg?.location?.name,
      address: msg?.location?.address,
    };
  }

  if (msg?.type === "image") {
    return {
      kind: "IMAGE",
      mediaId: msg?.image?.id,
      mimeType: msg?.image?.mime_type,
      caption: msg?.image?.caption,
      mediaUrl: msg?.image?.id ? buildHubMediaUrlStatic(msg.image.id) : undefined,
    };
  }

  if (msg?.type === "video") {
    return {
      kind: "VIDEO",
      mediaId: msg?.video?.id,
      mimeType: msg?.video?.mime_type,
      caption: msg?.video?.caption,
      mediaUrl: msg?.video?.id ? buildHubMediaUrlStatic(msg.video.id) : undefined,
    };
  }

  if (msg?.type === "document") {
    return {
      kind: "DOCUMENT",
      mediaId: msg?.document?.id,
      mimeType: msg?.document?.mime_type,
      filename: msg?.document?.filename,
      caption: msg?.document?.caption,
      mediaUrl: msg?.document?.id ? buildHubMediaUrlStatic(msg.document.id) : undefined,
    };
  }

  if (msg?.type === "contacts" && Array.isArray(msg?.contacts)) {
    return {
      kind: "CONTACTS",
      count: msg.contacts.length,
    };
  }

  if (msg?.type === "order") {
    return {
      kind: "ORDER",
      productItems: msg?.order?.product_items || [],
      catalogId: msg?.order?.catalog_id,
      text: msg?.order?.text,
    };
  }

  return {
    kind: String(msg?.type || "TEXT").toUpperCase(),
  };
}

function describeInboundMessage(msg) {
  if (!msg) return "";
  if (msg?.type === "text") return String(msg?.text?.body || "").trim();
  if (msg?.type === "image") return msg?.image?.caption || "🖼️ Imagen recibida";
  if (msg?.type === "video") return msg?.video?.caption || "🎥 Video recibido";
  if (msg?.type === "audio") return "🎧 Audio recibido";
  if (msg?.type === "document") {
    const filename = String(msg?.document?.filename || "").trim();
    return filename ? `📄 Documento recibido: ${filename}` : "📄 Documento recibido";
  }
  if (msg?.type === "contacts") return "👤 Contacto compartido";
  if (msg?.type === "location") return "📍 Ubicación recibida";
  if (msg?.type === "order") {
    const items = Array.isArray(msg?.order?.product_items) ? msg.order.product_items.length : 0;
    return `🛒 Carrito recibido (${items} producto(s))`;
  }
  return `[${String(msg?.type || "unknown").toUpperCase()}]`;
}

function isAutomationBlocked(session) {
  return Boolean(
    session?.conversationMode === "human" ||
      (session?.human_until && Date.now() < session.human_until)
  );
}

async function reportInboundToBothub({ session, from, name, msg, bodyText }) {
  const inboundMeta = extractInboundMeta(msg);
  const payload = {
    direction: "INBOUND",
    from: String(from || ""),
    body: String(bodyText || describeInboundMessage(msg) || "").trim(),
    source: "WHATSAPP",
    waMessageId: msg?.id,
    name: name || undefined,
    kind: inboundMeta?.kind || (msg?.type ? String(msg.type).toUpperCase() : "UNKNOWN"),
    mediaUrl: inboundMeta?.mediaUrl || undefined,
    meta: inboundMeta,
  };
  debugJson("📨 reportInboundToBothub", payload);
  const ack = await bothubReportMessage(payload);
  debugJson("🧾 Bothub inbound ack", ack || {});
  updateSessionHubConversationId(session, ack);
  if (session?.hubConversationId) {
    debugJson("🧵 hubConversationId actualizada", {
      hubConversationId: session.hubConversationId,
      waMessageId: msg?.id || null,
      from: String(from || ""),
    });
  }
  return ack;
}

async function reportOutboundToBothub({ to, body, source = "BOT", kind = "TEXT", meta = {}, mediaUrl = "", skip = false }) {
  if (skip) {
    debugJson("ℹ️ reportOutboundToBothub omitido", {
      to: String(to || ""),
      source,
      kind,
    });
    return null;
  }
  const payload = {
    direction: "OUTBOUND",
    to: String(to || ""),
    body: String(body || "").trim(),
    source,
    kind,
    mediaUrl: mediaUrl || undefined,
    meta: meta && Object.keys(meta).length ? meta : undefined,
  };
  debugJson("📤 reportOutboundToBothub", payload);
  const ack = await bothubReportMessage(payload);
  debugJson("🧾 Bothub outbound ack", ack || {});
  return ack;
}

async function getMetaMediaInfo(mediaId) {
  if (!WA_TOKEN) throw new Error("WA_TOKEN no configurado");
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(mediaId)}`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
  });
  return res?.data || {};
}

async function downloadMetaMedia(mediaId) {
  const info = await getMetaMediaInfo(mediaId);
  const mediaUrl = info?.url;
  if (!mediaUrl) throw new Error("Meta no devolvió URL de media");

  const res = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
  });

  return {
    buffer: Buffer.from(res.data),
    mimeType: res.headers["content-type"] || info?.mime_type || "application/octet-stream",
    filename: sanitizeFileName(
      info?.filename || `media-${mediaId}${extFromMimeType(info?.mime_type)}`,
      `media-${mediaId}`
    ),
  };
}

// (Se mantiene por si lo usas luego)
function isGreetingOnly(text) {
  const t = normalizeText(text);

  const greetings = [
    "hola",
    "holaa",
    "buenas",
    "buenos dias",
    "buenas tardes",
    "buenas noches",
    "saludos",
    "hey",
    "hi",
    "hello",
    "buen dia",
    "buen día",
  ];

  const words = t.split(" ").filter(Boolean);
  const short = words.length <= 3;
  const isGreeting = greetings.some((g) => t === g || t.startsWith(g + " "));

  return short && isGreeting;
}

// =============================
// Cargar catálogo
// (se mantiene, porque se usa para mapear carrito meta)
// =============================
const catalog = require("./catalog.json");

const productIndex = catalog.map((prod) => {
  return {
    id: prod.id,
    data: prod,
  };
});

// =============================
// UPSTASH (sesión)
// =============================
async function getSession(userId) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;

  try {
    const res = await axios.post(UPSTASH_URL, ["GET", `session:${userId}`], {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });

    if (res.data && res.data.result) {
      return ensureSessionDefaults(JSON.parse(res.data.result));
    }
  } catch (error) {
    console.error(
      "❌ Error obteniendo sesión de Redis:",
      error?.response?.data || error
    );
  }
  return ensureSessionDefaults({});
}

async function setSession(userId, sessionData) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;

  try {
    const cleanSession = ensureSessionDefaults(sessionData);
    await axios.post(
      UPSTASH_URL,
      ["SET", `session:${userId}`, JSON.stringify(cleanSession)],
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
  } catch (error) {
    console.error(
      "❌ Error guardando sesión en Redis:",
      error?.response?.data || error
    );
  }
}

// =============================
// WHATSAPP CLOUD API
// =============================
async function waSend(payload) {
  if (!WA_TOKEN || !PHONE_NUMBER_ID) {
    console.error("❌ Faltan variables WA_TOKEN o PHONE_NUMBER_ID");
    return;
  }

  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
  debugJson("➡️ waSend payload", {
    to: payload?.to,
    type: payload?.type,
    text: payload?.text,
    interactiveType: payload?.interactive?.type,
  });

  try {
    const response = await axios.post(
      url,
      { messaging_product: "whatsapp", ...payload },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    debugJson("✅ waSend response", response?.data || {});
    return response?.data || null;
  } catch (error) {
    console.error(
      "❌ Error enviando mensaje WhatsApp:",
      error?.response?.data || error
    );
    throw error;
  }
}

async function sendWhatsAppText(to, text, reportSource = "BOT", reportMeta = {}) {
  const recipient = toWARecipient(to) || onlyDigits(to);
  await waSend({
    to: recipient,
    type: "text",
    text: { body: text },
  });

  await reportOutboundToBothub({
    to: recipient,
    body: text,
    source: reportSource,
    kind: "TEXT",
    meta: reportMeta,
    skip: reportMeta?.skipBothub === true,
  });
}

// ✅ BOTÓN QUE ABRE LINK (CTA URL)
async function sendWhatsAppCtaUrl(
  to,
  bodyText,
  buttonText,
  url,
  reportSource = "BOT",
  reportMeta = {}
) {
  const recipient = toWARecipient(to) || onlyDigits(to);

  await waSend({
    to: recipient,
    type: "interactive",
    interactive: {
      type: "cta_url",
      body: { text: bodyText },
      action: {
        name: "cta_url",
        parameters: {
          display_text: buttonText,
          url: url,
        },
      },
    },
  });

  await reportOutboundToBothub({
    to: recipient,
    body: bodyText,
    source: reportSource,
    kind: "INTERACTIVE",
    meta: {
      ...reportMeta,
      buttonText,
      url,
      interactiveType: "cta_url",
    },
    skip: reportMeta?.skipBothub === true,
  });
}

async function sendWhatsAppLocation(
  to,
  { latitude, longitude, name = "", address = "" },
  reportSource = "BOT",
  reportMeta = {}
) {
  const recipient = toWARecipient(to) || onlyDigits(to);
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("latitude y longitude son requeridos");
  }

  await waSend({
    to: recipient,
    type: "location",
    location: {
      latitude: lat,
      longitude: lng,
      name: name || undefined,
      address: address || undefined,
    },
  });

  await reportOutboundToBothub({
    to: recipient,
    body: name ? `📍 Ubicación enviada: ${name}` : "📍 Ubicación enviada",
    source: reportSource,
    kind: "LOCATION",
    meta: { latitude: lat, longitude: lng, name: name || undefined, address: address || undefined, ...reportMeta },
    skip: reportMeta?.skipBothub === true,
  });
}

async function sendWhatsAppImage(to, imageUrl, caption = "", reportSource = "BOT", reportMeta = {}) {
  const recipient = toWARecipient(to) || onlyDigits(to);
  await waSend({
    to: recipient,
    type: "image",
    image: { link: imageUrl, caption: caption || undefined },
  });
  await reportOutboundToBothub({
    to: recipient,
    body: caption || "Imagen enviada",
    source: reportSource,
    kind: "IMAGE",
    mediaUrl: imageUrl,
    meta: { imageUrl, caption: caption || undefined, ...reportMeta },
    skip: reportMeta?.skipBothub === true,
  });
}

async function sendWhatsAppVideo(to, videoUrl, caption = "", reportSource = "BOT", reportMeta = {}) {
  const recipient = toWARecipient(to) || onlyDigits(to);
  await waSend({
    to: recipient,
    type: "video",
    video: { link: videoUrl, caption: caption || undefined },
  });
  await reportOutboundToBothub({
    to: recipient,
    body: caption || "Video enviado",
    source: reportSource,
    kind: "VIDEO",
    mediaUrl: videoUrl,
    meta: { videoUrl, caption: caption || undefined, ...reportMeta },
    skip: reportMeta?.skipBothub === true,
  });
}

async function sendWhatsAppAudio(to, audioUrl, reportSource = "BOT", reportMeta = {}) {
  const recipient = toWARecipient(to) || onlyDigits(to);
  await waSend({
    to: recipient,
    type: "audio",
    audio: { link: audioUrl },
  });
  await reportOutboundToBothub({
    to: recipient,
    body: "Audio enviado",
    source: reportSource,
    kind: "AUDIO",
    mediaUrl: audioUrl,
    meta: { audioUrl, ...reportMeta },
    skip: reportMeta?.skipBothub === true,
  });
}

async function sendWhatsAppDocument(
  to,
  documentUrl,
  filename = "",
  caption = "",
  reportSource = "BOT",
  reportMeta = {}
) {
  const recipient = toWARecipient(to) || onlyDigits(to);
  await waSend({
    to: recipient,
    type: "document",
    document: {
      link: documentUrl,
      filename: filename || undefined,
      caption: caption || undefined,
    },
  });
  await reportOutboundToBothub({
    to: recipient,
    body: caption || filename || "Documento enviado",
    source: reportSource,
    kind: "DOCUMENT",
    mediaUrl: documentUrl,
    meta: { documentUrl, filename: filename || undefined, caption: caption || undefined, ...reportMeta },
    skip: reportMeta?.skipBothub === true,
  });
}

async function sendWhatsAppMediaById(
  to,
  type,
  mediaId,
  { caption = "", filename = "" } = {},
  reportSource = "BOT",
  reportMeta = {}
) {
  if (!mediaId) throw new Error("mediaId is required");

  const normalizedType = normalizeAgentMediaType(type);
  if (!["image", "video", "audio", "document"].includes(normalizedType)) {
    throw new Error(`Unsupported media type: ${type}`);
  }

  const recipient = toWARecipient(to) || onlyDigits(to);
  const payload = {
    to: recipient,
    type: normalizedType,
    [normalizedType]: { id: mediaId },
  };

  if ((normalizedType === "image" || normalizedType === "video") && caption) {
    payload[normalizedType].caption = caption;
  }

  if (normalizedType === "document") {
    if (caption) payload.document.caption = caption;
    if (filename) payload.document.filename = filename;
  }

  await waSend(payload);

  const hubMediaUrl = buildHubMediaUrlStatic(mediaId);
  await reportOutboundToBothub({
    to: recipient,
    body:
      caption ||
      (normalizedType === "image"
        ? "Imagen enviada"
        : normalizedType === "video"
        ? "Video enviado"
        : normalizedType === "audio"
        ? "Audio enviado"
        : filename || "Documento enviado"),
    source: reportSource,
    kind: normalizedType.toUpperCase(),
    mediaUrl: hubMediaUrl || undefined,
    meta: { mediaId, mediaUrl: hubMediaUrl || undefined, filename: filename || undefined, caption: caption || undefined, ...reportMeta },
    skip: reportMeta?.skipBothub === true,
  });
}

// =============================
// ✅ CHATWOOT
// =============================
function chatwootEnabled() {
  return Boolean(
    CHATWOOT_BASE_URL &&
      CHATWOOT_ACCOUNT_ID &&
      CHATWOOT_INBOX_ID &&
      CHATWOOT_API_TOKEN
  );
}

function cwBase() {
  return String(CHATWOOT_BASE_URL || "").replace(/\/+$/, "");
}

function chatwootHeaders() {
  return {
    api_access_token: CHATWOOT_API_TOKEN,
    "Content-Type": "application/json",
  };
}

async function cwGetOrCreateContact({ phone, name }) {
  if (!chatwootEnabled()) return null;

  const cleanPhone = onlyDigits(phone);
  const e164Phone = toE164(cleanPhone);
  if (!cleanPhone || !e164Phone) return null;

  try {
    const searchRes = await axios.get(
      `${cwBase()}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/search`,
      {
        params: { q: cleanPhone },
        headers: chatwootHeaders(),
      }
    );

    const found = searchRes.data?.payload?.[0];
    if (found?.id) return found.id;
  } catch (_) {}

  try {
    const createRes = await axios.post(
      `${cwBase()}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`,
      {
        name: name || cleanPhone,
        phone_number: e164Phone,
      },
      { headers: chatwootHeaders() }
    );

    const createdId =
      createRes.data?.payload?.contact?.id ||
      createRes.data?.payload?.id ||
      createRes.data?.contact?.id ||
      createRes.data?.id ||
      null;

    if (createdId) return createdId;
  } catch (err) {
    try {
      const searchRes2 = await axios.get(
        `${cwBase()}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/search`,
        {
          params: { q: cleanPhone },
          headers: chatwootHeaders(),
        }
      );

      const found2 = searchRes2.data?.payload?.[0];
      if (found2?.id) return found2.id;
    } catch (_) {}

    console.error("❌ Chatwoot contacto:", err?.response?.data || err.message);
  }

  return null;
}

async function cwGetOrCreateConversation({ session, phone, contactId }) {
  if (!chatwootEnabled()) return null;

  if (session?.cw_conversation_id) return session.cw_conversation_id;

  try {
    const convRes = await axios.post(
      `${cwBase()}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
      {
        source_id: onlyDigits(phone),
        inbox_id: Number(CHATWOOT_INBOX_ID),
        contact_id: contactId,
      },
      { headers: chatwootHeaders() }
    );

    const conversationId =
      convRes.data?.id ||
      convRes.data?.payload?.id ||
      convRes.data?.payload?.conversation?.id ||
      null;

    if (conversationId) {
      session.cw_conversation_id = conversationId;
      return conversationId;
    }

    return null;
  } catch (err) {
    console.error(
      "❌ Chatwoot conversación:",
      err?.response?.data || err.message
    );
    return null;
  }
}

async function sendToChatwoot({ session, from, name, message }) {
  if (!chatwootEnabled()) return;

  debugJson("📨 sendToChatwoot", {
    from,
    name,
    cw_conversation_id: session?.cw_conversation_id || null,
    message,
  });

  try {
    const contactId = await cwGetOrCreateContact({
      phone: from,
      name: name || from,
    });

    if (!contactId) return;

    const conversationId = await cwGetOrCreateConversation({
      session,
      phone: from,
      contactId,
    });

    if (!conversationId) return;

    await axios.post(
      `${cwBase()}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
      {
        content: message,
        message_type: 0,
        private: false,
      },
      { headers: chatwootHeaders() }
    );
  } catch (err) {
    console.error("❌ Chatwoot mensaje:", err?.response?.data || err.message);
  }
}

async function sendBotToChatwoot({ session, from, name, message }) {
  if (!chatwootEnabled()) return;

  debugJson("🤖 sendBotToChatwoot", {
    from,
    name,
    cw_conversation_id: session?.cw_conversation_id || null,
    message,
  });

  try {
    const contactId = await cwGetOrCreateContact({
      phone: from,
      name: name || from,
    });

    if (!contactId) return;

    const conversationId = await cwGetOrCreateConversation({
      session,
      phone: from,
      contactId,
    });

    if (!conversationId) return;

    await axios.post(
      `${cwBase()}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
      {
        content: message,
        message_type: 1,
        private: true,
      },
      { headers: chatwootHeaders() }
    );
  } catch (err) {
    console.error("❌ Chatwoot BOT:", err?.response?.data || err.message);
  }
}

// ✅ Webhook Chatwoot -> WhatsApp (si tú respondes manual)
app.post("/chatwoot/webhook", async (req, res) => {
  try {
    const event = req.body;
    debugJson("📥 /chatwoot/webhook body", event);

    const mt = event?.message_type;
    const isOutgoing = mt === "outgoing" || mt === 1;
    if (!isOutgoing) return res.sendStatus(200);

    if (event?.private === true) return res.sendStatus(200);

    const senderType = String(event?.sender?.type || "").toLowerCase();
    if (senderType && senderType !== "user") return res.sendStatus(200);

    const content = event?.content?.trim();
    if (!content) return res.sendStatus(200);

    const phone =
      event?.conversation?.meta?.sender?.phone_number ||
      event?.conversation?.contact?.phone_number ||
      event?.conversation?.contact_inbox?.source_id ||
      event?.conversation?.meta?.sender?.identifier ||
      null;

    if (!phone) return res.sendStatus(200);

    const userPhone = onlyDigits(phone);
    debugJson("📤 Chatwoot -> WhatsApp", {
      phone: userPhone,
      content,
      senderType,
      isOutgoing,
    });

    let session = (await getSession(userPhone)) || ensureSessionDefaults({});
    session = ensureSessionDefaults(session);
    const automationBlocked = isAutomationBlocked(session);

    // ✅ pausar bot 30 min cuando el humano responde
    session.human_until = Date.now() + 30 * 60 * 1000;
    debugJson("⏸️ human_until activado desde Chatwoot", {
      userPhone,
      human_until: session.human_until,
      human_until_iso: new Date(session.human_until).toISOString(),
    });
    await cancelReminders(userPhone, session, "chatwoot_human_reply");
    await cancelFollowupTick(userPhone, session, "chatwoot_human_reply");
    await setSession(userPhone, session);

    await sendWhatsAppText(userPhone, content, "AGENT", { channel: "chatwoot" });
    return res.sendStatus(200);
  } catch (e) {
    console.error("❌ Error /chatwoot/webhook:", e?.response?.data || e.message);
    return res.sendStatus(200);
  }
});

app.post("/agent_message", async (req, res) => {
  try {
    if (!BOTHUB_WEBHOOK_SECRET) {
      return res.status(400).json({ error: "BOTHUB_WEBHOOK_SECRET not configured" });
    }

    const signature = getHubSignature(req);
    const okSig = verifyHubSignature(req.body, signature, BOTHUB_WEBHOOK_SECRET);

    if (!signature || !okSig) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const payload = extractAgentMessagePayload(req.body || {});
    const waTo = String(payload.waTo || "").trim();
    const text = String(payload.text || "").trim();
    const caption = String(payload.caption || "").trim();
    const filename = String(payload.filename || "").trim();
    const mimeType = String(payload.mimeType || "").trim();
    const mediaId = String(payload.mediaId || "").trim();
    const inferredType = normalizeAgentMediaType(
      payload.type,
      mimeType,
      filename,
      payload.mediaUrl || ""
    );

    if (!waTo) return res.status(400).json({ error: "waTo is required" });
    if (!inferredType) {
      return res.status(400).json({
        error: "One of text, image/video/audio/document payload or location is required",
      });
    }

    let session = (await getSession(waTo)) || ensureSessionDefaults({});
    session.human_until = Date.now() + 30 * 60 * 1000;

    if (inferredType === "text") {
      if (!text) return res.status(400).json({ error: "text is required" });
      await sendWhatsAppText(waTo, text, "AGENT", { channel: "bothub" });
    } else if (inferredType === "location") {
      await sendWhatsAppLocation(waTo, payload.location || {}, "AGENT", { channel: "bothub" });
    } else if (mediaId) {
      await sendWhatsAppMediaById(
        waTo,
        inferredType,
        mediaId,
        { caption: caption || text, filename },
        "AGENT",
        { channel: "bothub" }
      );
    } else {
      const mediaUrl =
        inferredType === "image"
          ? payload.imageUrl
          : inferredType === "video"
          ? payload.videoUrl
          : inferredType === "audio"
          ? payload.audioUrl
          : inferredType === "document"
          ? payload.documentUrl
          : payload.mediaUrl;

      if (!mediaUrl) {
        return res.status(400).json({ error: `${inferredType} media source is required` });
      }

      if (inferredType === "image") {
        await sendWhatsAppImage(waTo, mediaUrl, caption || text, "AGENT", { channel: "bothub" });
      } else if (inferredType === "video") {
        await sendWhatsAppVideo(waTo, mediaUrl, caption || text, "AGENT", { channel: "bothub" });
      } else if (inferredType === "audio") {
        await sendWhatsAppAudio(waTo, mediaUrl, "AGENT", { channel: "bothub" });
      } else if (inferredType === "document") {
        await sendWhatsAppDocument(waTo, mediaUrl, filename || guessFilenameFromUrl(mediaUrl, "file", mimeType), caption || text, "AGENT", { channel: "bothub" });
      }
    }

    await cancelReminders(waTo, session, "agent_message");
    await cancelFollowupTick(waTo, session, "agent_message");
    await setSession(waTo, session);

    return res.json({ ok: true, waTo, sentType: inferredType });
  } catch (e) {
    console.error("❌ agent_message error:", e?.response?.data || e?.message || e);
    return res.status(500).json({ error: "Internal error" });
  }
});

app.post("/conversation_mode", async (req, res) => {
  try {
    if (!BOTHUB_WEBHOOK_SECRET) {
      return res.status(400).json({ error: "BOTHUB_WEBHOOK_SECRET not configured" });
    }

    const signature = getHubSignature(req);
    const okSig = verifyHubSignature(req.body, signature, BOTHUB_WEBHOOK_SECRET);

    if (!signature || !okSig) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const { waTo, mode, note, notifyUser } = req.body || {};
    const normalizedMode = String(mode || "").trim().toLowerCase();
    if (!waTo || !String(waTo).trim())
      return res.status(400).json({ error: "waTo is required" });
    if (!["bot", "human"].includes(normalizedMode)) {
      return res.status(400).json({ error: "mode must be 'bot' or 'human'" });
    }

    const target = String(waTo).trim();
    const session = (await getSession(target)) || ensureSessionDefaults({});
    session.conversationMode = normalizedMode;
    if (normalizedMode === "bot") {
      session.human_until = null;
    } else {
      session.human_until = Date.now() + 30 * 60 * 1000;
      await cancelReminders(target, session, "conversation_mode_human");
      await cancelFollowupTick(target, session, "conversation_mode_human");
    }
    await setSession(target, session);

    const shouldNotify =
      typeof notifyUser === "boolean" ? notifyUser : HUMAN_MODE_NOTIFY_USER;

    if (shouldNotify === true) {
      if (normalizedMode === "human") {
        await sendWhatsAppText(
          target,
          note ||
            "👤 Tu conversación quedó en modo humano. Un asesor continuará por este chat.",
          "BOT",
          { channel: "conversation_mode" }
        );
      } else {
        await sendWhatsAppText(
          target,
          note ||
            "🤖 El asistente virtual quedó reactivado. Puedes volver a escribirme por aquí.",
          "BOT",
          { channel: "conversation_mode" }
        );
      }
    }

    return res.json({ ok: true, waTo: target, mode: normalizedMode });
  } catch (e) {
    console.error("❌ conversation_mode error:", e?.response?.data || e?.message || e);
    return res.status(500).json({ error: "Internal error" });
  }
});

app.get("/hub_media/:mediaId", async (req, res) => {
  try {
    const { mediaId } = req.params || {};
    const ts = String(req.query?.ts || "");
    const sig = String(req.query?.sig || "");

    if (!mediaId) return res.status(400).json({ error: "mediaId is required" });
    if (!verifyHubMediaToken(mediaId, ts, sig)) {
      return res.status(401).json({ error: "Invalid or expired media signature" });
    }
    if (!WA_TOKEN) return res.status(500).json({ error: "WA_TOKEN not configured in bot" });

    const downloaded = await downloadMetaMedia(mediaId);

    res.setHeader("Content-Type", downloaded.mimeType || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${String(downloaded.filename || "media").replace(/"/g, "")}"`
    );
    return res.status(200).send(downloaded.buffer);
  } catch (e) {
    console.error("❌ hub_media error:", e?.response?.data || e?.message || e);
    return res.status(500).json({
      error: "hub_media_failed",
      detail: e?.response?.data || e?.message || "unknown",
    });
  }
});

// =============================
// WEBHOOK VERIFY
// =============================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado correctamente.");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// =============================
// ✅ HEALTH + TICK (NUEVO)
// =============================
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

app.get("/tick", async (req, res) => {
  try {
    debugJson("⏰ /tick llamado", {
      hasToken: Boolean(req.query?.token),
      query: req.query || {},
    });
    const token = String(req.query?.token || "");
    if (!TICK_TOKEN || token !== TICK_TOKEN) return res.sendStatus(403);

    await processDueFollowupsTick();
    return res.status(200).send("tick ok");
  } catch (e) {
    console.error("❌ /tick error:", e?.response?.data || e.message || e);
    return res.status(200).send("tick ok");
  }
});

// =============================
// ✅ PROCESADOR PRINCIPAL
// =============================
async function processInboundWhatsApp(body) {
  try {
    debugJson("📥 processInboundWhatsApp body", body);

    if (body.object !== "whatsapp_business_account") {
      debugLog("⚠️ body.object ignorado", body?.object);
      return;
    }

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const messages = value?.messages;
    if (!messages || messages.length === 0) {
      debugJson("ℹ️ Webhook sin messages", value || {});
      return;
    }

    const msg = messages[0];
    const userPhone = msg.from;
    const msgType = msg.type;
    const msgId = msg.id;

    const customerName = value?.contacts?.[0]?.profile?.name || "";

    debugJson("📩 Mensaje entrante detectado", {
      userPhone,
      msgType,
      msgId,
      customerName,
      timestamp: msg?.timestamp || null,
    });

    let session = (await getSession(userPhone)) || {};
    session = ensureSessionDefaults(session);
    if (!session.order) session.order = {};
    if (!session.state) session.state = "INIT";
    const automationBlocked = isAutomationBlocked(session);

    debugJson("🧠 Sesión cargada", {
      userPhone,
      state: session.state,
      human_until: session.human_until || null,
      human_until_iso: session.human_until
        ? new Date(session.human_until).toISOString()
        : null,
      inbound_text_count: session.inbound_text_count,
      last_welcome_ts: session.last_welcome_ts || null,
      cw_conversation_id: session.cw_conversation_id || null,
      has_order_items: Array.isArray(session.order?.items)
        ? session.order.items.length
        : 0,
    });

    // ✅ contador de textos entrantes (NUEVO)
    if (typeof session.inbound_text_count !== "number")
      session.inbound_text_count = 0;

    // ✅ DEDUPE por msgId
    if (msgId && session.last_wa_msg_id === msgId) {
      debugJson("♻️ Mensaje duplicado ignorado", {
        userPhone,
        msgId,
      });
      return;
    }
    if (msgId) session.last_wa_msg_id = msgId;


    // =============================
    // ✅ 1) TEXTO (BIENVENIDA SOLO 1 VEZ CADA 24 HORAS)
    // =============================
    if (msgType === "text") {
      const userText = msg.text?.body?.trim() || "";
      debugJson("💬 Rama text", {
        userPhone,
        msgId,
        text: userText,
      });

      await sendToChatwoot({
        session,
        from: userPhone,
        name: customerName || userPhone,
        message: userText,
      });

      await reportInboundToBothub({
        session,
        from: userPhone,
        name: customerName || userPhone,
        msg,
        bodyText: userText,
      });

      // ✅ cuenta este texto como mensaje del usuario (NUEVO)
      session.inbound_text_count = (session.inbound_text_count || 0) + 1;
      debugJson("🔢 inbound_text_count actualizado", {
        userPhone,
        inbound_text_count: session.inbound_text_count,
      });

      // ✅ Si ya escribió 2do mensaje => cancelar recordatorios (NUEVO)
      if (session.inbound_text_count >= 2) {
        await cancelReminders(userPhone, session, "user_sent_second_message");
        await cancelFollowupTick(userPhone, session, "user_sent_second_message");
      }

      // ✅ modo manual / humano: no responder automáticamente
      if (MANUAL_MODE || automationBlocked) {
        debugJson("🛑 Respuesta automática bloqueada", {
          userPhone,
          msgId,
          MANUAL_MODE,
          conversationMode: session.conversationMode,
          human_until: session.human_until || null,
          automationBlocked,
        });
        await setSession(userPhone, session);
        return;
      }

      // ✅ Si el usuario ya tiene carrito y estamos esperando ubicación,
      // responder recordando que debe enviar la ubicación.
      if (session.state === "AWAIT_LOCATION") {
        debugJson("📍 Texto recibido mientras se espera ubicación", {
          userPhone,
          msgId,
          text: userText,
          order_items_count: Array.isArray(session.order?.items)
            ? session.order.items.length
            : 0,
        });

        await sendWhatsAppText(
          userPhone,
          `Tengo tu carrito pendiente 😊🛒
Por favor envíame tu ubicación 📍 para continuar con tu pedido.

Puedes hacerlo desde el clip 📎 > Ubicación > Enviar. 💗`
        );

        await sendBotToChatwoot({
          session,
          from: userPhone,
          name: customerName || userPhone,
          message: "BOT: Recordatorio de ubicación enviado porque el cliente escribió texto mientras estaba en AWAIT_LOCATION.",
        });

        await setSession(userPhone, session);
        return;
      }

      // ✅ BIENVENIDA SOLO 1 VEZ CADA 24 HORAS
      const now = Date.now();
      const lastWelcome = session.last_welcome_ts || 0;
      debugJson("⏱️ Control bienvenida", {
        userPhone,
        now,
        now_iso: new Date(now).toISOString(),
        lastWelcome,
        lastWelcome_iso: lastWelcome ? new Date(lastWelcome).toISOString() : null,
        diff_ms: now - lastWelcome,
        cooldown_ms: WELCOME_COOLDOWN_MS,
      });

      // ✅ Si es primer mensaje (inbound_text_count === 1), activamos recordatorios (NUEVO)
      // (Solo se activan si no escribe un segundo mensaje y no envía carrito)
      if (session.inbound_text_count === 1) {
        // ✅ robusto: cola Upstash + /tick
        await scheduleFollowupTick(userPhone, session);

        // (Se mantiene el método viejo, pero al marcar use_tick, no correrá timers)
        await startRemindersIfEligible(userPhone, session);
      }

      if (now - lastWelcome < WELCOME_COOLDOWN_MS) {
        debugJson("⏳ Bienvenida omitida por cooldown", {
          userPhone,
          msgId,
          diff_ms: now - lastWelcome,
          cooldown_ms: WELCOME_COOLDOWN_MS,
        });
        // No envía nada (para no molestar)
        await setSession(userPhone, session);
        return;
      }

      session.last_welcome_ts = now;

      const greetingName = customerName ? ` ${customerName}` : "";
      const welcomeText =
        `¡Hola${greetingName}! 😊✨\n` +
        `Bienvenida a Glowny Essentials 💗\n\n` +
        `🛍️ Puedes hacer tu pedido fácil desde nuestro *Catálogo de WhatsApp*.\n` +
        `✅ Selecciona tus productos y cuando termines tu carrito,\n` +
        `envíame tu *ubicación* 📍 y uno de nuestros representantes se pondrá en contacto contigo 💗`;

      debugJson("👋 Enviando bienvenida CTA", {
        userPhone,
        customerName,
        cta: WHATSAPP_CATALOG_URL,
      });
      await sendWhatsAppCtaUrl(
        userPhone,
        welcomeText,
        "🛍️ Ver catálogo",
        WHATSAPP_CATALOG_URL
      );

      await sendBotToChatwoot({
        session,
        from: userPhone,
        name: customerName || userPhone,
        message: "BOT: Bienvenida enviada (1 vez cada 24h) con CTA URL.",
      });

      await setSession(userPhone, session);
      return;
    }

    // =============================
    // ✅ 2) META CATALOG - ORDER
    // ✅ Pedir ubicación SOLO 1 VEZ justo al llegar el carrito
    // =============================
    if (msgType === "order") {
      const order = msg.order;
      const items = order?.product_items || [];
      debugJson("🛒 Rama order", {
        userPhone,
        msgId,
        items_count: items.length,
        items,
      });

      await sendToChatwoot({
        session,
        from: userPhone,
        name: customerName || userPhone,
        message: `🛒 Carrito recibido (Meta Catalog) - ${items.length} item(s)`,
      });

      await reportInboundToBothub({
        session,
        from: userPhone,
        name: customerName || userPhone,
        msg,
        bodyText: `🛒 Carrito recibido (Meta Catalog) - ${items.length} item(s)`,
      });

      const shouldAutoReply = !MANUAL_MODE && !automationBlocked;

      // ✅ Si llegó carrito => cancelar recordatorios (NUEVO)
      await cancelReminders(userPhone, session, "order_received");
      await cancelFollowupTick(userPhone, session, "order_received");

      if (!items.length) {
        if (shouldAutoReply) {
          await sendWhatsAppText(
            userPhone,
            "Recibí tu carrito 😊🛒\nPero no veo productos dentro. ¿Puedes intentarlo de nuevo desde el catálogo? 💗"
          );
        }
        await setSession(userPhone, session);
        return;
      }

      const parsedItems = [];

      for (const it of items) {
        const retailerId = String(it.product_retailer_id || "").trim();
        const qty = Number(it.quantity || 1);

        const foundById =
          productIndex.find((p) => String(p.data.id) === retailerId) ||
          productIndex.find((p) => String(p.data.meta_id) === retailerId) ||
          null;

        if (foundById?.data) {
          parsedItems.push({
            id: foundById.data.id,
            name: foundById.data.name,
            price: foundById.data.price || null,
            quantity: qty,
          });
        } else {
          parsedItems.push({
            id: retailerId || "unknown",
            name: `Producto ${retailerId || ""}`.trim(),
            price: null,
            quantity: qty,
          });
        }
      }

      session.order = {
        items: parsedItems,
        source: "META_CATALOG",
      };
      debugJson("🧾 order parseado", {
        userPhone,
        parsedItems,
      });

      session.state = "AWAIT_LOCATION";

      const lines = parsedItems.map((p, i) => {
        const priceText = p.price ? ` — RD$${p.price}` : "";
        return `${i + 1}) ${p.name} x${p.quantity}${priceText}`;
      });

      // ✅ Mostrar en Chatwoot lo pedido
      await sendToChatwoot({
        session,
        from: userPhone,
        name: customerName || userPhone,
        message: `✅ Pedido del catálogo:\n${lines.join("\n")}`,
      });

      // ✅ Pedir ubicación SOLO AQUÍ (1 vez por carrito)
      if (shouldAutoReply) {
        await sendWhatsAppText(
          userPhone,
          `✅ Recibí tu carrito 😊🛒\n\n${lines.join(
            "\n"
          )}\n\nAhora envíame tu ubicación 📍 (clip 📎 > Ubicación > Enviar). 💗`
        );

        await sendBotToChatwoot({
          session,
          from: userPhone,
          name: customerName || userPhone,
          message: "BOT: Carrito recibido + pedí ubicación (1 vez).",
        });
      } else {
        await sendBotToChatwoot({
          session,
          from: userPhone,
          name: customerName || userPhone,
          message: "BOT: Carrito recibido en modo humano/manual. Se guardó sin responder automáticamente.",
        });
      }

      await setSession(userPhone, session);
      return;
    }

    // =============================
    // ✅ 3) LOCATION (Finaliza pedido)
    // =============================
    if (msgType === "location") {
      const loc = msg.location;
      if (!loc) return;

      debugJson("📍 Rama location", {
        userPhone,
        msgId,
        location: loc,
        state: session.state,
      });

      const mapPreview =
        loc.latitude && loc.longitude
          ? `📍 Ubicación enviada: https://maps.google.com/?q=${loc.latitude},${loc.longitude}`
          : "📍 Ubicación enviada";

      await sendToChatwoot({
        session,
        from: userPhone,
        name: customerName || userPhone,
        message: mapPreview,
      });

      await reportInboundToBothub({
        session,
        from: userPhone,
        name: customerName || userPhone,
        msg,
        bodyText: mapPreview,
      });

      const shouldAutoReply = !MANUAL_MODE && !automationBlocked;

      if (session.state === "AWAIT_LOCATION") {
        session.order.location = {
          latitude: loc.latitude,
          longitude: loc.longitude,
          name: loc.name || "",
          address: loc.address || "",
        };

        debugJson("✅ Ubicación recibida para pedido activo", {
          userPhone,
          order_items_count: Array.isArray(session.order?.items)
            ? session.order.items.length
            : 0,
        });
        if (shouldAutoReply) {
          await sendWhatsAppText(
            userPhone,
            "Perfecto 🤩 uno de nuestros representantes te estará contactando con los detalles de envíos y pagos."
          );
        }

        // Aviso admin
        const ADMIN_PHONE = toWARecipient(ADMIN_PHONE_RAW);
        if (ADMIN_PHONE) {
          const items = session.order?.items || [];

          const itemsInfo =
            items.length > 0
              ? "\n🛒 Carrito:\n" +
                items
                  .map(
                    (p, i) =>
                      `${i + 1}) ${p.name} x${p.quantity}${
                        p.price ? ` — RD$${p.price}` : ""
                      }`
                  )
                  .join("\n")
              : "";

          const mapLink =
            loc.latitude && loc.longitude
              ? `https://maps.google.com/?q=${loc.latitude},${loc.longitude}`
              : "";

          const adminMsg = `📦 NUEVO PEDIDO - Glowny Essentials
Cliente: ${customerName || "Sin nombre"} (${userPhone})
Fuente: Catálogo Meta
${itemsInfo}
📍 Ubicación: ${mapLink}`;

          debugJson("📣 Enviando aviso al admin", {
            ADMIN_PHONE,
            adminMsg,
          });
          await sendWhatsAppText(ADMIN_PHONE, adminMsg, "BOT", { skipBothub: true });
        }

        // reset pedido
        session.state = "INIT";
        session.order = {};

        // ✅ cancelar recordatorios al finalizar (NUEVO)
        await cancelReminders(
          userPhone,
          session,
          "order_completed_location_received"
        );
        await cancelFollowupTick(
          userPhone,
          session,
          "order_completed_location_received"
        );

        await setSession(userPhone, session);
        return;
      }

      // si manda ubicación sin carrito
      if (shouldAutoReply) {
        await sendWhatsAppText(
          userPhone,
          "Recibí tu ubicación 😊📍\nCuando tengas tu carrito listo, envíamelo desde el catálogo 💗"
        );
      }

      await setSession(userPhone, session);
      return;
    }

    // =============================
    // ⛔ Botones tipo Reply (YA NO SE USAN)
    // (Se deja comentado, NO se borra)
    // =============================
    /*
    if (msgType === "button") {
      // Antes se usaba payload VER_CATALOGO...
    }
    */

    const fallbackText = describeInboundMessage(msg);
    await sendToChatwoot({
      session,
      from: userPhone,
      name: customerName || userPhone,
      message: fallbackText,
    });
    await reportInboundToBothub({
      session,
      from: userPhone,
      name: customerName || userPhone,
      msg,
      bodyText: fallbackText,
    });
    debugJson("ℹ️ Tipo de mensaje no manejado explícitamente", {
      userPhone,
      msgType,
      msgId,
      fallbackText,
    });
    await setSession(userPhone, session);
  } catch (err) {
    console.error("❌ Error procesando inbound:", err?.response?.data || err);
  }
}

// =============================
// ✅ WEBHOOK MAIN (ACK inmediato)
// =============================
app.post("/webhook", (req, res) => {
  if (!verifyMetaSignature(req)) {
    console.error("❌ Firma de Meta inválida en /webhook");
    return res.sendStatus(403);
  }

  debugJson("📥 POST /webhook headers", {
    "content-type": req.headers["content-type"],
    "user-agent": req.headers["user-agent"],
    "x-hub-signature": req.headers["x-hub-signature"] || null,
    "x-hub-signature-256": req.headers["x-hub-signature-256"] || null,
  });
  debugJson("📥 POST /webhook body", req.body);

  res.sendStatus(200);

  setImmediate(() => {
    processInboundWhatsApp(req.body);
  });
});

// =============================
// SERVER
// =============================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Bot de Glowny Essentials escuchando en el puerto ${PORT}`);
  console.log(`🤖 MANUAL_MODE = ${MANUAL_MODE ? "ON (solo Chatwoot)" : "OFF"}`);
  debugJson("🧩 Boot config", {
    port: PORT,
    chatwootEnabled: chatwootEnabled(),
    hasUpstash: Boolean(UPSTASH_URL && UPSTASH_TOKEN),
    hasWaToken: Boolean(WA_TOKEN),
    hasPhoneNumberId: Boolean(PHONE_NUMBER_ID),
    hasVerifyToken: Boolean(VERIFY_TOKEN),
    hasMetaAppSecret: Boolean(META_APP_SECRET),
    hasTickToken: Boolean(TICK_TOKEN),
    bothubEnabled: bothubEnabled(),
    hasBothubWebhookUrl: Boolean(BOTHUB_WEBHOOK_URL),
    hasBothubWebhookSecret: Boolean(BOTHUB_WEBHOOK_SECRET),
    hasBothubJwt: Boolean(BOTHUB_JWT_TOKEN),
    hasBotPublicBaseUrl: Boolean(getStaticPublicBaseUrl()),
  });
});
