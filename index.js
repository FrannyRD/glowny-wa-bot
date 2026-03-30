const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
app.use(express.json());

// =============================
// ENV
// =============================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ADMIN_PHONE_RAW = process.env.ADMIN_PHONE;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN =
  process.env.UPSTASH_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// ✅ CHATWOOT
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CHATWOOT_INBOX_ID = process.env.CHATWOOT_INBOX_ID;
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN;

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
      return JSON.parse(res.data.result);
    }
  } catch (error) {
    console.error(
      "❌ Error obteniendo sesión de Redis:",
      error?.response?.data || error
    );
  }
  return null;
}

async function setSession(userId, sessionData) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;

  try {
    await axios.post(
      UPSTASH_URL,
      ["SET", `session:${userId}`, JSON.stringify(sessionData)],
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

  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
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
  } catch (error) {
    console.error(
      "❌ Error enviando mensaje WhatsApp:",
      error?.response?.data || error
    );
  }
}

async function sendWhatsAppText(to, text) {
  const recipient = toWARecipient(to) || onlyDigits(to);
  await waSend({
    to: recipient,
    type: "text",
    text: { body: text },
  });
}

// ✅ BOTÓN QUE ABRE LINK (CTA URL)
async function sendWhatsAppCtaUrl(to, bodyText, buttonText, url) {
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

    let session = (await getSession(userPhone)) || {};
    if (!session.order) session.order = {};
    if (!session.state) session.state = "INIT";

    // ✅ pausar bot 30 min cuando el humano responde
    session.human_until = Date.now() + 30 * 60 * 1000;
    debugJson("⏸️ human_until activado desde Chatwoot", {
      userPhone,
      human_until: session.human_until,
      human_until_iso: new Date(session.human_until).toISOString(),
    });
    await setSession(userPhone, session);

    await sendWhatsAppText(userPhone, content);
    return res.sendStatus(200);
  } catch (e) {
    console.error("❌ Error /chatwoot/webhook:", e?.response?.data || e.message);
    return res.sendStatus(200);
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
    if (!session.order) session.order = {};
    if (!session.state) session.state = "INIT";

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

    // ✅ si humano está atendiendo, bot pausa
    if (session.human_until && Date.now() < session.human_until) {
      debugJson("⏸️ Mensaje bloqueado por human_until", {
        userPhone,
        msgId,
        now: Date.now(),
        now_iso: new Date().toISOString(),
        human_until: session.human_until,
        human_until_iso: new Date(session.human_until).toISOString(),
      });
      await setSession(userPhone, session);
      return;
    }

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

      // ✅ modo manual: no responder
      if (MANUAL_MODE) {
        debugJson("🛑 MANUAL_MODE activo, no se responde automáticamente", {
          userPhone,
          msgId,
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

      // ✅ Si llegó carrito => cancelar recordatorios (NUEVO)
      await cancelReminders(userPhone, session, "order_received");
      await cancelFollowupTick(userPhone, session, "order_received");

      if (MANUAL_MODE) {
        debugJson("🛑 MANUAL_MODE activo en order, no se responde automáticamente", {
          userPhone,
          msgId,
          items_count: items.length,
        });
        await setSession(userPhone, session);
        return;
      }

      if (!items.length) {
        await sendWhatsAppText(
          userPhone,
          "Recibí tu carrito 😊🛒\nPero no veo productos dentro. ¿Puedes intentarlo de nuevo desde el catálogo? 💗"
        );
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

      if (MANUAL_MODE) {
        debugJson("🛑 MANUAL_MODE activo en location, no se responde automáticamente", {
          userPhone,
          msgId,
        });
        await setSession(userPhone, session);
        return;
      }

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
        await sendWhatsAppText(
          userPhone,
          "Perfecto 🤩 uno de nuestros representantes te estará contactando con los detalles de envíos y pagos."
        );

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
          await sendWhatsAppText(ADMIN_PHONE, adminMsg);
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
      await sendWhatsAppText(
        userPhone,
        "Recibí tu ubicación 😊📍\nCuando tengas tu carrito listo, envíamelo desde el catálogo 💗"
      );

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

    debugJson("ℹ️ Tipo de mensaje no manejado explícitamente", {
      userPhone,
      msgType,
      msgId,
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
    hasTickToken: Boolean(TICK_TOKEN),
  });
});
