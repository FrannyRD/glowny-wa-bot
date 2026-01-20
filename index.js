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
const MEMORY_TTL_SECONDS = 60 * 60 * 24; // 24h
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
    console.log("❌ catalog.json inválido o vacío");
    return [];
  }

  console.log(`✅ Catálogo cargado desde catalog.json (${data.length} productos)`);
  return data;
}

function buildIndex() {
  productIndex = PRODUCTS.map((p) => {
    const normName = normalizeText(p.name);
    const words = normName.split(" ").filter(Boolean);
    const extra = [
      p.category,
      p.brand,
      p.tags ? (Array.isArray(p.tags) ? p.tags.join(" ") : String(p.tags)) : "",
      p.description || "",
    ]
      .join(" ")
      .trim();

    const normExtra = normalizeText(extra);

    return {
      ...p,
      normName,
      normExtra,
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
  lastReply: (wa) => `glowny:lastReply:${wa}`, // para evitar repetir exacto
};

// =============================
// UTIL
// =============================
function money(n) {
  return `RD$${Number(n || 0).toLocaleString("en-US")}`;
}

function safeStr(x) {
  if (!x) return "";
  return String(x);
}

// =============================
// PRODUCT MATCHING (CATALOGO)
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

      // match directo por nombre
      if (p.normName.includes(q)) score += 12;

      // match por extra (categoría/tags/descripcion)
      if (p.normExtra && p.normExtra.includes(q)) score += 4;

      // hits por palabras
      const hits = qWords.filter((w) => p.wordSet.has(w)).length;
      score += hits;

      // penaliza queries muy cortas si no hay hits reales
      if (qWords.length === 1 && hits === 0 && !p.normName.includes(q)) {
        score -= 2;
      }

      return { p, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 5).map((x) => x.p);
}

function getProductById(id) {
  if (!CATALOG_OK) return null;
  return PRODUCTS.find((p) => p.id === id) || null;
}

function listSimilarProducts(prod, limit = 5) {
  if (!CATALOG_OK || !prod) return [];
  const cat = normalizeText(prod.category || "");
  if (!cat) return [];

  const sameCat = PRODUCTS.filter(
    (x) => normalizeText(x.category || "") === cat && x.id !== prod.id
  );

  return sameCat.slice(0, limit);
}

// =============================
// INTENTS / EXTRACTORS
// =============================
function isConfirmYes(text) {
  const q = normalizeText(text);
  return (
    q === "si" ||
    q === "sí" ||
    q === "sii" ||
    q.includes("claro") ||
    q.includes("dale") ||
    q.includes("ok") ||
    q.includes("perfecto") ||
    q.includes("confirmo") ||
    q.includes("confirmar") ||
    q.includes("de acuerdo") ||
    q.includes("listo")
  );
}

function isCancel(text) {
  const q = normalizeText(text);
  return q.includes("no") || q.includes("cancel") || q.includes("luego");
}

function isOrderIntent(text) {
  const q = normalizeText(text);
  return (
    q.includes("quiero pedir") ||
    q.includes("hacer el pedido") ||
    q.includes("realizar el pedido") ||
    q.includes("confirmar el pedido") ||
    q.includes("confirmo el pedido") ||
    q.includes("ordenar") ||
    q.includes("reservar") ||
    q === "pedir" ||
    q === "pedido"
  );
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
  return q.includes("foto") || q.includes("imagen") || q.includes("muestrame") || q.includes("ver");
}

// Preguntas “raras”/frecuentes que deberían responderse sin perder el pedido
function isProductInfoQuestion(text) {
  const q = normalizeText(text);
  return (
    q.includes("como se usa") ||
    q.includes("cómo se usa") ||
    q.includes("como usar") ||
    q.includes("cuanto dura") ||
    q.includes("cuánto dura") ||
    q.includes("cuanto rinde") ||
    q.includes("cuánto rinde") ||
    q.includes("que es") ||
    q.includes("qué es") ||
    q.includes("para que sirve") ||
    q.includes("para qué sirve") ||
    q.includes("tamaño") ||
    q.includes("tamano") ||
    q.includes("gramos") ||
    q.includes("ml") ||
    q.includes("scoop") ||
    q.includes("porciones") ||
    q.includes("dosis") ||
    q.includes("beneficios") ||
    q.includes("ingredientes") ||
    q.includes("sirve para") ||
    q.includes("es bueno para") ||
    q.includes("como aplicar") ||
    q.includes("cada cuanto") ||
    q.includes("cada cuánto") ||
    q.includes("piel") ||
    q.includes("rostro") ||
    q.includes("cara") ||
    q.includes("cuerpo")
  );
}

function parseSizeFromName(name) {
  const n = (name || "").toLowerCase();
  const m = n.match(/(\d+)\s?(g|gr|ml|capsulas|cápsulas|tabletas|tabs)/i);
  if (!m) return null;
  return { value: Number(m[1]), unit: m[2].toLowerCase() };
}

function isSupplementProduct(prodName = "") {
  const n = normalizeText(prodName);
  return (
    n.includes("colageno") ||
    n.includes("colágeno") ||
    n.includes("magnesio") ||
    n.includes("vitamina") ||
    n.includes("omega") ||
    n.includes("suplemento") ||
    n.includes("capsulas") ||
    n.includes("cápsulas")
  );
}

// Respuesta “rápida” sin IA (pero útil) cuando ya sabemos el producto
function buildQuickProductInfoAnswer(prod, userText) {
  const q = normalizeText(userText);
  const size = parseSizeFromName(prod?.name || "");
  const isSupp = isSupplementProduct(prod?.name || "");

  const continueText = "✨ Si deseas pedirlo, responde: PEDIR";

  // Tamaño/presentación
  if (q.includes("tamaño") || q.includes("tamano") || q.includes("gramos") || q.includes("ml")) {
    if (size?.value && size?.unit) {
      return `📦 Presentación: ${size.value} ${size.unit}\n💰 Precio: ${money(prod.price)}\n${continueText}`;
    }
    return `📦 Te confirmo la presentación al momento 😊\n💰 Precio: ${money(prod.price)}\n${continueText}`;
  }

  // Cómo se usa
  if (q.includes("como se usa") || q.includes("cómo se usa") || q.includes("como usar") || q.includes("como aplicar")) {
    if (isSupp) {
      return `🥤 Se suele disolver en agua o jugo.\n📌 Tip: 1 porción al día (según la etiqueta).\n${continueText}`;
    }
    return `🧴 Úsalo sobre piel limpia y seca.\n✨ Aplica una pequeña cantidad y masajea hasta absorber.\n${continueText}`;
  }

  // Duración / rinde
  if (q.includes("cuanto dura") || q.includes("cuánto dura") || q.includes("cuanto rinde") || q.includes("cuánto rinde")) {
    if (isSupp && size?.unit === "g" && size?.value) {
      const servings = Math.max(10, Math.round(size.value / 10));
      return `⏳ Aprox rinde ${servings} porciones.\n📆 Usando 1 al día puede durar cerca de ${Math.max(2, Math.round(servings / 7))}–${Math.max(
        3,
        Math.round(servings / 5)
      )} semanas.\n${continueText}`;
    }
    return `⏳ Depende del uso, pero generalmente rinde varias semanas 😊\n${continueText}`;
  }

  // Qué es / para qué sirve
  if (q.includes("que es") || q.includes("qué es") || q.includes("para que sirve") || q.includes("para qué sirve") || q.includes("beneficios")) {
    if (isSupp) {
      return `✨ Es un suplemento de apoyo al bienestar (según su uso y etiqueta).\n📌 Te puedo compartir cómo tomarlo y el precio.\n${continueText}`;
    }
    return `✨ Es un producto de cuidado personal para tu rutina.\n📌 Te comparto precio y cómo usarlo.\n${continueText}`;
  }

  // Scoop / dosis
  if (q.includes("scoop") || q.includes("dosis") || q.includes("porciones") || q.includes("cada cuanto") || q.includes("cada cuánto")) {
    return `🥄 Normalmente se usa 1 porción al día (según la etiqueta).\n${continueText}`;
  }

  // Fallback
  return `Perfecto 😊\n💰 Precio: ${money(prod.price)}\n${continueText}`;
}

// =============================
// META ADS REFERRAL (PRODUCT FROM AD)
// =============================
function extractReferralText(message) {
  // WhatsApp Cloud API: message.referral { headline, body, source_type, ... }
  const ref = message?.referral;
  if (!ref) return "";

  const headline = safeStr(ref.headline);
  const body = safeStr(ref.body);
  const sourceId = safeStr(ref.source_id);
  const sourceType = safeStr(ref.source_type);

  const combo = [headline, body, sourceId, sourceType].filter(Boolean).join(" ");
  return combo.trim();
}

// =============================
// OPENAI (para preguntas raras y soporte)
// =============================
function getSystemPrompt() {
  return `
Eres una asistente de ventas por WhatsApp de "Glowny Essentials" en República Dominicana.

ESTILO:
- Responde corto (2 a 4 líneas), claro y amable.
- NO uses “mi amor”.
- Usa emojis suaves (✨😊💗🛒📍💳).

REGLAS CLAVE:
- Nunca inventes productos, precios ni presentaciones.
- Si falta un dato exacto del producto, dilo con honestidad ("No lo tengo exacto") y ofrece ayudar igual.
- Siempre termina con una llamada a continuar el pedido:
  "✨ Si deseas pedirlo, responde: PEDIR" o pregunta "¿Cuántos deseas?"

CUANDO HAYA UN PRODUCTO SELECCIONADO:
- Responde usando SOLO la información del producto proporcionada.
- Luego vuelve a empujar el pedido (PEDIR / cantidad).

PROHIBIDO:
- "contacta al equipo de ventas", "visita la web", "soporte", "no puedo ayudar".
`;
}

function buildProductContext(prod) {
  if (!prod) return "";
  const fields = {
    id: prod.id,
    name: prod.name,
    price: prod.price,
    category: prod.category || "",
    brand: prod.brand || "",
    description: prod.description || "",
    how_to_use: prod.how_to_use || prod.usage || "",
    benefits: prod.benefits || "",
    ingredients: prod.ingredients || "",
    warnings: prod.warnings || "",
    size: prod.size || "",
  };

  return `
PRODUCTO DISPONIBLE:
- Nombre: ${fields.name}
- Precio: ${money(fields.price)} c/u
- Categoría: ${fields.category}
- Marca: ${fields.brand}
- Descripción: ${fields.description}
- Uso / Cómo se usa: ${fields.how_to_use}
- Beneficios: ${fields.benefits}
- Ingredientes: ${fields.ingredients}
- Tamaño/presentación: ${fields.size}
- Advertencias: ${fields.warnings}
`.trim();
}

async function callOpenAI({ history = [], userText, prod = null }) {
  if (!OPENAI_API_KEY) {
    // fallback sin IA
    if (prod) return buildQuickProductInfoAnswer(prod, userText);
    return "😊 Cuéntame qué producto estás buscando y te digo precio ✨\n🛒 Si deseas pedir, responde: PEDIR";
  }

  const productContext = prod ? buildProductContext(prod) : "";

  // Mensajes: system + contexto producto + historial corto + user
  const messages = [
    { role: "system", content: getSystemPrompt() },
    ...(productContext ? [{ role: "system", content: productContext }] : []),
    ...history,
    { role: "user", content: userText },
  ];

  const payload = {
    model: MODEL,
    messages,
    temperature: 0.25,
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
      return "⏳ Un momentito 🙏 Escríbeme de nuevo en 5 segundos 😊";
    }
    return "😥 Tuve un pequeño error. ¿Me lo repites, por favor?";
  }

  let text = data.choices?.[0]?.message?.content?.trim() || "";

  // Asegurar CTA de pedido SIEMPRE
  const lower = normalizeText(text);
  const hasCTA =
    lower.includes("responde: pedir") ||
    lower.includes("¿cuantos deseas") ||
    lower.includes("cuántos deseas") ||
    lower.includes("pedir") ||
    lower.includes("pedido");

  if (!hasCTA) {
    text += `\n✨ Si deseas pedirlo, responde: PEDIR`;
  }

  return text;
}

function shouldUseOpenAI(text) {
  // SI no hay catálogo, no usar
  if (!CATALOG_OK) return false;

  const q = normalizeText(text);

  // Si el user manda cosas muy cortas tipo "hola", "ok", "si" => no IA
  if (q.length <= 2) return false;
  if (q === "hola" || q === "ok" || q === "si" || q === "sí") return false;

  // Si pide imagen o compra directa => no IA
  if (isAskingForImage(text) || isOrderIntent(text)) return false;

  // Si es pregunta rara o info -> sí IA (mejor respuesta)
  if (isProductInfoQuestion(text)) return true;

  // Si no parece un pedido ni nombre de producto => sí IA
  const keywordsCompra = ["precio", "quiero", "necesito", "envio", "envío", "ubicacion", "ubicación", "transferencia", "contra entrega"];
  const isCompra = keywordsCompra.some((k) => q.includes(k));
  if (isCompra) return false;

  // General: usar IA para preguntas raras fuera de flujo
  return true;
}

// =============================
// WHATSAPP SEND
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
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const from = message.from;

    // lock anti doble respuesta
    const lockKey = K.lock(from);
    const lock = await redisGet(lockKey);
    if (lock) return res.sendStatus(200);
    await redisSet(lockKey, "1", 2);

    // Si no hay catálogo -> responder fijo y no usar IA
    if (!CATALOG_OK) {
      await sendWhatsAppMessage(
        from,
        "⏳ Estoy actualizando el catálogo ahora mismo.\nEscríbeme en 1 minutico, por favor 😊✨"
      );
      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    // =========================================
    // 1) Leer texto + referral (anuncios)
    // =========================================
    let userText = "";
    if (message.type === "location" && message.location) {
      userText = "📍 Ubicación enviada";
    } else {
      userText = message.text?.body || "";
    }

    // Referral desde anuncio (Meta click-to-whatsapp)
    const referralText = extractReferralText(message);
    const combinedIncomingText = `${userText} ${referralText}`.trim();

    // =========================================
    // 2) State actual
    // =========================================
    const st = await getState(from);

    // =========================================
    // 3) Si llega ubicación
    // =========================================
    if (message.type === "location" && message.location) {
      st.location = {
        lat: message.location.latitude,
        lon: message.location.longitude,
        address: message.location.address || "",
        name: message.location.name || "",
      };

      if (st.step === "ASK_LOCATION") st.step = "ASK_REFERENCE";
      await setState(from, st);

      await sendWhatsAppMessage(from, "📍 Perfecto ✅ Ahora dime una referencia breve (Ej: “cerca del colmado”).");
      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    // =========================================
    // 4) Si viene desde anuncio y podemos detectar producto
    // =========================================
    if (!st.productId && referralText) {
      const adMatches = findProducts(referralText);
      if (adMatches.length >= 1) {
        const prodFromAd = adMatches[0];
        st.productId = prodFromAd.id;
        await redisSet(K.lastprod(from), prodFromAd.id);
        await setState(from, st);

        await sendWhatsAppMessage(
          from,
          `✨ ¡Hola! Vi que te interesa:\n💗 ${prodFromAd.name}\n💰 ${money(prodFromAd.price)} c/u\n¿Te gustaría pedirlo? Responde: PEDIR 🛒`
        );
        await redisDel(lockKey);
        return res.sendStatus(200);
      }
    }

    // =========================================
    // 5) Si ya hay producto seleccionado y preguntan algo “raro”
    //    -> Responder con OpenAI o quick answer, y SIEMPRE empujar pedido
    // =========================================
    if (st.productId && isProductInfoQuestion(userText)) {
      const prod = getProductById(st.productId);

      // primero respuesta rápida útil
      const quick = buildQuickProductInfoAnswer(prod, userText);

      // si quieres más “inteligente”, usamos OpenAI (mejor calidad)
      const useAI = shouldUseOpenAI(userText);

      let answer = quick;
      if (useAI) {
        const history = await getMemory(from);
        answer = await callOpenAI({ history, userText, prod });

        // Guardar memoria corta
        const newHistory = [
          ...history,
          { role: "user", content: userText },
          { role: "assistant", content: answer },
        ];
        await saveMemory(from, newHistory);
      }

      // Evitar repetir exactamente lo mismo
      const last = await redisGet(K.lastReply(from));
      if (last && normalizeText(last) === normalizeText(answer)) {
        answer += `\n🛒 Para pedirlo, responde: PEDIR`;
      }
      await redisSet(K.lastReply(from), answer, 60 * 60);

      await sendWhatsAppMessage(from, answer);
      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    // =========================================
    // 6) Detectar producto por texto normal (y también combinado con referral)
    // =========================================
    const matches = findProducts(combinedIncomingText);

    // Si encuentra 2+ productos, pedir aclaración (sin IA)
    if (matches.length >= 2 && !st.productId) {
      const list = matches.slice(0, 3).map((p, i) => `${i + 1}) ${p.name} — ${money(p.price)}`).join("\n");
      await sendWhatsAppMessage(
        from,
        `😊 Tengo varias opciones similares:\n${list}\n\nEscríbeme el número (1,2,3) o el nombre exacto ✨`
      );
      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    // Si encuentra 1 producto exacto
    if (matches.length === 1) {
      const prod = matches[0];
      st.productId = prod.id;
      await redisSet(K.lastprod(from), prod.id);

      // Si preguntó foto/imagen
      if (isAskingForImage(userText) && prod.image) {
        await setState(from, st);
        await sendWhatsAppImage(
          from,
          prod.image,
          `💗 ${prod.name}\n💰 ${money(prod.price)}\n🛒 Para pedirlo, responde: PEDIR`
        );
        await redisDel(lockKey);
        return res.sendStatus(200);
      }

      // Si quiere pedir
      if (isOrderIntent(userText) || normalizeText(userText).includes("quiero") || normalizeText(userText).includes("necesito")) {
        st.step = "ASK_QTY";
        await setState(from, st);

        await sendWhatsAppMessage(
          from,
          `💗 ${prod.name}\n💰 Precio: ${money(prod.price)} c/u\n¿Cuántos deseas? 🛒`
        );
        await redisDel(lockKey);
        return res.sendStatus(200);
      }

      // Respuesta estándar informativa
      await setState(from, st);
      await sendWhatsAppMessage(
        from,
        `✨ ${prod.name}\n💰 Precio: ${money(prod.price)}\n🛒 Si deseas pedirlo, responde: PEDIR`
      );
      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    // =========================================
    // 7) Si dice "PEDIR" o confirmar, usar last product si no hay seleccionado
    // =========================================
    if ((isOrderIntent(userText) || normalizeText(userText) === "pedir") && !st.productId) {
      const last = await redisGet(K.lastprod(from));
      if (last) {
        st.productId = last;
        st.step = "ASK_QTY";
        await setState(from, st);

        const prod = getProductById(last);
        if (prod) {
          await sendWhatsAppMessage(from, `Perfecto 🛒\n💗 ${prod.name}\n¿Cuántos deseas? 😊✨`);
          await redisDel(lockKey);
          return res.sendStatus(200);
        }
      }
    }

    // =========================================
    // 8) FLUJO DE COMPRA (STATE MACHINE)
    // =========================================
    if (isConfirmYes(userText) && st.productId && st.step === "IDLE") {
      st.step = "ASK_QTY";
      await setState(from, st);
      await sendWhatsAppMessage(from, "Perfecto 😊✨ ¿Cuántos deseas? 🛒");
      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    if (st.step === "ASK_QTY") {
      const qty = extractQty(userText) || (isConfirmYes(userText) ? 1 : null);

      if (!qty) {
        await sendWhatsAppMessage(from, "¿Cuántos deseas? 😊 (Ej: 1, 2, 3) 🛒");
        await redisDel(lockKey);
        return res.sendStatus(200);
      }

      st.qty = qty;
      st.step = "ASK_LOCATION";
      await setState(from, st);

      await sendWhatsAppMessage(
        from,
        "✅ Listo\nAhora envíame tu ubicación 📍\n📎 (clip) > Ubicación > Enviar ubicación actual"
      );
      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    if (st.step === "ASK_REFERENCE") {
      const ref = userText.trim();

      if (!ref) {
        await sendWhatsAppMessage(from, "Dime una referencia breve 😊 (Ej: cerca del colmado) 📍");
        await redisDel(lockKey);
        return res.sendStatus(200);
      }

      st.reference = ref;
      st.step = "ASK_PAYMENT";
      await setState(from, st);

      await sendWhatsAppMessage(from, "💳 ¿El pago será contra entrega o transferencia? 😊");
      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    if (st.step === "ASK_PAYMENT") {
      const pay = extractPayment(userText);

      if (!pay) {
        await sendWhatsAppMessage(from, "💳 ¿Contra entrega o transferencia? 😊");
        await redisDel(lockKey);
        return res.sendStatus(200);
      }

      st.payment = pay;
      st.step = "CONFIRM";
      await setState(from, st);

      const prod = getProductById(st.productId);
      const total = prod.price * st.qty;

      await sendWhatsAppMessage(
        from,
        `✅ Perfecto\n🛒 Tu pedido:\n- ${st.qty}x ${prod.name}\n💰 Total: ${money(total)}\n¿Confirmas para procesarlo? 😊✨`
      );
      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    if (st.step === "CONFIRM" && isConfirmYes(userText)) {
      const prod = getProductById(st.productId);
      const total = prod.price * st.qty;

      await sendWhatsAppMessage(from, "✅ Listo 💗\nTu pedido quedó confirmado.\nEn breve lo coordinamos 😊✨");

      // admin
      let adminText = `📦 NUEVO PEDIDO - Glowny Essentials\n\n`;
      adminText += `🛒 ${st.qty}x ${prod.name} — ${money(prod.price)}\n`;
      adminText += `💰 Total: ${money(total)}\n`;
      adminText += `💳 Pago: ${st.payment}\n`;
      adminText += `📍 Referencia: ${st.reference || "No indicada"}\n`;
      adminText += `WhatsApp: ${from}\nhttps://wa.me/${from}\n`;

      if (st.location?.lat && st.location?.lon) {
        adminText += `\n📍 Ubicación:\nhttps://www.google.com/maps?q=${st.location.lat},${st.location.lon}\n`;
      }

      await sendWhatsAppMessage(ADMIN_PHONE, adminText);

      // reset
      await redisDel(K.state(from));
      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    // Si el cliente escribe “no” en confirmación, volvemos a IDLE sin romper
    if (st.step === "CONFIRM" && isCancel(userText)) {
      await redisDel(K.state(from));
      await sendWhatsAppMessage(from, "Perfecto 😊✨ Cuando quieras, dime qué producto te interesa 💗");
      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    // =========================================
    // 9) Si pide imagen y ya hay producto seleccionado
    // =========================================
    if (isAskingForImage(userText) && st.productId) {
      const prod = getProductById(st.productId);
      if (prod?.image) {
        await sendWhatsAppImage(from, prod.image, `💗 ${prod.name}\n💰 ${money(prod.price)}\n🛒 Responde: PEDIR`);
        await redisDel(lockKey);
        return res.sendStatus(200);
      }
    }

    // =========================================
    // 10) OpenAI para preguntas raras (sin perder contexto)
    // =========================================
    if (shouldUseOpenAI(userText)) {
      const history = await getMemory(from);
      const prod = st.productId ? getProductById(st.productId) : null;

      let ai = await callOpenAI({ history, userText, prod });

      // Evitar repetición exacta
      const last = await redisGet(K.lastReply(from));
      if (last && normalizeText(last) === normalizeText(ai)) {
        ai += `\n🛒 Para pedirlo, responde: PEDIR`;
      }
      await redisSet(K.lastReply(from), ai, 60 * 60);

      const newHistory = [
        ...history,
        { role: "user", content: userText },
        { role: "assistant", content: ai },
      ];
      await saveMemory(from, newHistory);

      await sendWhatsAppMessage(from, ai);
      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    // =========================================
    // 11) Respuesta por defecto (sin IA)
    // =========================================
    await sendWhatsAppMessage(
      from,
      "😊 Escríbeme el nombre del producto que buscas y te digo precio ✨\n🛒 Si deseas pedir, responde: PEDIR"
    );

    await redisDel(lockKey);
    return res.sendStatus(200);
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
