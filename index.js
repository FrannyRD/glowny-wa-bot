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

// ✅ Webhook Chatwoot -> WhatsApp (si tú respondes manual)
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
    if (!session.order) session.order = {};
    if (!session.state) session.state = "INIT";

    // ✅ pausar bot 30 min cuando el humano responde
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
    if (!session.order) session.order = {};
    if (!session.state) session.state = "INIT";

    // ✅ DEDUPE por msgId
    if (msgId && session.last_wa_msg_id === msgId) return;
    if (msgId) session.last_wa_msg_id = msgId;

    // ✅ si humano está atendiendo, bot pausa
    if (session.human_until && Date.now() < session.human_until) {
      await setSession(userPhone, session);
      return;
    }

    // =============================
    // ✅ 1) TEXTO (CON CUALQUIER PALABRA -> manda saludo con botón catálogo)
    // =============================
    if (msgType === "text") {
      const userText = msg.text?.body?.trim() || "";

      await sendToChatwoot({
        session,
        from: userPhone,
        name: customerName || userPhone,
        message: userText,
      });

      // ✅ modo manual: no responder
      if (MANUAL_MODE) {
        await setSession(userPhone, session);
        return;
      }

      // ✅ Si el cliente ya tiene un carrito y estamos esperando ubicación,
      // NO mandamos bienvenida para no confundir.
      // Aquí solo recordamos que envíe la ubicación.
      if (session.state === "AWAIT_LOCATION") {
        await sendWhatsAppText(
          userPhone,
          "Perfecto 😊📍\nPara finalizar tu pedido, envíame tu ubicación (clip 📎 > Ubicación > Enviar) 💗"
        );
        await setSession(userPhone, session);
        return;
      }

      // ✅ ANTI-DUPLICADO: no repetir bienvenida cada 2 segundos
      const last = session.last_welcome_ts || 0;
      if (Date.now() - last < 15000) {
        await setSession(userPhone, session);
        return;
      }
      session.last_welcome_ts = Date.now();

      const greetingName = customerName ? ` ${customerName}` : "";
      const welcomeText =
        `¡Hola${greetingName}! 😊✨\n` +
        `Bienvenida a Glowny Essentials 💗\n\n` +
        `🛍️ Puedes hacer tu pedido fácil desde nuestro *Catálogo de WhatsApp*.\n` +
        `✅ Selecciona tus productos y cuando termines tu carrito,\n` +
        `envíame tu *ubicación* 📍 para finalizar 💗`;

      // ✅ botón real que abre el catálogo (CTA URL)
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
        message: "BOT: Bienvenida enviada (cualquier texto) con CTA URL.",
      });

      await setSession(userPhone, session);
      return;
    }

    // =============================
    // ✅ 2) META CATALOG - ORDER (Recibir carrito + pedir ubicación)
    // =============================
    if (msgType === "order") {
      const order = msg.order;
      const items = order?.product_items || [];

      await sendToChatwoot({
        session,
        from: userPhone,
        name: customerName || userPhone,
        message: `🛒 Carrito recibido (Meta Catalog) - ${items.length} item(s)`,
      });

      if (MANUAL_MODE) {
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

      // ✅ pedir ubicación SOLO aquí
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
        message: "BOT: Carrito recibido + pedí ubicación.",
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

          await sendWhatsAppText(ADMIN_PHONE, adminMsg);
        }

        // reset
        session.state = "INIT";
        session.order = {};

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

    await setSession(userPhone, session);
  } catch (err) {
    console.error("❌ Error procesando inbound:", err?.response?.data || err);
  }
}

// =============================
// ✅ WEBHOOK MAIN (ACK inmediato)
// =============================
app.post("/webhook", (req, res) => {
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
});
