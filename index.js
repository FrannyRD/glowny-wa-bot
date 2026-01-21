const express = require("express");
const fs = require("fs");
const path = require("path");

const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json());

// =============================
// ENV
// =============================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "glowny_verify";
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const ADMIN_PHONE = process.env.ADMIN_PHONE || "18492010239";

const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-nano";
const MEMORY_TTL_SECONDS = 60 * 60 * 24;
const MAX_HISTORY_MESSAGES = 10;

// =============================
// CATALOGO (catalog.json)
// =============================
let PRODUCTS = [];
let productIndex = [];
let CATALOG_OK = false;

function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function loadCatalogFromFile() {
  const filePath = path.join(__dirname, "catalog.json");

  if (!fs.existsSync(filePath)) {
    console.log("❌ catalog.json NO existe en el deploy:", filePath);
    return [];
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);

  if (!Array.isArray(data) || data.length === 0) {
    console.log("❌ catalog.json invalido o vacio");
    return [];
  }

  console.log(`✅ Catálogo cargado desde catalog.json (${data.length} productos)`);
  return data;
}

function buildIndex() {
  productIndex = PRODUCTS.map((p) => {
    const normName = normalizeText(p.name);
    const words = normName.split(" ").filter(Boolean);
    return {
      ...p,
      normName,
      wordSet: new Set(words),
    };
  });
}

function loadCatalog() {
  PRODUCTS = loadCatalogFromFile();
  CATALOG_OK = PRODUCTS.length > 3;

  if (!CATALOG_OK) {
    PRODUCTS = [];
    console.log("⚠️ Catálogo NO cargado. Se bloqueará el modo AI.");
    return;
  }

  buildIndex();
}
loadCatalog();

// =============================
// UPSTASH REDIS
// =============================
async function redisGet(key) {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) return null;

  const url = `${UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
  });
  const data = await res.json();
  if (!res.ok) return null;
  if (!data?.result) return null;

  try {
    return JSON.parse(data.result);
  } catch {
    return data.result;
  }
}

async function redisSet(key, value, ttlSeconds = MEMORY_TTL_SECONDS) {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) return;

  const payload = typeof value === "string" ? value : JSON.stringify(value);

  const url = `${UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(
    key
  )}/${encodeURIComponent(payload)}?EX=${ttlSeconds}`;

  await fetch(url, {
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
  });
}

async function redisDel(key) {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) return;
  const url = `${UPSTASH_REDIS_REST_URL}/del/${encodeURIComponent(key)}`;
  await fetch(url, {
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
  });
}

const K = {
  mem: (wa) => `glowny:mem:${wa}`,
  state: (wa) => `glowny:state:${wa}`,
  lastprod: (wa) => `glowny:lastprod:${wa}`,
  lock: (wa) => `glowny:lock:${wa}`,
};

// =============================
// PRODUCT MATCHING
// =============================
function findProducts(query) {
  if (!CATALOG_OK) return [];

  const q = normalizeText(query);
  if (!q) return [];

  const qWords = q.split(" ").filter(Boolean);
  if (!qWords.length) return [];

  const scored = productIndex
    .map((p) => {
      let score = 0;

      if (p.normName.includes(q)) score += 10;

      const hits = qWords.filter((w) => p.wordSet.has(w)).length;
      score += hits;

      return { p, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 3).map((x) => x.p);
}

function getProductById(id) {
  if (!CATALOG_OK) return null;
  return PRODUCTS.find((p) => p.id === id) || null;
}

function money(n) {
  return `RD$${Number(n || 0).toLocaleString("en-US")}`;
}

function listSimilarProducts(prod, limit = 4) {
  if (!prod) return [];
  const cat = normalizeText(prod.category || "");
  if (!cat) return [];
  return PRODUCTS.filter((p) => normalizeText(p.category || "") === cat && p.id !== prod.id).slice(0, limit);
}

// =============================
// INTENTS
// =============================
function isConfirmYes(text) {
  const q = normalizeText(text);
  return (
    q === "si" ||
    q === "sí" ||
    q.includes("claro") ||
    q.includes("dale") ||
    q.includes("ok") ||
    q.includes("perfecto") ||
    q.includes("confirmo") ||
    q.includes("confirmar") ||
    q.includes("confirmación")
  );
}

// ✅ NUEVO: intención de compra aunque no diga "PEDIR"
function isPurchaseIntent(text) {
  const q = normalizeText(text);
  return (
    q === "pedir" ||
    q.includes("quiero pedir") ||
    q.includes("hacer el pedido") ||
    q.includes("realizar el pedido") ||
    q.includes("confirmar el pedido") ||
    q.includes("confirmo el pedido") ||
    q.includes("ordenar") ||
    q.includes("reservar") ||
    q.includes("lo quiero") ||
    q.includes("quiero ese") ||
    q.includes("quiero esa") ||
    q.includes("me lo llevo") ||
    q.includes("me la llevo") ||
    q.includes("lo deseo") ||
    q.includes("quiero comprar") ||
    q.includes("comprarlo") ||
    q.includes("comprarla")
  );
}

function isOrderIntent(text) {
  // Mantengo tu función pero ahora incluye purchase intent
  return isPurchaseIntent(text);
}

function extractQty(text) {
  const q = normalizeText(text);
  const m = q.match(/\b(\d{1,2})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  if (Number.isFinite(n) && n > 0) return n;
  return null;
}

function extractPayment(text) {
  const q = normalizeText(text);
  if (q.includes("contra entrega") || q.includes("efectivo")) return "Contra entrega";
  if (q.includes("transfer")) return "Transferencia";
  return null;
}

function isAskingForImage(text) {
  const q = normalizeText(text);
  return q.includes("foto") || q.includes("imagen") || q.includes("muestrame") || q.includes("mostrar") || q.includes("ver");
}

function isGreeting(text) {
  const q = normalizeText(text);
  return q === "hola" || q === "buenas" || q.includes("buenos dias") || q.includes("buenas noches");
}

function isProductInfoQuestion(text) {
  const q = normalizeText(text);
  return (
    q.includes("como se usa") ||
    q.includes("cómo se usa") ||
    q.includes("como usar") ||
    q.includes("como aplicar") ||
    q.includes("cuanto dura") ||
    q.includes("cuánto dura") ||
    q.includes("cuanto rinde") ||
    q.includes("cuánto rinde") ||
    q.includes("porciones") ||
    q.includes("dosis") ||
    q.includes("scoop") ||
    q.includes("cada cuanto") ||
    q.includes("cada cuánto") ||
    q.includes("que es") ||
    q.includes("qué es") ||
    q.includes("para que sirve") ||
    q.includes("para qué sirve") ||
    q.includes("beneficios") ||
    q.includes("ingredientes") ||
    q.includes("tamaño") ||
    q.includes("tamano") ||
    q.includes("ml") ||
    q.includes("gramos") ||
    q.includes("g ") ||
    // ✅ NUEVO
    q.includes("cuanto trae") ||
    q.includes("cuánto trae") ||
    q.includes("presentacion") ||
    q.includes("presentación")
  );
}

// =============================
// RESPUESTA DESDE CATALOGO (SIN INVENTAR)
// =============================
function pickProductField(prod, keys = []) {
  for (const k of keys) {
    if (prod && prod[k] && String(prod[k]).trim().length > 0) {
      return String(prod[k]).trim();
    }
  }
  return null;
}

function answerFromCatalog(prod, userText) {
  if (!prod) return null;
  const q = normalizeText(userText);

  // ✅ Tamaño / presentación / cuánto trae
  if (
    q.includes("tamano") ||
    q.includes("tamaño") ||
    q.includes("ml") ||
    q.includes("gramos") ||
    q.includes("g ") ||
    q.includes("cuanto trae") ||
    q.includes("cuánto trae") ||
    q.includes("presentacion") ||
    q.includes("presentación")
  ) {
    const size = pickProductField(prod, ["size", "presentation", "weight"]);
    if (size) {
      return `📦 Presentación: ${size}\n🛒 Si deseas pedirlo, responde: PEDIR`;
    }
    const nm = prod.name || "";
    const m = nm.match(/(\d+)\s?(g|ml)/i);
    if (m) {
      return `📦 Presentación: ${m[1]}${m[2].toLowerCase()}\n🛒 Si deseas pedirlo, responde: PEDIR`;
    }
    return null;
  }

  // ✅ COMO SE USA
  if (q.includes("como se usa") || q.includes("cómo se usa") || q.includes("como usar") || q.includes("como aplicar")) {
    const how = pickProductField(prod, ["how_to_use", "usage", "recommended_use"]);
    if (how) {
      return `✨ Cómo se usa:\n${how}\n\n🛒 Si deseas pedirlo, responde: PEDIR`;
    }
    return null;
  }

  // ✅ CUANTO DURA / RINDE
  if (q.includes("cuanto dura") || q.includes("cuánto dura") || q.includes("cuanto rinde") || q.includes("cuánto rinde")) {
    const dur = pickProductField(prod, ["duration_text"]);
    if (dur) {
      return `⏳ Duración aproximada:\n${dur}\n\n🛒 Si deseas pedirlo, responde: PEDIR`;
    }
    return null;
  }

  // ✅ INGREDIENTES
  if (q.includes("ingredientes")) {
    const ing = pickProductField(prod, ["ingredients"]);
    if (ing) {
      return `🧾 Ingredientes:\n${ing}\n\n🛒 Si deseas pedirlo, responde: PEDIR`;
    }
    return null;
  }

  // ✅ QUE ES / PARA QUE SIRVE
  if (q.includes("que es") || q.includes("qué es") || q.includes("para que sirve") || q.includes("para qué sirve") || q.includes("beneficios")) {
    const desc = pickProductField(prod, ["description", "benefits"]);
    if (desc) {
      return `✨ Sobre el producto:\n${desc}\n\n🛒 Si deseas pedirlo, responde: PEDIR`;
    }
    return null;
  }

  // ✅ PRECAUCIONES
  if (q.includes("precaucion") || q.includes("precauciones") || q.includes("embarazada") || q.includes("alergia")) {
    const warn = pickProductField(prod, ["warnings"]);
    if (warn) {
      return `⚠️ Precauciones:\n${warn}\n\n🛒 Si deseas pedirlo, responde: PEDIR`;
    }
    return null;
  }

  return null;
}

// =============================
// META ADS / REFERRAL DETECTION
// =============================
function extractAdTextFromMessage(message) {
  const ref = message?.referral || message?.context?.referral;
  if (!ref) return "";

  const parts = [];
  if (ref.headline) parts.push(ref.headline);
  if (ref.body) parts.push(ref.body);
  if (ref.source_url) parts.push(ref.source_url);
  if (ref.product_description) parts.push(ref.product_description);
  return parts.filter(Boolean).join(" ");
}

// =============================
// OPENAI
// =============================
function getSystemPrompt() {
  return `
Eres una asistente de ventas por WhatsApp de "Glowny Essentials" en República Dominicana.

ESTILO:
- Responde claro, femenino suave, corto (2 a 6 líneas).
- NO uses “mi amor”.
- Emojis suaves: ✨😊💗🛒📍💳⏳🥄⚠️

REGLAS OBLIGATORIAS:
- Nunca inventes información del producto.
- Si no tienes un dato EXACTO, di: "No tengo ese dato exacto ahora mismo ✅".
- Puedes dar una guía GENERAL sin inventar, y recomendar verificar la etiqueta.
- Si el usuario pregunta cómo se usa / cuánto dura / porciones / dosis:
  1) responde lo mejor posible SIN inventar
  2) si falta un dato, haz 1 pregunta corta para ayudar
  3) SIEMPRE termina con: "🛒 Si deseas pedirlo, responde: PEDIR"

PROHIBIDO:
- Decir "contacta al equipo", "visita la web", "soporte".
- Preguntar otra vez “¿a qué producto te refieres?” si ya hay un producto seleccionado.
`;
}

async function callOpenAI({ history, userText, prod }) {
  if (!OPENAI_API_KEY) {
    return "✨ ¿Qué producto deseas? Escríbeme el nombre y te ayudo 😊";
  }

  const safeProd = prod
    ? {
        id: prod.id,
        name: prod.name,
        price: prod.price,
        category: prod.category || "",
        description: prod.description || "",
        how_to_use: prod.how_to_use || "",
        duration_text: prod.duration_text || "",
        warnings: prod.warnings || "",
        ingredients: prod.ingredients || "",
        type: prod.type || "",
      }
    : null;

  const contextMsg = safeProd
    ? `Producto actual del cliente (NO inventar, solo usar esto):
${JSON.stringify(safeProd, null, 2)}`
    : "";

  const messages = [
    { role: "system", content: getSystemPrompt() },
    ...(Array.isArray(history) ? history.slice(-MAX_HISTORY_MESSAGES) : []),
    ...(contextMsg ? [{ role: "system", content: contextMsg }] : []),
    { role: "user", content: userText },
  ];

  const payload = {
    model: MODEL,
    messages,
    temperature: 0.2,
    max_tokens: 220,
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    const code = data?.error?.code || "";
    if (code === "rate_limit_exceeded") {
      return "🙏 Dame 5 segunditos y me lo repites porfa.";
    }
    return "😥 Ahora mismo tuve un inconveniente, ¿me lo repites por favor?";
  }

  const out = data.choices?.[0]?.message?.content?.trim();
  return out || "✨ ¿Qué producto deseas? Escríbeme el nombre y te ayudo 😊";
}

// =============================
// WHATSAPP SENDERS
// =============================
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };

  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WA_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
}

async function sendWhatsAppImage(to, imageUrl, caption = "") {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { link: imageUrl, caption },
  };

  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

// =============================
// HEALTH
// =============================
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    catalog_ok: CATALOG_OK,
    products: PRODUCTS.length,
    model: MODEL,
    has_upstash: !!UPSTASH_REDIS_REST_URL,
  });
});

// =============================
// WEBHOOK VERIFY
// =============================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// =============================
// STATE
// =============================
async function getState(wa) {
  const st = (await redisGet(K.state(wa))) || {};
  return {
    step: st.step || "IDLE", // IDLE | ASK_QTY | ASK_LOCATION | ASK_REFERENCE | ASK_PAYMENT | CONFIRM
    productId: st.productId || null,
    qty: st.qty || 1,
    location: st.location || null,
    reference: st.reference || null,
    payment: st.payment || null,
  };
}

async function setState(wa, st) {
  await redisSet(K.state(wa), st);
}

async function getMemory(wa) {
  const mem = (await redisGet(K.mem(wa))) || [];
  return Array.isArray(mem) ? mem : [];
}

async function saveMemory(wa, history) {
  await redisSet(K.mem(wa), history.slice(-MAX_HISTORY_MESSAGES));
}

// =============================
// MAIN WEBHOOK
// =============================
app.post("/webhook", async (req, res) => {
  const safeEnd = async (lockKey) => {
    try {
      if (lockKey) await redisDel(lockKey);
    } catch {}
    return res.sendStatus(200);
  };

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const from = message.from;
    let userText = "";

    // lock anti doble respuesta
    const lockKey = K.lock(from);
    const lock = await redisGet(lockKey);
    if (lock) return res.sendStatus(200);
    await redisSet(lockKey, "1", 2);

    // Si no hay catálogo
    if (!CATALOG_OK) {
      await sendWhatsAppMessage(
        from,
        "✨ Estamos actualizando el catálogo en este momento 😊\nIntenta de nuevo en 1 minutito 🙏"
      );
      return safeEnd(lockKey);
    }

    const st = await getState(from);

    // =============================
    // 0) Detectar si viene de anuncio (referral)
    // =============================
    const adText = extractAdTextFromMessage(message);
    if (adText) {
      const adMatches = findProducts(adText);
      if (adMatches.length >= 1) {
        const prodFromAd = adMatches[0];
        st.productId = prodFromAd.id;
        await redisSet(K.lastprod(from), prodFromAd.id);
        await setState(from, st);

        await sendWhatsAppMessage(
          from,
          `✨ ¡Gracias por escribirnos! 😊\nVeo que te interesa:\n${prodFromAd.name}\nPrecio: ${money(prodFromAd.price)}\n🛒 Si deseas pedirlo, responde: PEDIR`
        );
        return safeEnd(lockKey);
      }
    }

    // =============================
    // 1) Location message
    // =============================
    if (message.type === "location" && message.location) {
      userText = "📍 Ubicación enviada";

      st.location = {
        lat: message.location.latitude,
        lon: message.location.longitude,
        address: message.location.address || "",
        name: message.location.name || "",
      };

      if (st.step === "ASK_LOCATION") st.step = "ASK_REFERENCE";
      await setState(from, st);

      await sendWhatsAppMessage(from, "📍 Perfecto ✅ Ahora dime una referencia breve (Ej: “cerca del colmado”).");
      return safeEnd(lockKey);
    } else {
      userText = message.text?.body || "";
    }

    const normText = normalizeText(userText);

    // ✅ ARREGLO CLAVE:
    // si el bot está esperando UBICACIÓN y el cliente escribe texto -> NO mandar “escríbeme el nombre”
    if (st.step === "ASK_LOCATION" && message.type !== "location") {
      await sendWhatsAppMessage(
        from,
        "📍 Perfecto 😊\nAhora envíame tu ubicación para completar el pedido.\n📎 Clip > Ubicación > Enviar ubicación actual ✅"
      );
      return safeEnd(lockKey);
    }

    // =============================
    // 2) Saludo
    // =============================
    if (isGreeting(userText) && st.step === "IDLE" && !st.productId) {
      await sendWhatsAppMessage(from, "¡Hola! 😊✨\n¿Qué producto estás buscando hoy? Escríbeme el nombre 💗");
      return safeEnd(lockKey);
    }

    // =============================
    // 3) Detectar producto por texto
    // =============================
    const matches = findProducts(userText);

    if (matches.length === 1) {
      const prod = matches[0];
      st.productId = prod.id;
      await redisSet(K.lastprod(from), prod.id);
      await setState(from, st);

      // Si el user quiere comprar de una vez
      if (isPurchaseIntent(userText)) {
        st.step = "ASK_QTY";
        await setState(from, st);
        await sendWhatsAppMessage(from, `🛒 Perfecto 😊\n${prod.name}\nPrecio: ${money(prod.price)} c/u\n¿Cuántos deseas?`);
        return safeEnd(lockKey);
      }

      if (isAskingForImage(userText) && prod.image) {
        await sendWhatsAppImage(
          from,
          prod.image,
          `${prod.name}\nPrecio: ${money(prod.price)}\n🛒 Si deseas pedirlo, responde: PEDIR`
        );
        return safeEnd(lockKey);
      }

      await sendWhatsAppMessage(from, `💗 ${prod.name}\nPrecio: ${money(prod.price)}\n🛒 Si deseas pedirlo, responde: PEDIR`);
      return safeEnd(lockKey);
    }

    // =============================
    // 4) Si el cliente dice PEDIR / Lo quiero y ya hay producto
    // =============================
    if (st.productId && isPurchaseIntent(userText) && st.step === "IDLE") {
      st.step = "ASK_QTY";
      await setState(from, st);
      await sendWhatsAppMessage(from, "🛒 Perfecto 😊 ¿Cuántos deseas?");
      return safeEnd(lockKey);
    }

    // =============================
    // 5) Preguntas de info con producto seleccionado
    // =============================
    if (st.productId && isProductInfoQuestion(userText)) {
      const prod = getProductById(st.productId);

      const direct = answerFromCatalog(prod, userText);
      if (direct) {
        await sendWhatsAppMessage(from, direct);
        return safeEnd(lockKey);
      }

      const history = await getMemory(from);
      const ai = await callOpenAI({ history, userText, prod });

      const newHistory = [
        ...history,
        { role: "user", content: userText },
        { role: "assistant", content: ai },
      ];
      await saveMemory(from, newHistory);

      await sendWhatsAppMessage(from, ai);
      return safeEnd(lockKey);
    }

    // =============================
    // 6) Flujo ASK_QTY
    // =============================
    if (st.step === "ASK_QTY") {
      const qty = extractQty(userText) || (isConfirmYes(userText) ? 1 : null);

      if (!qty) {
        await sendWhatsAppMessage(from, "¿Cuántos deseas? 😊 (Ej: 1, 2, 3)");
        return safeEnd(lockKey);
      }

      st.qty = qty;
      st.step = "ASK_LOCATION";
      await setState(from, st);

      await sendWhatsAppMessage(
        from,
        "✅ Listo\nAhora envíame tu ubicación 📍\n📎 (clip) > Ubicación > Enviar ubicación actual"
      );
      return safeEnd(lockKey);
    }

    // =============================
    // 7) Referencia
    // =============================
    if (st.step === "ASK_REFERENCE") {
      const ref = userText.trim();

      if (!ref || normalizeText(ref) === "ubicacion enviada") {
        await sendWhatsAppMessage(from, "Dime una referencia breve 😊 (Ej: cerca del colmado)");
        return safeEnd(lockKey);
      }

      st.reference = ref;
      st.step = "ASK_PAYMENT";
      await setState(from, st);

      await sendWhatsAppMessage(from, "💳 ¿El pago será contra entrega o transferencia? 😊");
      return safeEnd(lockKey);
    }

    // =============================
    // 8) Pago
    // =============================
    if (st.step === "ASK_PAYMENT") {
      const pay = extractPayment(userText);

      if (!pay) {
        await sendWhatsAppMessage(from, "💳 ¿Contra entrega o transferencia? 😊");
        return safeEnd(lockKey);
      }

      st.payment = pay;
      st.step = "CONFIRM";
      await setState(from, st);

      const prod = getProductById(st.productId);
      const total = prod.price * st.qty;

      await sendWhatsAppMessage(
        from,
        `✅ Perfecto\n🛒 Tu pedido:\n• ${st.qty}x ${prod.name}\n💰 Total: ${money(total)}\n¿Confirmas para procesarlo? 😊`
      );
      return safeEnd(lockKey);
    }

    // =============================
    // 9) Confirmar
    // =============================
    if (st.step === "CONFIRM" && isConfirmYes(userText)) {
      const prod = getProductById(st.productId);
      const total = prod.price * st.qty;

      await sendWhatsAppMessage(from, "✅ Pedido confirmado 💗\nEn breve te lo coordinamos 😊");

      let adminText = `📦 NUEVO PEDIDO CONFIRMADO - Glowny Essentials\n\n`;
      adminText += `🛒 ${st.qty}x ${prod.name} — ${money(prod.price)}\n`;
      adminText += `💰 Total: ${money(total)}\n`;
      adminText += `💳 Pago: ${st.payment}\n`;
      adminText += `📍 Referencia: ${st.reference || "No indicada"}\n`;
      adminText += `WhatsApp: ${from}\nhttps://wa.me/${from}\n`;

      if (st.location?.lat && st.location?.lon) {
        adminText += `\n📍 Ubicación:\nhttps://www.google.com/maps?q=${st.location.lat},${st.location.lon}\n`;
      }

      await sendWhatsAppMessage(ADMIN_PHONE, adminText);

      await redisDel(K.state(from));
      return safeEnd(lockKey);
    }

    // =============================
    // 10) Si hay varias coincidencias
    // =============================
    if (matches.length > 1) {
      const list = matches.map((p) => `• ${p.name} — ${money(p.price)}`).join("\n");
      await sendWhatsAppMessage(from, `✨ Encontré estas opciones:\n${list}\n\nEscríbeme el nombre exacto del que deseas 💗`);
      return safeEnd(lockKey);
    }

    // =============================
    // 11) Respuesta por defecto
    // =============================
    await sendWhatsAppMessage(from, "✨ Escríbeme el nombre del producto y te digo precio 😊💗");
    return safeEnd(lockKey);
  } catch (err) {
    console.error("❌ Error webhook:", err);
    return res.sendStatus(200);
  }
});

// =============================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Bot corriendo en puerto ${PORT}`);
});
