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
let categoryIndex = new Map(); // category -> products[]
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
    return {
      ...p,
      normName,
      wordSet: new Set(words),
      normCategory: normalizeText(p.category || ""),
    };
  });

  categoryIndex = new Map();
  for (const p of productIndex) {
    const cat = p.normCategory || "otros";
    if (!categoryIndex.has(cat)) categoryIndex.set(cat, []);
    categoryIndex.get(cat).push(p);
  }
}

function loadCatalog() {
  PRODUCTS = loadCatalogFromFile();
  CATALOG_OK = PRODUCTS.length > 0;

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
  mid: (mid) => `glowny:mid:${mid}`, // para dedupe de mensajes
};

// =============================
// HELPERS
// =============================
function money(n) {
  return `RD$${Number(n || 0).toLocaleString("en-US")}`;
}

function safeTrim(s) {
  return (s || "").toString().trim();
}

// =============================
// PRODUCT MATCHING (MEJORADO)
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

      // match completo dentro del nombre
      if (p.normName.includes(q)) score += 10;

      // hits por palabras
      const hits = qWords.filter((w) => p.wordSet.has(w)).length;
      score += hits;

      // bonus si coincide por palabra clave larga
      for (const w of qWords) {
        if (w.length >= 5 && p.normName.includes(w)) score += 1;
      }

      return { p, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 3).map((x) => x.p);
}

function getProductById(id) {
  if (!CATALOG_OK) return null;
  return productIndex.find((p) => p.id === id) || null;
}

function listSimilarByCategory(catNorm, excludeId = null, limit = 5) {
  if (!catNorm) return [];
  const arr = categoryIndex.get(catNorm) || [];
  const filtered = excludeId ? arr.filter((p) => p.id !== excludeId) : arr;
  return filtered.slice(0, limit);
}

function getCategoriesMenu(limit = 7) {
  const cats = Array.from(categoryIndex.keys())
    .filter((c) => c && c !== "otros")
    .slice(0, limit);

  if (!cats.length) return null;

  return cats;
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
    q.includes("confirmar")
  );
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
    q.includes("comprar")
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
  return (
    q.includes("foto") ||
    q.includes("imagen") ||
    q.includes("muestrame") ||
    q.includes("mostrar") ||
    q.includes("ver")
  );
}

// ✅ NUEVO: “como se usa”
function isUsageQuestion(text) {
  const q = normalizeText(text);
  return (
    q.includes("como se usa") ||
    q.includes("como usar") ||
    q.includes("modo de uso") ||
    q.includes("como aplic") ||
    q.includes("se aplica") ||
    q.includes("se usa") ||
    q.includes("cada cuanto") ||
    q.includes("de dia") ||
    q.includes("de noche")
  );
}

// ✅ NUEVO: “que otras tienes / opciones”
function isOtherOptionsQuestion(text) {
  const q = normalizeText(text);
  return (
    q.includes("que otras tienes") ||
    q.includes("cuales otras") ||
    q.includes("que mas tienes") ||
    q.includes("tienes mas") ||
    q.includes("otras opciones") ||
    q.includes("dame opciones") ||
    q.includes("algo parecido") ||
    q.includes("otra opcion")
  );
}

// =============================
// OPENAI (SOLO si es necesario)
// =============================
function shouldUseOpenAI(text) {
  if (!CATALOG_OK) return false;

  const q = normalizeText(text);

  // ❌ si parece pedido/producto/venta directa, no usar AI
  if (
    q.includes("precio") ||
    q.includes("cuanto cuesta") ||
    q.includes("quiero") ||
    q.includes("necesito") ||
    q.includes("envio") ||
    q.includes("ubicacion") ||
    q.includes("contra entrega") ||
    q.includes("transferencia") ||
    isOrderIntent(text)
  ) {
    return false;
  }

  // ❌ si es “otras opciones” lo manejamos nosotros
  if (isOtherOptionsQuestion(text)) return false;

  // ✅ si es algo fuera de catálogo: piel, recomendación, dudas generales
  return true;
}

function getSystemPrompt() {
  return `
Eres una asistente de ventas por WhatsApp de "Glowny Essentials" en República Dominicana.

REGLAS OBLIGATORIAS:
- Responde corto (1 a 3 líneas), amable y directo.
- Nunca digas "contacta al equipo de ventas", "visita la web", "soporte", ni nada parecido.
- No inventes precios ni productos. Si te preguntan por productos, solo usa el catálogo.
- Si te preguntan "cómo se usa", da pasos claros y seguros.
- Si no estás segura de algo, pregunta 1 sola cosa para aclarar.
`;
}

async function callOpenAI(history, userText, extraContext = "") {
  if (!OPENAI_API_KEY) {
    return "Mi amor dime qué producto necesitas y te ayudo 😊";
  }

  const messages = [
    { role: "system", content: getSystemPrompt() },
    ...(extraContext ? [{ role: "system", content: extraContext }] : []),
    ...history,
    { role: "user", content: userText },
  ];

  const payload = {
    model: MODEL,
    messages,
    temperature: 0.2,
    max_tokens: 180,
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
      return "Dame 5 segunditos 🙏 y me lo repites porfa.";
    }
    return "Ahora mismo tuve un error 😥 ¿Me lo repites?";
  }

  return data.choices?.[0]?.message?.content?.trim() || "¿Qué producto deseas mi amor? 😊";
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

    // ✅ NUEVO: contexto real
    lastCategory: st.lastCategory || null, // normalized category
    lastProductName: st.lastProductName || null,
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
    const msgId = message.id;

    // ✅ DEDUPE por message.id (Meta reintenta y por eso ves respuestas raras/repetidas)
    if (msgId) {
      const seen = await redisGet(K.mid(msgId));
      if (seen) return res.sendStatus(200);
      await redisSet(K.mid(msgId), "1", 60); // 60 segundos
    }

    // lock anti doble respuesta
    const lockKey = K.lock(from);
    const lock = await redisGet(lockKey);
    if (lock) return res.sendStatus(200);
    await redisSet(lockKey, "1", 2);

    // Si no hay catálogo -> responder fijo y no usar AI
    if (!CATALOG_OK) {
      await sendWhatsAppMessage(
        from,
        "Mi amor ahora mismo estoy actualizando el catálogo 😥\nEscríbeme en 1 minutico porfa 🙏"
      );
      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    let userText = "";

    // Location
    if (message.type === "location" && message.location) {
      userText = "📍 Ubicación enviada";
      const st = await getState(from);

      st.location = {
        lat: message.location.latitude,
        lon: message.location.longitude,
        address: message.location.address || "",
        name: message.location.name || "",
      };

      if (st.step === "ASK_LOCATION") st.step = "ASK_REFERENCE";
      await setState(from, st);

      await sendWhatsAppMessage(from, "Perfecto ✅ Ahora dime una referencia breve (Ej: “cerca del colmado”).");
      await redisDel(lockKey);
      return res.sendStatus(200);
    } else {
      userText = message.text?.body || "";
    }

    userText = safeTrim(userText);
    const st = await getState(from);

    // ✅ 0) “Que otras tienes?” -> usar última categoría si existe
    if (isOtherOptionsQuestion(userText)) {
      // si ya tengo un producto seleccionado, uso su categoría
      let cat = st.lastCategory;
      if (!cat && st.productId) {
        const p = getProductById(st.productId);
        if (p?.normCategory) cat = p.normCategory;
      }

      if (cat) {
        const options = listSimilarByCategory(cat, st.productId, 5);

        if (options.length) {
          const lines = options.map((p, i) => `${i + 1}) ${p.name} — ${money(p.price)}`);
          await sendWhatsAppMessage(
            from,
            `Claro mi amor 💗 Aquí tienes más opciones:\n${lines.join("\n")}\n\n¿Cuál te interesa? 😊`
          );
          await redisDel(lockKey);
          return res.sendStatus(200);
        }
      }

      // si no hay categoría, mostramos un mini menú
      const cats = getCategoriesMenu();
      if (cats?.length) {
        await sendWhatsAppMessage(
          from,
          `Claro 😊 ¿Qué te interesa ver?\n${cats.map((c, i) => `${i + 1}) ${c}`).join("\n")}\n\nRespóndeme con el número o el nombre.`
        );
        await redisDel(lockKey);
        return res.sendStatus(200);
      }

      await sendWhatsAppMessage(from, "Mi amor dime el nombre del producto que buscas y te digo precio 😊💗");
      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    // 1) Detectar producto por texto
    const matches = findProducts(userText);

    if (matches.length === 1) {
      const prod = matches[0];

      st.productId = prod.id;
      st.lastCategory = prod.normCategory || st.lastCategory || "otros";
      st.lastProductName = prod.name;
      await redisSet(K.lastprod(from), prod.id);

      // ✅ “como se usa” justo después de mencionar el producto
      if (isUsageQuestion(userText)) {
        // si viene usage en el catálogo
        if (prod.usage && safeTrim(prod.usage).length > 3) {
          await setState(from, st);
          await sendWhatsAppMessage(
            from,
            `Modo de uso 💗\n${safeTrim(prod.usage)}\n\n¿Quieres que te lo reserve? 😊`
          );
          await redisDel(lockKey);
          return res.sendStatus(200);
        }

        // si NO viene usage -> OpenAI con contexto del producto (sin inventar)
        const extraContext = `
Producto del catálogo:
- Nombre: ${prod.name}
- Categoría: ${prod.category || "N/A"}
- Precio: ${prod.price}
Regla: Solo explica modo de uso seguro y general, NO inventes beneficios médicos.
`;
        const history = await getMemory(from);
        const ai = await callOpenAI(history, "¿Cómo se usa este producto?", extraContext);

        const newHistory = [
          ...history,
          { role: "user", content: userText },
          { role: "assistant", content: ai },
        ];
        await saveMemory(from, newHistory);

        await setState(from, st);
        await sendWhatsAppMessage(from, `${ai}\n\n¿Quieres que te lo reserve? 😊`);
        await redisDel(lockKey);
        return res.sendStatus(200);
      }

      // si el user quiere pedir o confirmar, avanzar directo
      const qNorm = normalizeText(userText);
      if (isOrderIntent(userText) || qNorm.includes("quiero") || qNorm.includes("necesito")) {
        st.step = "ASK_QTY";
        await setState(from, st);

        await sendWhatsAppMessage(
          from,
          `Tengo ese 💗\n${prod.name}\nPrecio: ${money(prod.price)} c/u\n¿Cuántos deseas? 😊`
        );
        await redisDel(lockKey);
        return res.sendStatus(200);
      }

      await setState(from, st);

      if (isAskingForImage(userText) && prod.image) {
        await sendWhatsAppImage(from, prod.image, `${prod.name}\nPrecio: ${money(prod.price)}\n¿Lo quieres para pedirlo? 💗`);
        await redisDel(lockKey);
        return res.sendStatus(200);
      }

      await sendWhatsAppMessage(from, `Sí mi amor 💗\n${prod.name}\nPrecio: ${money(prod.price)}\n¿Te lo reservo? 😊`);
      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    // ✅ 1.1) Si el usuario pregunta “cómo se usa” y ya hay producto seleccionado
    if (isUsageQuestion(userText) && st.productId) {
      const prod = getProductById(st.productId);

      if (prod) {
        if (prod.usage && safeTrim(prod.usage).length > 3) {
          await sendWhatsAppMessage(from, `Modo de uso 💗\n${safeTrim(prod.usage)}\n\n¿Te lo reservo? 😊`);
          await redisDel(lockKey);
          return res.sendStatus(200);
        }

        // OpenAI si no hay usage
        const extraContext = `
Producto del catálogo:
- Nombre: ${prod.name}
- Categoría: ${prod.category || "N/A"}
- Precio: ${prod.price}
Regla: Solo explica modo de uso seguro y general.
`;
        const history = await getMemory(from);
        const ai = await callOpenAI(history, userText, extraContext);

        const newHistory = [
          ...history,
          { role: "user", content: userText },
          { role: "assistant", content: ai },
        ];
        await saveMemory(from, newHistory);

        await sendWhatsAppMessage(from, `${ai}\n\n¿Te lo reservo? 😊`);
        await redisDel(lockKey);
        return res.sendStatus(200);
      }
    }

    // 2) Si dice confirmar pedido pero no hay product seleccionado -> usar el lastprod
    if (isOrderIntent(userText) && !st.productId) {
      const last = await redisGet(K.lastprod(from));
      if (last) {
        st.productId = last;
        st.step = "ASK_QTY";
        const prod = getProductById(last);

        if (prod) {
          st.lastCategory = prod.normCategory || st.lastCategory || "otros";
          st.lastProductName = prod.name;

          await setState(from, st);
          await sendWhatsAppMessage(from, `Perfecto mi amor 💗\n${prod.name}\nPrecio: ${money(prod.price)}\n¿Cuántos deseas? 😊`);
          await redisDel(lockKey);
          return res.sendStatus(200);
        }
      }
    }

    // 3) Flujo por estado
    if (isConfirmYes(userText) && st.productId && st.step === "IDLE") {
      st.step = "ASK_QTY";
      await setState(from, st);
      await sendWhatsAppMessage(from, "Perfecto 😊 ¿Cuántos deseas?");
      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    if (st.step === "ASK_QTY") {
      const qty = extractQty(userText) || (isConfirmYes(userText) ? 1 : null);

      if (!qty) {
        await sendWhatsAppMessage(from, "¿Cuántos deseas mi amor? 😊 (Ej: 1, 2, 3)");
        await redisDel(lockKey);
        return res.sendStatus(200);
      }

      st.qty = qty;
      st.step = "ASK_LOCATION";
      await setState(from, st);

      await sendWhatsAppMessage(
        from,
        "Listo ✅\nAhora envíame tu ubicación 📍\n📎 (clip) > Ubicación > Enviar ubicación actual"
      );
      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    if (st.step === "ASK_REFERENCE") {
      const ref = safeTrim(userText);

      if (!ref || normalizeText(ref) === "ubicacion enviada") {
        await sendWhatsAppMessage(from, "Dime una referencia breve mi amor 😊 (Ej: cerca del colmado)");
        await redisDel(lockKey);
        return res.sendStatus(200);
      }

      st.reference = ref;
      st.step = "ASK_PAYMENT";
      await setState(from, st);

      await sendWhatsAppMessage(from, "¿El pago será contra entrega o transferencia? 😊");
      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    if (st.step === "ASK_PAYMENT") {
      const pay = extractPayment(userText);

      if (!pay) {
        await sendWhatsAppMessage(from, "¿Contra entrega o transferencia mi amor? 😊");
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
        `Perfecto ✅\n🛒 Tu pedido:\n- ${st.qty}x ${prod.name}\n💰 Total: ${money(total)}\n¿Confirmas para procesarlo? 😊`
      );
      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    if (st.step === "CONFIRM" && isConfirmYes(userText)) {
      const prod = getProductById(st.productId);
      const total = prod.price * st.qty;

      await sendWhatsAppMessage(from, "Listoo 💗✅\nTu pedido quedó confirmado.\nEn breve te lo coordinamos 😊");

      // admin (nota: puede fallar si el admin no está dentro de ventana o no inició chat)
      let adminText = `📦 NUEVO PEDIDO CONFIRMADO - Glowny Essentials\n\n`;
      adminText += `🛒 ${st.qty}x ${prod.name} — ${money(prod.price)}\n`;
      adminText += `💰 Total: ${money(total)}\n`;
      adminText += `💳 Pago: ${st.payment}\n`;
      adminText += `📍 Referencia: ${st.reference || "No indicada"}\n`;
      adminText += `WhatsApp: ${from}\nhttps://wa.me/${from}\n`;

      if (st.location?.lat && st.location?.lon) {
        adminText += `\n📍 Ubicación:\nhttps://www.google.com/maps?q=${st.location.lat},${st.location.lon}\n`;
      }

      try {
        await sendWhatsAppMessage(ADMIN_PHONE, adminText);
      } catch (e) {
        console.log("⚠️ No se pudo enviar al admin (ventana/permiso).");
      }

      // reset
      await redisDel(K.state(from));
      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    // 4) Si pregunta imagen y ya hay producto seleccionado
    if (isAskingForImage(userText) && st.productId) {
      const prod = getProductById(st.productId);
      if (prod?.image) {
        await sendWhatsAppImage(from, prod.image, `${prod.name}\nPrecio: ${money(prod.price)} 💗`);
        await redisDel(lockKey);
        return res.sendStatus(200);
      }
    }

    // ✅ 5) OpenAI solo si es fuera del tema
    if (shouldUseOpenAI(userText)) {
      const history = await getMemory(from);

      // Contexto suave para que no se vuelva loco
      const extraContext = `
Si el usuario pide recomendaciones, sugiere 1-2 categorías del catálogo y pregunta 1 cosa.
No inventes productos.
`;

      const ai = await callOpenAI(history, userText, extraContext);

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

    // 6) Respuesta por defecto (sin AI)
    await sendWhatsAppMessage(from, "Mi amor dime el nombre del producto y te digo precio 😊💗");
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
