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

// ✅ CHATWOOT (Opción 2 - Inbox)
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CHATWOOT_INBOX_ID = process.env.CHATWOOT_INBOX_ID;
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN;

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
  if (d.length === 10) return `+1${d}`; // 809XXXXXXX -> +1809XXXXXXX
  if (d.length === 11 && d.startsWith("1")) return `+${d}`; // 1809XXXXXXX -> +1809XXXXXXX

  // fallback por si llega diferente
  return `+${d}`;
}

const ADMIN_PHONE = onlyDigits(ADMIN_PHONE_RAW);

// Cargar catálogo
const catalog = require("./catalog.json");

// Normalizar texto
function normalizeText(text) {
  let normalized = (text || "").toLowerCase();
  normalized = normalized.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  normalized = normalized.replace(/[^\w\s]/g, " ");
  normalized = normalized.trim().replace(/\s+/g, " ");
  return normalized;
}

// Stopwords
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

// Index del catálogo (más fuerte)
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

// ✅ Buscar 1 mejor producto (compatibilidad con tu lógica)
function findProductForMessage(message) {
  const msgNorm = normalizeText(message);

  const msgWords = new Set(
    msgNorm
      .split(" ")
      .filter((w) => w && !SPANISH_STOPWORDS.has(w) && !BRAND_WORDS.has(w))
  );

  let bestMatch = null;
  let bestScore = 0;

  for (const item of productIndex) {
    const commonWordsCount = [...msgWords].filter((w) =>
      item.keywords.has(w)
    ).length;

    // ✅ bonus si el texto contiene parte del nombre
    const partialBonus = item.nameNorm.includes(msgNorm) ? 2 : 0;
    const score = commonWordsCount + partialBonus;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = item;
    }
  }

  if (bestScore === 0) return null;
  return bestMatch;
}

// ✅ Buscar MUCHOS productos por palabra (ALOE, REPARA, EXFOLIANTE, etc.)
function searchProductsByKeyword(message) {
  const msgNorm = normalizeText(message);
  const tokens = msgNorm
    .split(" ")
    .filter((w) => w && !SPANISH_STOPWORDS.has(w) && !BRAND_WORDS.has(w));

  if (tokens.length === 0) return [];

  // Usamos el último token “importante” como keyword principal
  const mainKeyword = tokens[tokens.length - 1];

  // Match: contiene palabra completa o parte del nombre
  const matches = productIndex
    .map((item) => {
      let score = 0;

      // score por tokens
      for (const t of tokens) {
        if (item.nameNorm.includes(t)) score += 2;
        if (item.keywords.has(t)) score += 2;
      }

      // score extra si contiene keyword principal
      if (item.nameNorm.includes(mainKeyword)) score += 3;

      return { item, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);

  // quitar duplicados por id
  const seen = new Set();
  const unique = [];
  for (const m of matches) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      unique.push(m);
    }
  }
  return unique;
}

// ✅ Detecta si el usuario está pidiendo lista
function isListRequest(userText) {
  const t = normalizeText(userText);
  const listTriggers = [
    "dime todos",
    "dime todas",
    "cuales tienes",
    "cuáles tienes",
    "cuales hay",
    "cuáles hay",
    "lista",
    "muestrame",
    "muéstrame",
    "que tienes",
    "qué tienes",
    "todos los",
    "todas las",
    "productos con",
    "tienes de",
  ];

  // ⚠️ NO confundir con “cómo se usa”
  if (t.includes("como se usa") || t.includes("cómo se usa")) return false;

  return listTriggers.some((x) => t.includes(x));
}

// ✅ Formatea lista de productos
function formatProductList(matches, limit = 8) {
  const sliced = matches.slice(0, limit);
  const lines = sliced.map((m, idx) => {
    const price = m.data.price ? ` — RD$${m.data.price}` : "";
    return `${idx + 1}) ${m.data.name}${price}`;
  });

  let msg = `✨ Estos son los productos que tengo disponibles:\n\n${lines.join(
    "\n"
  )}\n\nDime el número o el nombre del producto 😊💗`;

  if (matches.length > limit) {
    msg += `\n\n(Te mostré ${limit} de ${matches.length}. Si quieres más, dime “ver más”).`;
  }
  return msg;
}

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
// WHATSAPP CLOUD API (FIX)
// ✅ SOLUCIÓN: messaging_product: "whatsapp"
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
      {
        messaging_product: "whatsapp",
        ...payload,
      },
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
  await waSend({
    to: onlyDigits(to),
    type: "text",
    text: { body: text },
  });
}

async function sendWhatsAppImage(to, imageUrl, caption = "") {
  await waSend({
    to: onlyDigits(to),
    type: "image",
    image: { link: imageUrl, caption },
  });
}

// =============================
// ✅ CHATWOOT (ARREGLADO)
// Solo replica mensajes para verlos y poder responder.
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

// ✅ Crear/obtener contacto (FIX E164 aquí)
async function cwGetOrCreateContact({ phone, name }) {
  if (!chatwootEnabled()) return null;

  const cleanPhone = onlyDigits(phone);
  const e164Phone = toE164(cleanPhone); // ✅ FIX
  if (!cleanPhone || !e164Phone) return null;

  // 1) Buscar contacto
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

  // 2) Crear contacto
  try {
    const createRes = await axios.post(
      `${cwBase()}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`,
      {
        name: name || cleanPhone,
        phone_number: e164Phone, // ✅ FIX: Chatwoot exige E164
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
    // Si falló por duplicado, intentar buscar otra vez
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

// ✅ Crear conversación y guardarla en sesión
async function cwGetOrCreateConversation({ session, phone, contactId }) {
  if (!chatwootEnabled()) return null;

  if (session?.cw_conversation_id) return session.cw_conversation_id;

  try {
    const convRes = await axios.post(
      `${cwBase()}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
      {
        source_id: onlyDigits(phone), // identificador fijo por cliente
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

// ✅ Enviar mensaje entrante a Chatwoot (para verlo)
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
        message_type: "incoming",
      },
      { headers: chatwootHeaders() }
    );
  } catch (err) {
    const data = err?.response?.data || err?.message || err;

    // ✅ Si el inbox no es API, Chatwoot devuelve este error
    const msg =
      (typeof data === "object" ? JSON.stringify(data) : String(data)) || "";

    if (msg.toLowerCase().includes("only allowed in api inboxes")) {
      console.error(
        "⚠️ Chatwoot: Incoming messages solo permitidos en API inboxes. El bot seguirá normal."
      );
      return;
    }

    console.error("❌ Chatwoot mensaje:", data);
  }
}

// ✅ NO BLOQUEAR EL BOT: manda a chatwoot en background
function safeSendToChatwoot(payload) {
  // 🔥 importantísimo: NO usar await aquí
  sendToChatwoot(payload).catch(() => {});
}

// ✅ Webhook para recibir respuestas del agente (Chatwoot → WhatsApp)
// Cuando respondas manual, el bot se calla 30 min para esa clienta.
app.post("/chatwoot/webhook", async (req, res) => {
  try {
    const event = req.body;

    // ✅ Chatwoot manda message_type como "outgoing" o como 1
    const mt = event?.message_type;
    const isOutgoing = mt === "outgoing" || mt === 1;

    if (!isOutgoing) return res.sendStatus(200);

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

    // ✅ Modo humano por 30 minutos
    session.human_until = Date.now() + 30 * 60 * 1000;

    await setSession(userPhone, session);

    // ✅ Enviar respuesta humana al WhatsApp del cliente
    await sendWhatsAppText(userPhone, content);

    return res.sendStatus(200);
  } catch (e) {
    console.error("❌ Error /chatwoot/webhook:", e?.response?.data || e.message);
    return res.sendStatus(200);
  }
});

// =============================
// OPENAI - Chat
// =============================
async function callOpenAI(session, product, userMessage) {
  const productInfo = product
    ? `
Producto: ${product.name}
Categoría: ${product.category}
Precio: RD$${product.price}
Tipo: ${product.type || ""}
Descripción: ${product.description || ""}
Uso: ${product.how_to_use || ""}
Duración: ${product.duration_text || ""}
Ingredientes: ${product.ingredients || ""}
Advertencias: ${product.warnings || ""}
`
    : "";

  const systemContent = `Eres Glowny, asistente virtual de Glowny Essentials (República Dominicana).
Hablas español con tono cálido, amable, humano y femenino (para señoras mayores).
Responde corto (2 a 6 líneas). Usa 1-3 emojis suaves: ✨😊💗🛒📍⏳🥄

REGLAS:
- NO inventes datos. Solo usa catálogo y contexto.
- Si te falta un dato exacto: "No tengo ese dato exacto ahora mismo ✅".
- Si la clienta quiere comprar, guía con calma.
- Si está confundida, explícale simple.

INFO PRODUCTO:
${productInfo}`;

  const messages = [{ role: "system", content: systemContent }];

  if (session.history && session.history.length >= 1) {
    const last = session.history[session.history.length - 1];
    if (last?.user && last?.assistant) {
      messages.push({ role: "user", content: last.user });
      messages.push({ role: "assistant", content: last.assistant });
    }
  }

  messages.push({ role: "user", content: userMessage });

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4.1-nano",
        messages,
        temperature: 0.5,
        max_tokens: 220,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    return (
      response.data.choices?.[0]?.message?.content?.trim() ||
      "😊 ¿En qué puedo ayudarte?"
    );
  } catch (error) {
    console.error("❌ Error OpenAI:", error?.response?.data || error);
    return "Lo siento 🙏 tuve un error momentáneo. ¿Me lo repites por favor? 😊";
  }
}

// =============================
// OPENAI - Audio (Whisper)
// ✅ para entender notas de voz
// =============================
async function transcribeWhatsAppAudio(mediaId) {
  if (!OPENAI_API_KEY) return null;
  if (!WA_TOKEN) return null;

  try {
    // 1) obtener URL del media
    const mediaInfo = await axios.get(
      `https://graph.facebook.com/v20.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
    );

    const mediaUrl = mediaInfo.data?.url;
    if (!mediaUrl) return null;

    // 2) descargar audio
    const audioRes = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` },
      responseType: "arraybuffer",
    });

    const tmpFile = path.join(os.tmpdir(), `wa-audio-${Date.now()}.ogg`);
    fs.writeFileSync(tmpFile, Buffer.from(audioRes.data));

    // 3) enviar a Whisper
    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("file", fs.createReadStream(tmpFile));

    const trRes = await axios.post(
      "https://api.openai.com/v1/audio/transcriptions",
      form,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          ...form.getHeaders(),
        },
      }
    );

    // limpiar
    try {
      fs.unlinkSync(tmpFile);
    } catch (_) {}

    const text = trRes.data?.text?.trim();
    return text || null;
  } catch (err) {
    console.error("❌ Error transcribiendo audio:", err?.response?.data || err);
    return null;
  }
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
// WEBHOOK MAIN
// =============================
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (body.object !== "whatsapp_business_account") {
      return res.sendStatus(404);
    }

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const messages = value?.messages;
    if (!messages || messages.length === 0) return res.sendStatus(200);

    const msg = messages[0];
    const userPhone = msg.from;
    const msgType = msg.type;

    const customerName = value?.contacts?.[0]?.profile?.name || "";

    let session = (await getSession(userPhone)) || {};
    if (!session.history) session.history = [];
    if (!session.order) session.order = {};
    if (!session.state) session.state = "INIT";
    if (!session.listCandidates) session.listCandidates = null;

    // ✅ Si el modo humano expiró, lo quitamos
    if (session.human_until && Date.now() > session.human_until) {
      session.human_until = null;
    }

    // =============================
    // FUNCIÓN PRINCIPAL DE TEXTO
    // =============================
    async function handleText(userText) {
      const lowText = normalizeText(userText);

      // ✅ Enviar SIEMPRE a Chatwoot en background (NO BLOQUEAR BOT)
      safeSendToChatwoot({
        session,
        from: userPhone,
        name: customerName || userPhone,
        message: userText,
      });

      // ✅ Si hay humano activo, el bot NO responde (solo lo ves en Chatwoot)
      if (session.human_until && Date.now() < session.human_until) {
        await setSession(userPhone, session);
        return;
      }

      // ✅ si dice "otro producto" en cualquier momento, resetea a catálogo
      const wantsOther =
        lowText.includes("otro producto") ||
        lowText === "otro" ||
        lowText.includes("otra cosa") ||
        lowText.includes("quiero otro") ||
        lowText.includes("ver otro");

      if (wantsOther) {
        session.state = "INIT";
        session.product = null;
        session.order = {};
        session.sentImage = false;
        session.listCandidates = null;

        await sendWhatsAppText(
          userPhone,
          "Claro 😊✨\nDime el nombre o una palabra del producto que buscas (Ej: “aloe”, “repara”, “colágeno”, “exfoliante”) 💗"
        );
        await setSession(userPhone, session);
        return;
      }

      // ✅ si el usuario pidió lista (aloe, repara, exfoliante...)
      if (isListRequest(userText) || lowText.split(" ").length <= 2) {
        const matches = searchProductsByKeyword(userText);
        if (matches.length >= 2) {
          session.listCandidates = matches.slice(0, 12).map((x) => x.data);
          session.state = "AWAIT_PRODUCT_SELECTION";

          await sendWhatsAppText(userPhone, formatProductList(matches, 8));
          await setSession(userPhone, session);
          return;
        }
      }

      // ✅ si estamos esperando seleccionar producto de una lista
      if (
        session.state === "AWAIT_PRODUCT_SELECTION" &&
        session.listCandidates
      ) {
        const digit = userText.match(/\d+/);
        if (digit) {
          const idx = parseInt(digit[0], 10) - 1;
          const chosen = session.listCandidates[idx];
          if (chosen) {
            session.product = chosen;
            session.state = "Q&A";
            session.listCandidates = null;

            await sendWhatsAppText(
              userPhone,
              `Perfecto 😊✨\nHablemos de *${chosen.name}* 💗\n¿Quieres comprar o tienes una pregunta? 🛒`
            );
            await setSession(userPhone, session);
            return;
          }
        }

        // si escribió nombre
        const foundByName = findProductForMessage(userText);
        if (foundByName) {
          session.product = foundByName.data;
          session.state = "Q&A";
          session.listCandidates = null;

          await sendWhatsAppText(
            userPhone,
            `Perfecto 😊✨\nHablemos de *${foundByName.data.name}* 💗\n¿Quieres comprar o tienes una pregunta? 🛒`
          );
          await setSession(userPhone, session);
          return;
        }

        await sendWhatsAppText(
          userPhone,
          "Dime el número o el nombre del producto 😊💗\n(Ej: 1, 2, 3 o “loción aloe”)"
        );
        await setSession(userPhone, session);
        return;
      }

      // Detectar intención de compra (más flexible)
      const wantsToBuy =
        lowText.includes("quiero") ||
        lowText.includes("lo quiero") ||
        lowText.includes("pedir") ||
        lowText.includes("comprar") ||
        lowText.includes("me lo llevo") ||
        lowText.includes("ordenar") ||
        lowText.includes("confirmo") ||
        lowText.includes("si");

      // Buscar producto
      let currentProduct = session.product || null;
      const found = findProductForMessage(userText);
      if (found) {
        currentProduct = found.data;
        session.product = currentProduct;
      }

      // Saludo
      if (
        !currentProduct &&
        (lowText === "hola" || lowText.includes("buenas"))
      ) {
        const greetingName = customerName ? ` ${customerName}` : "";
        await sendWhatsAppText(
          userPhone,
          `¡Hola${greetingName}! 😊✨\nCuéntame, ¿qué producto estás buscando hoy? 💗`
        );
        session.state = "INIT";
        await setSession(userPhone, session);
        return;
      }

      // Si no se identifica producto
      if (!currentProduct) {
        const matches = searchProductsByKeyword(userText);
        if (matches.length >= 2) {
          session.listCandidates = matches.slice(0, 12).map((x) => x.data);
          session.state = "AWAIT_PRODUCT_SELECTION";
          await sendWhatsAppText(userPhone, formatProductList(matches, 8));
          await setSession(userPhone, session);
          return;
        }

        await sendWhatsAppText(
          userPhone,
          `Disculpa 😔 no logré identificar el producto.\n¿Me dices una palabra clave? (Ej: “aloe”, “repara”, “colágeno”, “magnesio”, “exfoliante”) 💗`
        );
        session.state = "INIT";
        await setSession(userPhone, session);
        return;
      }

      // Si estábamos esperando cantidad y el usuario manda nombre de otro producto -> cambiar producto
      if (session.state === "AWAIT_QUANTITY") {
        const digitMatch = userText.match(/\d+/);
        if (!digitMatch) {
          const maybeOther = findProductForMessage(userText);
          if (maybeOther && maybeOther.data?.id !== currentProduct.id) {
            session.product = maybeOther.data;
            await sendWhatsAppText(
              userPhone,
              `Perfecto 😊🛒\n¿Cuántas unidades de *${maybeOther.data.name}* deseas?`
            );
            await setSession(userPhone, session);
            return;
          }
        }
      }

      // ✅ Si quiere comprar -> pedir cantidad (si no estamos ya en location)
      if (wantsToBuy && session.state !== "AWAIT_LOCATION") {
        session.state = "AWAIT_QUANTITY";
        await sendWhatsAppText(
          userPhone,
          `Perfecto 😊🛒\n¿Cuántas unidades de *${currentProduct.name}* deseas?`
        );
        await setSession(userPhone, session);
        return;
      }

      // Si estamos esperando cantidad
      if (session.state === "AWAIT_QUANTITY") {
        let quantity = null;
        const digitMatch = userText.match(/\d+/);

        if (digitMatch) quantity = parseInt(digitMatch[0], 10);

        if (!quantity || quantity <= 0) {
          const matches = searchProductsByKeyword(userText);
          if (matches.length >= 2) {
            session.listCandidates = matches.slice(0, 12).map((x) => x.data);
            session.state = "AWAIT_PRODUCT_SELECTION";
            await sendWhatsAppText(userPhone, formatProductList(matches, 8));
            await setSession(userPhone, session);
            return;
          }

          await sendWhatsAppText(
            userPhone,
            "¿Cuántas unidades deseas? 😊\n(Ej: 1, 2, 3)\n\nSi quieres *otro producto*, dime: “otro producto” 💗"
          );
          await setSession(userPhone, session);
          return;
        }

        session.order.quantity = quantity;
        session.state = "AWAIT_LOCATION";

        await sendWhatsAppText(
          userPhone,
          `✅ Anotado: *${quantity}* unidad(es) 😊🛒\nAhora envíame tu ubicación 📍 (clip 📎 > Ubicación > Enviar).`
        );
        await setSession(userPhone, session);
        return;
      }

      // Q&A normal con IA
      const aiReply = await callOpenAI(session, currentProduct, userText);
      await sendWhatsAppText(userPhone, aiReply);

      session.history.push({ user: userText, assistant: aiReply });
      if (session.history.length > 6) session.history.shift();

      // Enviar imagen una vez
      if (!session.sentImage && currentProduct.image) {
        await sendWhatsAppImage(
          userPhone,
          currentProduct.image,
          currentProduct.name
        );
        session.sentImage = true;
      }

      session.state = "Q&A";
      await setSession(userPhone, session);
      return;
    }

    // =============================
    // 1) TEXTO
    // =============================
    if (msgType === "text") {
      const userText = msg.text?.body?.trim() || "";
      await handleText(userText);
      return res.sendStatus(200);
    }

    // =============================
    // 2) AUDIO ✅ (Nota de voz)
    // =============================
    if (msgType === "audio") {
      const mediaId = msg.audio?.id;

      if (!mediaId) {
        const fallback =
          "Recibido 😊✨\nNo pude escuchar bien el audio. ¿Me lo escribes por favor? 💗";

        // ✅ background
        safeSendToChatwoot({
          session,
          from: userPhone,
          name: customerName || userPhone,
          message: "🎤 Nota de voz recibida (no pude leer el mediaId).",
        });

        if (session.human_until && Date.now() < session.human_until) {
          await setSession(userPhone, session);
          return res.sendStatus(200);
        }

        await sendWhatsAppText(userPhone, fallback);
        await setSession(userPhone, session);
        return res.sendStatus(200);
      }

      const transcript = await transcribeWhatsAppAudio(mediaId);

      if (!transcript) {
        const fallback =
          "Recibido 😊✨\nNo pude entender el audio. ¿Me lo escribes por favor? 💗";

        safeSendToChatwoot({
          session,
          from: userPhone,
          name: customerName || userPhone,
          message: "🎤 Nota de voz recibida (no se pudo transcribir).",
        });

        if (session.human_until && Date.now() < session.human_until) {
          await setSession(userPhone, session);
          return res.sendStatus(200);
        }

        await sendWhatsAppText(userPhone, fallback);
        await setSession(userPhone, session);
        return res.sendStatus(200);
      }

      safeSendToChatwoot({
        session,
        from: userPhone,
        name: customerName || userPhone,
        message: `🎤 Nota de voz transcrita: ${transcript}`,
      });

      await handleText(transcript);
      return res.sendStatus(200);
    }

    // =============================
    // 3) LOCATION ✅
    // =============================
    if (msgType === "location") {
      const loc = msg.location;
      if (!loc) return res.sendStatus(200);

      const mapPreview =
        loc.latitude && loc.longitude
          ? `📍 Ubicación enviada: https://maps.google.com/?q=${loc.latitude},${loc.longitude}`
          : "📍 Ubicación enviada";

      safeSendToChatwoot({
        session,
        from: userPhone,
        name: customerName || userPhone,
        message: mapPreview,
      });

      if (session.human_until && Date.now() < session.human_until) {
        await setSession(userPhone, session);
        return res.sendStatus(200);
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
          "Perfecto 🤩 unos de nuestros representantes te estará contactando con los detalles de envíos y pagos."
        );

        if (ADMIN_PHONE) {
          const order = session.order;
          const productName = session.product?.name || "Producto";
          const qty = order.quantity || 1;

          let locationInfo = "";
          if (order.location?.latitude && order.location?.longitude) {
            const { latitude, longitude, address, name } = order.location;
            const mapLink = `https://maps.google.com/?q=${latitude},${longitude}`;
            locationInfo = `📍 Ubicación: ${name ? name + " - " : ""}${
              address ? address + " - " : ""
            }${mapLink}`;
          }

          const adminMsg = `📦 NUEVO PEDIDO - Glowny Essentials
Cliente: ${customerName || "Sin nombre"} (${userPhone})
Producto: ${productName}
Cantidad: ${qty}
${locationInfo}`;

          await sendWhatsAppText(ADMIN_PHONE, adminMsg);
        }

        session.state = "INIT";
        session.order = {};
        session.history = [];
        session.product = null;
        session.sentImage = false;
        session.listCandidates = null;

        await setSession(userPhone, session);
        return res.sendStatus(200);
      }

      await sendWhatsAppText(
        userPhone,
        "Recibí tu ubicación 😊📍\n¿Te ayudo a pedir algún producto? 💗"
      );
      await setSession(userPhone, session);
      return res.sendStatus(200);
    }

    await setSession(userPhone, session);
    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error webhook:", err);
    return res.sendStatus(200);
  }
});

// =============================
// SERVER
// =============================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Bot de Glowny Essentials escuchando en el puerto ${PORT}`);
});
