
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
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
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
  let data = [];
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.log("❌ catalog.json no es JSON válido");
    return [];
  }

  if (!Array.isArray(data) || data.length === 0) {
    console.log("❌ catalog.json inválido o vacío");
    return [];
  }

  console.log(`✅ Catálogo cargado (${data.length} productos)`);
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
  CATALOG_OK = PRODUCTS.length > 0;

  if (!CATALOG_OK) {
    PRODUCTS = [];
    console.log("⚠️ Catálogo NO cargado.");
    return;
  }
  buildIndex();
}
loadCatalog();

function getProductById(id) {
  if (!CATALOG_OK) return null;
  return PRODUCTS.find((p) => p.id === id) || null;
}

function money(n) {
  return `RD$${Number(n || 0).toLocaleString("en-US")}`;
}

// =============================
// PRODUCT MATCHING (SOLO APOYO)
// =============================
function findProducts(query, limit = 5) {
  if (!CATALOG_OK) return [];
  const q = normalizeText(query);
  if (!q) return [];
  const qWords = q.split(" ").filter(Boolean);
  if (!qWords.length) return [];

  const scored = productIndex
    .map((p) => {
      let score = 0;

      // match por frase
      if (p.normName.includes(q)) score += 12;

      // hits por palabras
      const hits = qWords.filter((w) => p.wordSet.has(w)).length;
      score += hits;

      // boost por category/type si el usuario lo menciona
      const cat = normalizeText(p.category || "");
      const type = normalizeText(p.type || "");
      if (cat && q.includes(cat)) score += 2;
      if (type && q.includes(type)) score += 2;

      return { p, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((x) => x.p);
}

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
  sess: (wa) => `glowny:sess:${wa}`,
  lock: (wa) => `glowny:lock:${wa}`,
};

// =============================
// SESSION (sin flujos, solo memoria)
// =============================
async function getSession(wa) {
  const s = (await redisGet(K.sess(wa))) || {};
  return {
    current_product_id: s.current_product_id || null,
    cart: Array.isArray(s.cart) ? s.cart : [], // [{product_id, qty}]
    customer: s.customer || {
      location: null,
      reference: null,
      payment: null,
      name: null,
      city: null,
      sector: null,
    },
    last_seen_at: s.last_seen_at || null,
  };
}

async function saveSession(wa, session) {
  session.last_seen_at = Date.now();
  await redisSet(K.sess(wa), session);
}

function cartTotal(cart) {
  let total = 0;
  for (const it of cart || []) {
    const p = getProductById(it.product_id);
    if (p) total += Number(p.price || 0) * Number(it.qty || 1);
  }
  return total;
}

function cartLines(cart) {
  const lines = [];
  for (const it of cart || []) {
    const p = getProductById(it.product_id);
    if (!p) continue;
    lines.push(`• ${it.qty}x ${p.name} — ${money(p.price)}`);
  }
  return lines;
}

function upsertCartItem(cart, product_id, qty) {
  const safeQty = Math.max(1, Math.min(10, Number(qty || 1)));
  const idx = (cart || []).findIndex((x) => x.product_id === product_id);
  if (idx >= 0) {
    cart[idx].qty += safeQty;
  } else {
    cart.push({ product_id, qty: safeQty });
  }
  return cart;
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
// OPENAI (AI-FIRST)
// =============================
function getSystemPrompt() {
  return `
Eres una asistente de ventas por WhatsApp de "Glowny Essentials" en República Dominicana.

OBJETIVO:
- Responder preguntas de clientes (muchas son señoras mayores) de forma clara, amable y útil.
- Ayudarles a elegir productos, dar información del producto y cerrar pedidos.

ESTILO:
- Español simple, cálido, profesional.
- Feminino suave, sin exagerar.
- NO uses “mi amor”.
- Emojis suaves y pocos: 😊✨🛒📍💳⏳🥄✅

REGLAS IMPORTANTES (OBLIGATORIAS):
1) No inventes información de productos. 
   - Solo usa lo que venga en el catálogo/contexto.
2) Si no tienes un dato exacto, di: "No tengo ese dato exacto ahora mismo ✅".
   - Puedes dar una guía general segura (sin afirmar cifras exactas).
3) Si el usuario ya está hablando de un producto (producto actual), NO le pidas "nombre del producto" otra vez.
4) Si el usuario dice "PEDIR", "lo quiero", "agrégalo", "quiero ese", tu tarea es facilitar compra:
   - Agrega el producto actual al carrito y pregúntale si quiere confirmar.
5) Si pregunta por el carrito ("qué tengo", "muéstrame lo que compré"), muestra resumen.
6) Para confirmar un pedido, pide: ubicación (enviar ubicación), referencia y método de pago (contra entrega o transferencia).
7) Siempre termina con un CTA fácil:
   - Si no hay carrito: "🛒 Si deseas pedir, dime: PEDIR"
   - Si hay carrito: "✅ Para confirmar, responde: CONFIRMAR"

FORMATO DE SALIDA:
Debes responder SOLO con un JSON válido, sin texto adicional.

Esquema:
{
  "reply": "texto final para el cliente",
  "actions": {
    "set_current_product_id": "opcional",
    "add_to_cart": [{"product_id":"", "qty":1}],
    "set_reference": "opcional",
    "set_payment": "Contra entrega|Transferencia|opcional",
    "request_location": true|false,
    "confirm_order": true|false,
    "clear_cart": true|false
  }
}
`;
}

// arma contexto mínimo para que la IA no "invente"
function buildAIContext({ session, candidates }) {
  const current = session.current_product_id
    ? getProductById(session.current_product_id)
    : null;

  const currentSafe = current
    ? {
        id: current.id,
        name: current.name,
        price: current.price,
        category: current.category || "",
        type: current.type || "",
        description: current.description || "",
        how_to_use: current.how_to_use || "",
        duration_text: current.duration_text || "",
        warnings: current.warnings || "",
        ingredients: current.ingredients || "",
      }
    : null;

  const candSafe = (candidates || []).slice(0, 5).map((p) => ({
    id: p.id,
    name: p.name,
    price: p.price,
    category: p.category || "",
    type: p.type || "",
  }));

  const cartSafe = (session.cart || []).map((it) => {
    const p = getProductById(it.product_id);
    return p
      ? { product_id: it.product_id, qty: it.qty, name: p.name, price: p.price }
      : { product_id: it.product_id, qty: it.qty };
  });

  return {
    current_product: currentSafe,
    candidate_products: candSafe,
    cart: cartSafe,
    customer: {
      has_location: !!session.customer?.location,
      reference: session.customer?.reference || null,
      payment: session.customer?.payment || null,
    },
  };
}

async function callOpenAI({ userText, session, candidates }) {
  if (!OPENAI_API_KEY) {
    // fallback si falta key
    return {
      reply: "😊✨ ¡Hola! Escríbeme el nombre del producto y te ayudo. 🛒",
      actions: {},
    };
  }

  const ctx = buildAIContext({ session, candidates });

  const messages = [
    { role: "system", content: getSystemPrompt() },
    {
      role: "system",
      content: `Contexto (no inventar, solo usar esto):\n${JSON.stringify(ctx, null, 2)}`,
    },
    { role: "user", content: userText },
  ];

  const payload = {
    model: MODEL,
    messages,
    temperature: 0.15,
    max_tokens: 260,
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
      return { reply: "🙏 Dame 5 segunditos y me lo repites por favor 😊", actions: {} };
    }
    return { reply: "😥 Tuve un inconveniente, ¿me lo repites por favor?", actions: {} };
  }

  const out = data.choices?.[0]?.message?.content?.trim() || "";

  // parse JSON
  try {
    const obj = JSON.parse(out);
    if (!obj || typeof obj !== "object") throw new Error("json invalid");
    return {
      reply: String(obj.reply || "").trim(),
      actions: obj.actions || {},
    };
  } catch (e) {
    // fallback: si el modelo no devolvió JSON
    return {
      reply: "😊✨ Puedo ayudarte con eso. ¿Qué producto te interesa? 🛒",
      actions: {},
    };
  }
}

// =============================
// WHATSAPP
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
// ADMIN MESSAGE (pedido confirmado)
// =============================
async function sendAdminOrder({ from, session }) {
  const lines = cartLines(session.cart);
  const total = cartTotal(session.cart);

  let adminText = `📦 NUEVO PEDIDO CONFIRMADO - Glowny Essentials ✅\n\n`;
  adminText += `👤 Cliente: https://wa.me/${from}\n`;
  adminText += `🛒 Productos:\n${lines.join("\n") || "—"}\n`;
  adminText += `💰 Total: ${money(total)}\n`;
  adminText += `💳 Pago: ${session.customer?.payment || "No indicado"}\n`;
  adminText += `📍 Referencia: ${session.customer?.reference || "No indicada"}\n`;

  const loc = session.customer?.location;
  if (loc?.lat && loc?.lon) {
    adminText += `\n📍 Ubicación:\nhttps://www.google.com/maps?q=${loc.lat},${loc.lon}\n`;
  }

  await sendWhatsAppMessage(ADMIN_PHONE, adminText);
}

// =============================
// APPLY ACTIONS (con validación)
// =============================
function sanitizeActions(actions) {
  const a = actions && typeof actions === "object" ? actions : {};
  const clean = {
    set_current_product_id: typeof a.set_current_product_id === "string" ? a.set_current_product_id : null,
    add_to_cart: Array.isArray(a.add_to_cart) ? a.add_to_cart : [],
    set_reference: typeof a.set_reference === "string" ? a.set_reference.trim() : null,
    set_payment: typeof a.set_payment === "string" ? a.set_payment.trim() : null,
    request_location: !!a.request_location,
    confirm_order: !!a.confirm_order,
    clear_cart: !!a.clear_cart,
  };
  return clean;
}

function isValidPayment(p) {
  const n = normalizeText(p);
  if (n.includes("contra")) return "Contra entrega";
  if (n.includes("transfer")) return "Transferencia";
  return null;
}

function hasMinimumToConfirm(session) {
  const hasCart = (session.cart || []).length > 0;
  const hasLoc = !!session.customer?.location;
  const hasRef = !!session.customer?.reference;
  const hasPay = !!session.customer?.payment;
  return hasCart && hasLoc && hasRef && hasPay;
}

// =============================
// MAIN WEBHOOK (AI-FIRST)
// =============================
app.post("/webhook", async (req, res) => {
  const safeEnd = async (from, lockKey) => {
    try { if (lockKey) await redisDel(lockKey); } catch {}
    return res.sendStatus(200);
  };

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

    // catálogo requerido
    if (!CATALOG_OK) {
      await sendWhatsAppMessage(from, "✨ Estamos actualizando el catálogo 😊\nIntenta de nuevo en 1 minutito 🙏");
      return safeEnd(from, lockKey);
    }

    // session
    const session = await getSession(from);

    // si viene de anuncio
    const adText = extractAdTextFromMessage(message);
    if (adText) {
      const adMatches = findProducts(adText, 3);
      if (adMatches.length) {
        session.current_product_id = adMatches[0].id;
        await saveSession(from, session);
      }
    }

    // location message (guardar y responder con IA)
    let userText = "";
    if (message.type === "location" && message.location) {
      session.customer.location = {
        lat: message.location.latitude,
        lon: message.location.longitude,
        address: message.location.address || "",
        name: message.location.name || "",
      };
      await saveSession(from, session);
      userText = "Ubicación enviada";
    } else {
      userText = message.text?.body || "";
    }

    // candidates para ayudar a IA a seleccionar producto
    const candidates = findProducts(userText, 5);

    // si el texto coincide FUERTE con un producto, asignarlo como producto actual
    if (candidates.length === 1) {
      session.current_product_id = candidates[0].id;
    } else {
      // si hay varios pero el usuario dice algo genérico tipo "aloe", no cambiamos el actual automáticamente
      // IA lo decide con actions.set_current_product_id
    }

    // llamar IA siempre (AI-FIRST)
    const ai = await callOpenAI({ userText, session, candidates });
    const actions = sanitizeActions(ai.actions);

    // aplicar acciones seguras
    if (actions.set_current_product_id) {
      const p = getProductById(actions.set_current_product_id);
      if (p) session.current_product_id = p.id;
    }

    // add_to_cart
    for (const it of actions.add_to_cart || []) {
      const pid = typeof it.product_id === "string" ? it.product_id : null;
      const qty = Number(it.qty || 1);
      const p = pid ? getProductById(pid) : null;
      if (!p) continue;
      session.cart = upsertCartItem(session.cart, p.id, qty);
      session.current_product_id = p.id; // mantener contexto
    }

    // set_reference
    if (actions.set_reference && actions.set_reference.length > 2) {
      session.customer.reference = actions.set_reference.slice(0, 120);
    }

    // set_payment
    if (actions.set_payment) {
      const pay = isValidPayment(actions.set_payment);
      if (pay) session.customer.payment = pay;
    }

    await saveSession(from, session);

    // confirm_order
    if (actions.confirm_order) {
      if (hasMinimumToConfirm(session)) {
        await sendWhatsAppMessage(from, ai.reply || "✅ Pedido confirmado 😊🛒");
        await sendAdminOrder({ from, session });

        // limpiar carrito si el modelo lo pide o si confirmamos
        session.cart = [];
        // dejamos referencia/pago/location por si vuelve a pedir pronto (opcional)
        await saveSession(from, session);
        return safeEnd(from, lockKey);
      } else {
        // si la IA intentó confirmar sin datos mínimos, respondemos lo que dijo igual
        await sendWhatsAppMessage(from, ai.reply || "😊 Para confirmar, necesito ubicación, referencia y método de pago ✅");
        return safeEnd(from, lockKey);
      }
    }

    // clear_cart
    if (actions.clear_cart) {
      session.cart = [];
      await saveSession(from, session);
    }

    // enviar reply
    const finalReply =
      (ai.reply && ai.reply.trim().length > 0)
        ? ai.reply.trim()
        : "😊✨ ¿Qué producto te interesa? 🛒";

    await sendWhatsAppMessage(from, finalReply);
    return safeEnd(from, lockKey);
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
