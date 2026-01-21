
/**
 * Glowny Essentials - WhatsApp Bot (AI-first, NO hard flows)
 * ✅ Responde con IA usando catálogo
 * ✅ Maneja carrito + confirmación + datos de entrega (ubicación/referencia/pago)
 * ✅ NO pide ubicación/pago si no hay productos en el carrito
 * ✅ Si ya tiene ubicación, NO la vuelve a pedir
 * ✅ Puede mostrar "qué compré / qué tengo en el carrito"
 *
 * Requisitos ENV:
 * - WA_TOKEN
 * - PHONE_NUMBER_ID
 * - OPENAI_API_KEY
 * - UPSTASH_REDIS_REST_URL
 * - UPSTASH_REDIS_REST_TOKEN
 * - ADMIN_PHONE (tu WhatsApp para recibir pedidos)
 * - VERIFY_TOKEN (opcional)
 */

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
const MAX_HISTORY_MESSAGES = 12;

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
    .replace(/[^\w\s+]/g, " ")
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
  CATALOG_OK = PRODUCTS.length > 3;

  if (!CATALOG_OK) {
    PRODUCTS = [];
    console.log("⚠️ Catálogo NO cargado. Se bloqueará el bot AI.");
    return;
  }

  buildIndex();
}
loadCatalog();

// =============================
// UPSTASH REDIS (simple)
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
  ctx: (wa) => `glowny:ctx:${wa}`, // carrito + datos entrega + producto actual
  lock: (wa) => `glowny:lock:${wa}`,
};

// =============================
// HELPERS
// =============================
function money(n) {
  return `RD$${Number(n || 0).toLocaleString("en-US")}`;
}

function getProductById(id) {
  return PRODUCTS.find((p) => p.id === id) || null;
}

function safeProduct(prod) {
  if (!prod) return null;
  return {
    id: prod.id,
    name: prod.name,
    category: prod.category || "",
    type: prod.type || "",
    price: prod.price || 0,
    in_stock: !!prod.in_stock,
    description: prod.description || "",
    how_to_use: prod.how_to_use || "",
    duration_text: prod.duration_text || "",
    warnings: prod.warnings || "",
    ingredients: prod.ingredients || "",
    image: prod.image || "",
  };
}

function findProducts(query) {
  if (!CATALOG_OK) return [];

  const q = normalizeText(query);
  if (!q) return [];

  const qWords = q.split(" ").filter(Boolean);
  if (!qWords.length) return [];

  const scored = productIndex
    .map((p) => {
      let score = 0;

      if (p.normName.includes(q)) score += 12;

      const hits = qWords.filter((w) => p.wordSet.has(w)).length;
      score += hits;

      if (p.category && q.includes(normalizeText(p.category))) score += 2;
      if (p.type && q.includes(normalizeText(p.type))) score += 2;

      return { p, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 5).map((x) => x.p);
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
  if (q.includes("contra entrega") || q.includes("efectivo") || q.includes("cash"))
    return "Contra entrega";
  if (q.includes("transfer") || q.includes("tarjeta") || q.includes("deposito"))
    return "Transferencia";
  return null;
}

function isGreeting(text) {
  const q = normalizeText(text);
  return (
    q === "hola" ||
    q === "buenas" ||
    q.includes("buenos dias") ||
    q.includes("buenas noches") ||
    q.includes("buenas tardes")
  );
}

function isShowCart(text) {
  const q = normalizeText(text);
  return (
    q.includes("carrito") ||
    q.includes("que compre") ||
    q.includes("que compré") ||
    q.includes("que tengo") ||
    q.includes("muestrame") ||
    q.includes("muéstrame") ||
    q.includes("mi pedido") ||
    q.includes("pedido actual")
  );
}

function isConfirm(text) {
  const q = normalizeText(text);

  // Confirmación explícita
  if (
    q === "confirmar" ||
    q === "confirmo" ||
    q.includes("confirmar") ||
    q.includes("confirmo") ||
    q.includes("finalizar") ||
    q.includes("procesar") ||
    q.includes("confirmar pedido") ||
    q.includes("confirmar el pedido") ||
    q.includes("hacer el pedido") ||
    q.includes("ya estoy lista") ||
    q.includes("ya") ||
    q === "listo"
  ) return true;

  // Confirmación corta (clientes suelen responder así)
  return (
    q === "si" ||
    q === "sí" ||
    q === "ok" ||
    q === "oka" ||
    q === "okay" ||
    q === "dale" ||
    q === "va" ||
    q === "perfecto" ||
    q === "de acuerdo" ||
    q === "listo" ||
    q === "listaa" ||
    q === "okey"
  );
}


function isAddToCart(text) {
  const q = normalizeText(text);
  return (
    q === "pedir" ||
    q.includes("lo quiero") ||
    q.includes("lo llevo") ||
    q.includes("agregalo") ||
    q.includes("agregar") ||
    q.includes("añadir") ||
    q.includes("sumalo") ||
    q.includes("sumar") ||
    q.includes("quiero ese") ||
    q.includes("quiero este")
  );
}

function isClearCart(text) {
  const q = normalizeText(text);
  return (
    q.includes("cancelar") ||
    q.includes("eliminar pedido") ||
    q.includes("vaciar carrito") ||
    q.includes("borra el carrito")
  );
}

// =============================
// CONTEXTO (carrito + datos)
// =============================
async function getCtx(wa) {
  const ctx = (await redisGet(K.ctx(wa))) || {};
  const cart = Array.isArray(ctx.cart) ? ctx.cart : [];
  return {
    cart,
    current_product_id: ctx.current_product_id || null,
    location: ctx.location || null,
    reference: ctx.reference || null,
    payment: ctx.payment || null,
  };
}

async function setCtx(wa, ctx) {
  await redisSet(K.ctx(wa), ctx);
}

function cartSummaryLines(cart) {
  const lines = [];
  let total = 0;

  for (const item of cart) {
    const prod = getProductById(item.product_id);
    if (!prod) continue;
    const qty = Number(item.qty || 1);
    const sub = (Number(prod.price || 0) * qty) || 0;
    total += sub;
    lines.push(`• ${qty}x ${prod.name} — ${money(sub)}`);
  }

  return { lines, total };
}

function missingDeliveryFields(ctx) {
  const missing = [];
  if (!ctx.location) missing.push("location");
  if (!ctx.reference) missing.push("reference");
  if (!ctx.payment) missing.push("payment");
  return missing;
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
// OPENAI (JSON decision)
// =============================
function getSystemPrompt() {
  return `
Eres una asistente de ventas por WhatsApp de "Glowny Essentials" en República Dominicana.

OBJETIVO:
- Ayudar a clientas (muchas mayores) a pedir con mensajes "raros" o preguntas.
- Responder con info útil del PRODUCTO usando el catálogo.
- NUNCA inventes (si no está en el catálogo, dilo).

ESTILO:
- Femenino suave, profesional, 2 a 7 líneas.
- NO uses "mi amor".
- Emojis suaves: 😊✨💗🛒📍💳⏳🥄✅

REGLAS CLAVE:
1) Si NO hay producto en carrito, NO pidas ubicación ni pago.
2) Si el cliente dice "PEDIR/LO QUIERO" pero no hay producto claro, pide el nombre del producto o sugiere 3 categorías.
3) Si el cliente quiere confirmar y ya hay carrito:
   - Si falta ubicación: pide ubicación 📍
   - Si falta referencia: pide referencia breve
   - Si falta pago: pregunta contra entrega o transferencia
   - Si ya está todo: confirma el pedido ✅
4) Si preguntan "qué compré / qué tengo en el carrito", muestra el resumen y da opción de confirmar.
5) Si pregunta uso/duración/ingredientes: responde con catálogo. Si un campo está vacío, di: "No tengo ese dato exacto ahora mismo ✅" y da guía general sin inventar.

IMPORTANTE:
Responde SIEMPRE en JSON válido con esta forma EXACTA:

{
  "reply": "texto al cliente",
  "intent": "info|show_cart|add_to_cart|confirm_order|set_reference|set_payment|greeting|other|clear_cart",
  "product_id": "id_del_producto_o_vacio",
  "qty": 1,
  "reference": "texto_o_vacio",
  "payment": "Contra entrega|Transferencia|",
  "needs_location": false,
  "finalize_now": false
}

No agregues texto fuera del JSON.
`;
}

async function callOpenAI({ history, userText, ctx, candidates }) {
  if (!OPENAI_API_KEY) {
    return {
      reply: "Hola 😊✨ ¿Qué producto estás buscando hoy? Escríbeme el nombre 💗",
      intent: "greeting",
      product_id: "",
      qty: 1,
      reference: "",
      payment: "",
      needs_location: false,
      finalize_now: false,
    };
  }

  const cart = ctx.cart || [];
  const cartSummary = cartSummaryLines(cart);

  const payloadContext = {
    cart: cart.map((it) => ({
      product_id: it.product_id,
      qty: it.qty,
      name: getProductById(it.product_id)?.name || "",
      price: getProductById(it.product_id)?.price || 0,
    })),
    cart_total: cartSummary.total,
    current_product: safeProduct(getProductById(ctx.current_product_id)),
    delivery: {
      has_location: !!ctx.location,
      reference: ctx.reference || "",
      payment: ctx.payment || "",
    },
    candidates: (candidates || []).slice(0, 5).map(safeProduct),
  };

  const messages = [
    { role: "system", content: getSystemPrompt() },
    ...(Array.isArray(history) ? history.slice(-MAX_HISTORY_MESSAGES) : []),
    { role: "system", content: `CONTEXTO:\n${JSON.stringify(payloadContext, null, 2)}` },
    { role: "user", content: userText },
  ];

  const payload = {
    model: MODEL,
    messages,
    temperature: 0.2,
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
    return {
      reply: "😥 Ahora mismo tuve un inconveniente. ¿Me lo repites por favor?",
      intent: "other",
      product_id: "",
      qty: 1,
      reference: "",
      payment: "",
      needs_location: false,
      finalize_now: false,
    };
  }

  const raw = data.choices?.[0]?.message?.content?.trim() || "";

  try {
    const parsed = JSON.parse(raw);
    return {
      reply: String(parsed.reply || "").trim(),
      intent: String(parsed.intent || "other"),
      product_id: String(parsed.product_id || "").trim(),
      qty: Number(parsed.qty || 1) || 1,
      reference: String(parsed.reference || "").trim(),
      payment: String(parsed.payment || "").trim(),
      needs_location: !!parsed.needs_location,
      finalize_now: !!parsed.finalize_now,
    };
  } catch {
    return {
      reply: raw || "😊✨ ¿Qué producto estás buscando? Escríbeme el nombre 💗",
      intent: "other",
      product_id: "",
      qty: 1,
      reference: "",
      payment: "",
      needs_location: false,
      finalize_now: false,
    };
  }
}

// =============================
// MEMORIA conversacional
// =============================
async function getMemory(wa) {
  const mem = (await redisGet(K.mem(wa))) || [];
  return Array.isArray(mem) ? mem : [];
}

async function saveMemory(wa, history) {
  await redisSet(K.mem(wa), history.slice(-MAX_HISTORY_MESSAGES));
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
async function sendAdminOrder(from, ctx) {
  const cartSum = cartSummaryLines(ctx.cart);
  let adminText = `📦 NUEVO PEDIDO - Glowny Essentials ✅\n\n`;

  for (const line of cartSum.lines) adminText += `${line}\n`;

  adminText += `\n💰 Total: ${money(cartSum.total)}\n`;
  adminText += `💳 Pago: ${ctx.payment || "No indicado"}\n`;
  adminText += `📍 Referencia: ${ctx.reference || "No indicada"}\n`;
  adminText += `WhatsApp: ${from}\nhttps://wa.me/${from}\n`;

  if (ctx.location?.lat && ctx.location?.lon) {
    adminText += `\n📍 Ubicación:\nhttps://www.google.com/maps?q=${ctx.location.lat},${ctx.location.lon}\n`;
  }

  await sendWhatsAppMessage(ADMIN_PHONE, adminText);
}

// =============================
// MAIN WEBHOOK (AI-first, no hard flows)
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

    // lock anti doble respuesta
    const lockKey = K.lock(from);
    const lock = await redisGet(lockKey);
    if (lock) return res.sendStatus(200);
    await redisSet(lockKey, "1", 2);

    // Sin catálogo
    if (!CATALOG_OK) {
      await sendWhatsAppMessage(
        from,
        "✨ Estamos actualizando el catálogo en este momento 😊\nIntenta de nuevo en 1 minutito 🙏"
      );
      return safeEnd(lockKey);
    }

    // Ctx actual
    const ctx = await getCtx(from);

    // =============================
    // 1) Si viene de anuncio (referral) -> set producto actual
    // =============================
    const adText = extractAdTextFromMessage(message);
    if (adText) {
      const adMatches = findProducts(adText);
      if (adMatches.length >= 1) {
        const prod = adMatches[0];
        ctx.current_product_id = prod.id;
        await setCtx(from, ctx);
      }
    }

    // =============================
    // 2) Si es ubicación -> guardar y responder sin repetir
    // =============================
    if (message.type === "location" && message.location) {
      ctx.location = {
        lat: message.location.latitude,
        lon: message.location.longitude,
        address: message.location.address || "",
        name: message.location.name || "",
      };
      await setCtx(from, ctx);

      if (!ctx.cart?.length) {
        await sendWhatsAppMessage(from, "📍 Ubicación recibida ✅\nAhora dime qué producto deseas pedir 😊🛒");
        return safeEnd(lockKey);
      }

      const missing = missingDeliveryFields(ctx);
      if (missing.includes("reference")) {
        await sendWhatsAppMessage(from, "✅ ¡Gracias! 😊\nAhora dime una referencia breve (Ej: cerca del colmado) 📍");
        return safeEnd(lockKey);
      }
      if (missing.includes("payment")) {
        await sendWhatsAppMessage(from, "💳 Perfecto ✅\n¿El pago será contra entrega o transferencia? 😊");
        return safeEnd(lockKey);
      }

      await sendWhatsAppMessage(from, "✅ Perfecto 😊\nYa tenemos todo. Escribe *CONFIRMAR* para finalizar tu pedido 🛒💗");
      return safeEnd(lockKey);
    }

    // Texto normal
    const userText = message.text?.body || "";
    const normText = normalizeText(userText);

    // =============================
    // 3) Capturar pago / referencia aunque el usuario lo escriba suelto
    // =============================
    const pay = extractPayment(userText);
    if (pay) {
      ctx.payment = pay;
      await setCtx(from, ctx);
    }

    if (ctx.location && !ctx.reference) {
      const looksLikeQuestion =
        userText.includes("?") ||
        normText.startsWith("como") ||
        normText.startsWith("que") ||
        normText.startsWith("cuanto") ||
        normText.startsWith("donde") ||
        normText.startsWith("cual") ||
        normText.startsWith("cuál");
      if (!looksLikeQuestion && normText.length > 2 && normText.length <= 60) {
        ctx.reference = userText.trim();
        await setCtx(from, ctx);
      }
    }

    // =============================
    // 4) Mostrar carrito rápido
    // =============================
    if (isShowCart(userText)) {
      if (!ctx.cart?.length) {
        await sendWhatsAppMessage(from, "🛒 Tu carrito está vacío 😊\nDime el nombre del producto que deseas 💗");
        return safeEnd(lockKey);
      }

      const sum = cartSummaryLines(ctx.cart);
      const body = `🛒 Tu carrito:\n${sum.lines.join("\n")}\n\n💰 Total: ${money(sum.total)}\n\n✅ Escribe *CONFIRMAR* para finalizar o dime si deseas agregar otro producto 😊✨`;
      await sendWhatsAppMessage(from, body);
      return safeEnd(lockKey);
    }

    // =============================
    // 5) Vaciar carrito
    // =============================
    if (isClearCart(userText)) {
      await redisDel(K.ctx(from));
      await sendWhatsAppMessage(from, "✅ Listo 😊\nTu carrito fue vaciado. ¿Qué producto te gustaría ahora? 💗🛒");
      return safeEnd(lockKey);
    }

    // =============================
    // 6) Confirmar pedido -> pedir SOLO lo que falta
    // =============================
    if (isConfirm(userText)) {
      if (!ctx.cart?.length) {
        await sendWhatsAppMessage(from, "🛒 Aún no tienes productos en el carrito 😊\nDime qué producto deseas pedir 💗");
        return safeEnd(lockKey);
      }

      const missing = missingDeliveryFields(ctx);

      if (missing.includes("location")) {
        await sendWhatsAppMessage(from, "📍 Perfecto ✅\nEnvíame tu ubicación para coordinar la entrega 😊");
        return safeEnd(lockKey);
      }
      if (missing.includes("reference")) {
        await sendWhatsAppMessage(from, "✅ Gracias 😊\nAhora dime una referencia breve (Ej: cerca del colmado) 📍");
        return safeEnd(lockKey);
      }
      if (missing.includes("payment")) {
        await sendWhatsAppMessage(from, "💳 Perfecto ✅\n¿El pago será contra entrega o transferencia? 😊");
        return safeEnd(lockKey);
      }

      const sum = cartSummaryLines(ctx.cart);
      await sendWhatsAppMessage(from, `✅ Pedido confirmado 💗\nTotal: ${money(sum.total)}\nEn breve te lo coordinamos 😊`);
      await sendAdminOrder(from, ctx);
      await redisDel(K.ctx(from));
      return safeEnd(lockKey);
    }

    // =============================
    // 7) PEDIR / LO QUIERO -> agregar al carrito
    // =============================
    if (isAddToCart(userText)) {
      const qty = extractQty(userText) || 1;

      if (ctx.current_product_id) {
        const prod = getProductById(ctx.current_product_id);
        if (prod) {
          ctx.cart = Array.isArray(ctx.cart) ? ctx.cart : [];
          const existing = ctx.cart.find((x) => x.product_id === prod.id);
          if (existing) existing.qty = Number(existing.qty || 1) + qty;
          else ctx.cart.push({ product_id: prod.id, qty });

          await setCtx(from, ctx);

          const sum = cartSummaryLines(ctx.cart);
          await sendWhatsAppMessage(
            from,
            `✅ Agregado al carrito 😊🛒\n${qty}x ${prod.name}\n\n💰 Total actual: ${money(sum.total)}\nEscribe *CONFIRMAR* para finalizar o dime si deseas agregar otro 💗`
          );
          return safeEnd(lockKey);
        }
      }

      const matches = findProducts(userText);
      if (matches.length === 1) {
        const prod = matches[0];
        ctx.current_product_id = prod.id;
        ctx.cart = Array.isArray(ctx.cart) ? ctx.cart : [];
        ctx.cart.push({ product_id: prod.id, qty });
        await setCtx(from, ctx);

        const sum = cartSummaryLines(ctx.cart);
        await sendWhatsAppMessage(
          from,
          `✅ Agregado al carrito 😊🛒\n${qty}x ${prod.name}\n\n💰 Total actual: ${money(sum.total)}\nEscribe *CONFIRMAR* para finalizar o dime si deseas agregar otro 💗`
        );
        return safeEnd(lockKey);
      }

      await sendWhatsAppMessage(
        from,
        "🛒 ¡Claro! 😊\nDime el nombre del producto que deseas pedir (Ej: gel aloe, colágeno, protector solar) 💗"
      );
      return safeEnd(lockKey);
    }

    // =============================
    // 8) Detectar producto por texto y set current_product
    // =============================
    const matches = findProducts(userText);
    if (matches.length === 1) {
      const prod = matches[0];
      ctx.current_product_id = prod.id;
      await setCtx(from, ctx);

      const lines = [];
      lines.push(`💗 ${prod.name}`);
      lines.push(`Precio: ${money(prod.price)}`);
      const d = (prod.description || "").trim();
      if (d) lines.push(`✨ ${d.split("\n")[0].slice(0, 90)}`);
      lines.push("🛒 Si deseas pedirlo, escribe: PEDIR");

      await sendWhatsAppMessage(from, lines.join("\n"));
      return safeEnd(lockKey);
    }

    if (matches.length > 1 && normText.length > 2) {
      const list = matches
        .slice(0, 4)
        .map((p) => `• ${p.name} — ${money(p.price)}`)
        .join("\n");
      await sendWhatsAppMessage(from, `✨ Encontré estas opciones:\n${list}\n\nEscríbeme cuál te interesa 😊💗`);
      return safeEnd(lockKey);
    }

    // =============================
    // 9) IA para todo lo demás
    // =============================
    const history = await getMemory(from);
    const ai = await callOpenAI({
      history,
      userText,
      ctx,
      candidates: matches,
    });

    const newHistory = [
      ...history,
      { role: "user", content: userText },
      { role: "assistant", content: ai.reply || "" },
    ];
    await saveMemory(from, newHistory);

    // acciones ligeras
    if (ai.intent === "set_payment" && ai.payment) {
      ctx.payment = ai.payment;
      await setCtx(from, ctx);
    }
    if (ai.intent === "set_reference" && ai.reference) {
      ctx.reference = ai.reference;
      await setCtx(from, ctx);
    }
    if (ai.intent === "add_to_cart" && ai.product_id) {
      const prod = getProductById(ai.product_id);
      if (prod) {
        ctx.current_product_id = prod.id;
        ctx.cart = Array.isArray(ctx.cart) ? ctx.cart : [];
        const qty = Number(ai.qty || 1) || 1;
        const existing = ctx.cart.find((x) => x.product_id === prod.id);
        if (existing) existing.qty = Number(existing.qty || 1) + qty;
        else ctx.cart.push({ product_id: prod.id, qty });
        await setCtx(from, ctx);
      }
    }

    if (ai.finalize_now) {
      if (!ctx.cart?.length) {
        await sendWhatsAppMessage(from, "🛒 Aún no tienes productos en el carrito 😊\nDime cuál deseas 💗");
        return safeEnd(lockKey);
      }

      const missing = missingDeliveryFields(ctx);
      if (missing.includes("location")) {
        await sendWhatsAppMessage(from, "📍 Perfecto ✅\nEnvíame tu ubicación para coordinar la entrega 😊");
        return safeEnd(lockKey);
      }
      if (missing.includes("reference")) {
        await sendWhatsAppMessage(from, "✅ Gracias 😊\nAhora dime una referencia breve (Ej: cerca del colmado) 📍");
        return safeEnd(lockKey);
      }
      if (missing.includes("payment")) {
        await sendWhatsAppMessage(from, "💳 Perfecto ✅\n¿El pago será contra entrega o transferencia? 😊");
        return safeEnd(lockKey);
      }

      const sum = cartSummaryLines(ctx.cart);
      await sendWhatsAppMessage(from, `✅ Pedido confirmado 💗\nTotal: ${money(sum.total)}\nEn breve te lo coordinamos 😊`);
      await sendAdminOrder(from, ctx);
      await redisDel(K.ctx(from));
      return safeEnd(lockKey);
    }

    if (ai.reply && ai.reply.trim().length) {
      await sendWhatsAppMessage(from, ai.reply.trim());
      return safeEnd(lockKey);
    }

    if (isGreeting(userText)) {
      await sendWhatsAppMessage(from, "¡Hola! 😊✨\n¿Qué producto estás buscando hoy? Escríbeme el nombre 💗");
      return safeEnd(lockKey);
    }

    await sendWhatsAppMessage(from, "😊✨ Escríbeme el nombre del producto y te ayudo con precio y detalles 💗");
    return safeEnd(lockKey);
  } catch (err) {
    console.error("❌ Error webhook:", err);
    return res.sendStatus(200);
  }
});

// =============================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Bot Glowny (AI-first) corriendo en puerto ${PORT}`);
});
