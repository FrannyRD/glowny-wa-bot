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

// ✅ URL DIRECTA A CATÁLOGO (opcional)
const WHATSAPP_CATALOG_URL = String(process.env.WHATSAPP_CATALOG_URL || "").trim();

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

function isNumericOnly(text) {
  return /^[0-9]+$/.test(String(text || "").trim());
}

function normalizeText(text) {
  let normalized = (text || "").toLowerCase();
  normalized = normalized.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  normalized = normalized.replace(/[^\w\s]/g, " ");
  normalized = normalized.trim().replace(/\s+/g, " ");
  return normalized;
}

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
  ];

  const words = t.split(" ").filter(Boolean);
  const short = words.length <= 3;
  const isGreeting = greetings.some((g) => t === g || t.startsWith(g + " "));

  return short && isGreeting;
}

// =============================
// Cargar catálogo (NO ELIMINAR)
// =============================
// ✅ Se mantiene porque el Meta Catalog usa productIndex para mapear ids
const catalog = require("./catalog.json");

const SPANISH_STOPWORDS = new Set([
  "de",
  "la",
  "y",
  "con",
  "para",
  "del",
  "en",
  "el",
  "al",
  "por",
  "una",
  "un",
  "unos",
  "unas",
  "lo",
  "los",
  "las",
  "le",
  "les",
  "tu",
  "su",
  "sus",
  "mi",
  "mis",
  "que",
  "quiero",
  "dime",
  "todos",
  "todas",
  "cuales",
  "cuáles",
  "tienes",
  "hay",
  "me",
  "muestrame",
  "muéstrame",
  "lista",
  "producto",
  "productos",
]);

const BRAND_WORDS = new Set(["deliplus", "nivea", "sisbela", "florena"]);

const productIndex = catalog.map((prod) => {
  const nameNorm = normalizeText(prod.name);
  const tokens = nameNorm
    .split(" ")
    .filter((w) => w && !SPANISH_STOPWORDS.has(w) && !BRAND_WORDS.has(w));

  const keywords = new Set(tokens);

  return {
    id: prod.id,
    name: prod.name,
    nameNorm,
    tokens,
    keywords,
    data: prod,
  };
});

// =============================
// UPSTASH (sesión)
// =============================
async function getSession(userId) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;

  try {
    const res = await axios.post(
      UPSTASH_URL,
      ["GET", `session:${userId}`],
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );

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

  try {
    await axios.post(
      url,
      { messaging_product: "whatsapp", ...payload },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
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

async function sendWhatsAppInteractiveButtons(to, bodyText, buttons = []) {
  const recipient = toWARecipient(to) || onlyDigits(to);

  // WhatsApp permite máx 3 botones
  const sliced = buttons.slice(0, 3);

  await waSend({
    to: recipient,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: sliced.map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  });
}

// =============================
// ✅ CHATWOOT
// =============================
function chatwootEnabled() {
  return (
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

// ✅ INCOMING real
async function sendToChatwoot({ session, from, name, message }) {
  if (!chatwootEnabled()) return;

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

// ✅ BOT LOG COMO NOTA PRIVADA
async function sendBotToChatwoot({ session, from, name, message }) {
  if (!chatwootEnabled()) return;

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

// ✅ Webhook para recibir respuestas del agente (Chatwoot → WhatsApp)
app.post("/chatwoot/webhook", async (req, res) => {
  try {
    const event = req.body;

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

    let session = (await getSession(userPhone)) || {};
    if (!session.history) session.history = [];
    if (!session.order) session.order = {};
    if (!session.state) session.state = "INIT";
    if (!session.listCandidates) session.listCandidates = null;

    // ✅ cuando un humano responde: pausar bot 30 min
    session.human_until = Date.now() + 30 * 60 * 1000;

    await setSession(userPhone, session);

    await sendWhatsAppText(userPhone, content);

    return res.sendStatus(200);
  } catch (e) {
    console.error("❌ Error /chatwoot/webhook:", e?.response?.data || e.message);
    return res.sendStatus(200);
  }
});

// =============================
// ✅ Mensajes (solo bienvenida + catálogo)
// =============================
async function sendWelcomeFlow({ userPhone, customerName, session }) {
  const greetingName = customerName ? ` ${customerName}` : "";
  const welcomeText =
    `¡Hola${greetingName}! 😊✨\n` +
    `Bienvenida a Glowny Essentials 💗\n` +
    `Puedes hacer tu pedido fácil desde nuestro *Catálogo de WhatsApp* 🛍️\n\n` +
    `✅ Selecciona tus productos y luego envíame tu *ubicación* 📍 para finalizar.`;

  await sendWhatsAppInteractiveButtons(userPhone, welcomeText, [
    { id: "CATALOG_BTN", title: "🛍 Ver catálogo" },
    { id: "HELP_BTN", title: "📍 Enviar ubicación" },
  ]);

  await sendBotToChatwoot({
    session,
    from: userPhone,
    name: customerName || userPhone,
    message: `BOT: Envié bienvenida con botones (Catálogo / Ubicación).`,
  });
}

async function sendCatalogLinkOrInstructions(userPhone, session) {
  if (WHATSAPP_CATALOG_URL) {
    await sendWhatsAppText(
      userPhone,
      `🛍 Aquí tienes el catálogo de WhatsApp:\n${WHATSAPP_CATALOG_URL}\n\nCuando termines tu carrito, envíame tu ubicación 📍💗`
    );
  } else {
    await sendWhatsAppText(
      userPhone,
      `🛍 Para ver el catálogo:\n1) Toca el nombre *Glowny Essentials* arriba\n2) Entra a *Catálogo*\n3) Agrega tus productos 🛒\n\nLuego envíame tu ubicación 📍 para finalizar 💗`
    );
  }

  await sendBotToChatwoot({
    session,
    from: userPhone,
    name: userPhone,
    message: `BOT: Envié link/instrucciones de catálogo.`,
  });
}

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
// ✅ PROCESADOR PRINCIPAL
// =============================
async function processInboundWhatsApp(body) {
  try {
    if (body.object !== "whatsapp_business_account") return;

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const messages = value?.messages;
    if (!messages || messages.length === 0) return;

    const msg = messages[0];
    const userPhone = msg.from;
    const msgType = msg.type;
    const msgId = msg.id;

    const customerName = value?.contacts?.[0]?.profile?.name || "";

    let session = (await getSession(userPhone)) || {};
    if (!session.history) session.history = [];
    if (!session.order) session.order = {};
    if (!session.state) session.state = "INIT";
    if (!session.listCandidates) session.listCandidates = null;

    // ✅ DEDUPE fuerte por msgId
    if (msgId && session.last_wa_msg_id === msgId) return;
    if (msgId) session.last_wa_msg_id = msgId;

    // ✅ DEDUPE extra por texto + 10s
    const now = Date.now();
    const textForDedupe =
      msgType === "text" ? (msg.text?.body || "").trim() : "";
    if (textForDedupe) {
      const fp = `${normalizeText(textForDedupe)}|${msgType}`;
      if (
        session.last_fp === fp &&
        session.last_fp_ts &&
        now - session.last_fp_ts < 10000
      ) {
        await setSession(userPhone, session);
        return;
      }
      session.last_fp = fp;
      session.last_fp_ts = now;
    }

    if (session.human_until && Date.now() > session.human_until) {
      session.human_until = null;
    }

    // ✅ Si humano está atendiendo y MANUAL_MODE, no respondemos nada automático
    if (MANUAL_MODE) {
      // Aun así, registramos todo en Chatwoot
      if (msgType === "text") {
        const userText = msg.text?.body?.trim() || "";
        await sendToChatwoot({
          session,
          from: userPhone,
          name: customerName || userPhone,
          message: userText,
        });
      }
      await setSession(userPhone, session);
      return;
    }

    // =============================
    // ✅ 1) TEXTO: SOLO BIENVENIDA + CATÁLOGO
    // =============================
    if (msgType === "text") {
      const userText = msg.text?.body?.trim() || "";

      await sendToChatwoot({
        session,
        from: userPhone,
        name: customerName || userPhone,
        message: userText,
      });

      // ✅ anti duplicado saludo
      const greetingOnly = isGreetingOnly(userText);
      if (greetingOnly) {
        const last = session.last_greeting_reply_ts || 0;
        if (Date.now() - last < 15000) {
          await setSession(userPhone, session);
          return;
        }
        session.last_greeting_reply_ts = Date.now();

        // reset (sin dañar meta order)
        session.state = "INIT";
        session.product = null;
        session.sentImage = false;
        session.listCandidates = null;

        await sendWelcomeFlow({ userPhone, customerName, session });
        await setSession(userPhone, session);
        return;
      }

      // ✅ Si escriben cualquier otra cosa → reenviamos catálogo (sin OpenAI)
      await sendWhatsAppInteractiveButtons(
        userPhone,
        `🛍 Para hacer tu pedido, elige los productos desde el *Catálogo de WhatsApp*.\n\nCuando termines tu carrito, envíame tu ubicación 📍💗`,
        [
          { id: "CATALOG_BTN", title: "🛍 Ver catálogo" },
          { id: "HELP_BTN", title: "📍 Enviar ubicación" },
        ]
      );

      await sendBotToChatwoot({
        session,
        from: userPhone,
        name: customerName || userPhone,
        message: `BOT: Cliente escribió texto. Reenvié botones de catálogo/ubicación.`,
      });

      await setSession(userPhone, session);
      return;
    }

    // =============================
    // ✅ 2) INTERACTIVE (botones)
    // =============================
    if (msgType === "interactive") {
      const it = msg.interactive;

      // Registrar en Chatwoot
      await sendToChatwoot({
        session,
        from: userPhone,
        name: customerName || userPhone,
        message: `🟦 Botón presionado: ${it?.button_reply?.title || "interactive"}`,
      });

      const buttonId = it?.button_reply?.id || "";

      if (buttonId === "CATALOG_BTN") {
        await sendCatalogLinkOrInstructions(userPhone, session);
      } else if (buttonId === "HELP_BTN") {
        await sendWhatsAppText(
          userPhone,
          `📍 Para finalizar tu pedido, envíame tu ubicación:\nClip 📎 → *Ubicación* → *Enviar ubicación* ✅`
        );

        await sendBotToChatwoot({
          session,
          from: userPhone,
          name: customerName || userPhone,
          message: `BOT: Envié instrucciones para enviar ubicación.`,
        });
      }

      await setSession(userPhone, session);
      return;
    }

    // =============================
    // ✅ 3) META CATALOG - ORDER (SE MANTIENE)
    // =============================
    if (msgType === "order") {
      const order = msg.order;
      const items = order?.product_items || [];

      // ✅ Mostrar en Chatwoot que llegó carrito
      await sendToChatwoot({
        session,
        from: userPhone,
        name: customerName || userPhone,
        message: `🛒 Carrito recibido (Meta Catalog) - ${items.length} item(s)`,
      });

      if (!items.length) {
        await sendWhatsAppText(
          userPhone,
          "Recibí tu carrito 😊🛒\nPero no veo productos dentro. ¿Quieres intentarlo otra vez desde el catálogo? 💗"
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

      session.state = "AWAIT_LOCATION";
      session.product = null;
      session.sentImage = false;
      session.listCandidates = null;

      const lines = parsedItems.map((p, i) => {
        const priceText = p.price ? ` — RD$${p.price}` : "";
        return `${i + 1}) ${p.name} x${p.quantity}${priceText}`;
      });

      // ✅ Enviar detalle del carrito a Chatwoot (para que el agente lo vea claro)
      await sendToChatwoot({
        session,
        from: userPhone,
        name: customerName || userPhone,
        message: `🧾 Detalle del carrito:\n${lines.join("\n")}`,
      });

      // ✅ Pedir ubicación en WA (finalizar pedido)
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
        message: `BOT: Recibí carrito (Meta) y pedí ubicación.`,
      });

      await setSession(userPhone, session);
      return;
    }

    // =============================
    // ✅ 4) LOCATION (finalizar pedido)
    // =============================
    if (msgType === "location") {
      const loc = msg.location;
      if (!loc) return;

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

      if (session.state === "AWAIT_LOCATION") {
        session.order.location = {
          latitude: loc.latitude,
          longitude: loc.longitude,
          name: loc.name || "",
          address: loc.address || "",
        };

        await sendWhatsAppText(
          userPhone,
          "Perfecto 🤩 uno de nuestros representantes te estará contactando con los detalles de envíos y pagos."
        );

        await sendBotToChatwoot({
          session,
          from: userPhone,
          name: customerName || userPhone,
          message:
            "BOT: Perfecto 🤩 representante contactará con envíos y pagos.",
        });

        const ADMIN_PHONE = toWARecipient(ADMIN_PHONE_RAW);
        if (ADMIN_PHONE) {
          const order = session.order || {};
          const items = order.items || [];

          let locationInfo = "";
          if (order.location?.latitude && order.location?.longitude) {
            const { latitude, longitude, address, name } = order.location;
            const mapLink = `https://maps.google.com/?q=${latitude},${longitude}`;
            locationInfo = `📍 Ubicación: ${name ? name + " - " : ""}${
              address ? address + " - " : ""
            }${mapLink}`;
          }

          let itemsInfo = "";
          if (items.length) {
            itemsInfo =
              "\n🛒 Carrito:\n" +
              items
                .map(
                  (p, i) =>
                    `${i + 1}) ${p.name} x${p.quantity}${
                      p.price ? ` — RD$${p.price}` : ""
                    }`
                )
                .join("\n");
          }

          const adminMsg = `📦 NUEVO PEDIDO - Glowny Essentials
Cliente: ${customerName || "Sin nombre"} (${userPhone})
Fuente: Catálogo Meta
${itemsInfo}
${locationInfo}`;

          await sendWhatsAppText(ADMIN_PHONE, adminMsg);
        }

        // Reset sesión (se mantiene limpio)
        session.state = "INIT";
        session.order = {};
        session.history = [];
        session.product = null;
        session.sentImage = false;
        session.listCandidates = null;

        await setSession(userPhone, session);
        return;
      }

      // Si mandan ubicación sin carrito
      await sendWhatsAppText(
        userPhone,
        "Recibí tu ubicación 😊📍\nAhora elige tus productos desde el catálogo 🛍️ y envíame el carrito para finalizar 💗"
      );

      await setSession(userPhone, session);
      return;
    }

    // =============================
    // ✅ TODO LO DEMÁS LO DEJAMOS VIVO PERO SIN USAR (comentado para luego)
    // =============================

    /*
    // AUDIO - (comentado por ahora)
    if (msgType === "audio") {
      const mediaId = msg.audio?.id;
      // ... aquí iría whisper / openai
    }

    // LÓGICA OPENAI / PRODUCTOS - (comentado por ahora)
    // findProductForMessage()
    // searchProductsByKeyword()
    // callOpenAI()
    */

    await setSession(userPhone, session);
    return;
  } catch (err) {
    console.error("❌ Error procesando inbound:", err?.response?.data || err);
  }
}

// =============================
// ✅ WEBHOOK MAIN (ACK inmediato)
// =============================
app.post("/webhook", (req, res) => {
  // ✅ Respondemos rápido para evitar reintentos/duplicados
  res.sendStatus(200);

  // ✅ Procesamos en background
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
  console.log(
    `🛍 WHATSAPP_CATALOG_URL = ${
      WHATSAPP_CATALOG_URL ? "SET ✅" : "NOT SET (instrucciones) ⚠️"
    }`
  );
});
