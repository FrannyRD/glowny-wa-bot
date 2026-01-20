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

// Upstash Redis (REST)
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Admin
const ADMIN_PHONE = process.env.ADMIN_PHONE || "18492010239";
const ORDER_TAG = "PEDIDO_CONFIRMADO:";

// Ajustes
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-nano"; // ✅ más barato/rápido. Si quieres mejor: gpt-4.1-mini
const MEMORY_TTL_SECONDS = 60 * 60 * 24; // 24h
const MAX_HISTORY_MESSAGES = 10;

// =============================
// CATÁLOGO (desde catalog.json)
// =============================
let PRODUCTS = [];
let productIndex = [];

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
    console.log("❌ No existe catalog.json en el deploy:", filePath);
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
      // claves extra para mejorar match
      keywords: new Set([
        ...words,
        normalizeText(p.category || ""),
      ]),
    };
  });
}

function loadCatalog() {
  PRODUCTS = loadCatalogFromFile();
  if (!PRODUCTS.length) {
    // Fallback mínimo para no romper
    PRODUCTS = [
      {
        id: "fallback",
        name: "Producto no disponible",
        category: "Otros",
        price: 0,
        image: "",
      },
    ];
  }
  buildIndex();
}
loadCatalog();

// =============================
// UPSTASH HELPERS (REST)
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

  const payload =
    typeof value === "string" ? value : JSON.stringify(value);

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

// Keys
const K = {
  mem: (wa) => `glowny:mem:${wa}`,
  state: (wa) => `glowny:state:${wa}`,
  lastprod: (wa) => `glowny:lastprod:${wa}`,
  pendingLock: (wa) => `glowny:lock:${wa}`, // evita doble respuesta por mensajes seguidos
};

// =============================
// PRODUCT MATCHING (100% catálogo)
// =============================
function findProducts(query) {
  const q = normalizeText(query);
  if (!q) return [];

  const qWords = q.split(" ").filter(Boolean);
  if (qWords.length === 0) return [];

  // Score: coincidencia de palabras + contains
  const scored = productIndex
    .map((p) => {
      let score = 0;

      if (p.normName.includes(q)) score += 10;
      if (q.includes(p.normName)) score += 10;

      // Hits por palabras
      const hits = qWords.filter((w) => p.wordSet.has(w)).length;
      score += hits;

      // Boost si menciona category
      if (p.category && q.includes(normalizeText(p.category))) score += 2;

      return { p, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score);

  // devolver top 3
  return scored.slice(0, 3).map((x) => x.p);
}

function isAskingForImage(text) {
  const q = normalizeText(text);
  return (
    q.includes("foto") ||
    q.includes("imagen") ||
    q.includes("presentacion") ||
    q.includes("muestrame") ||
    q.includes("muestrame") ||
    q.includes("enseñame") ||
    q.includes("ensename") ||
    q.includes("ver el producto")
  );
}

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

function extractQty(text) {
  const q = normalizeText(text);
  const m = q.match(/\b(\d{1,2})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  if (Number.isFinite(n) && n > 0) return n;
  return null;
}

function extractName(text) {
  // super simple
  const t = text || "";
  const m1 = t.match(/me llamo\s+([A-Za-zÁÉÍÓÚÑáéíóúñ ]{2,40})/i);
  if (m1) return m1[1].trim();
  const m2 = t.match(/soy\s+([A-Za-zÁÉÍÓÚÑáéíóúñ ]{2,40})/i);
  if (m2) return m2[1].trim();
  return null;
}

function extractPayment(text) {
  const q = normalizeText(text);
  if (q.includes("contra entrega") || q.includes("efectivo")) return "Contra entrega";
  if (q.includes("transfer")) return "Transferencia";
  return null;
}

// =============================
// OpenAI BACKUP (solo si se sale del flujo)
// =============================
function getSystemPromptShort() {
  return `
Eres una asistente de ventas por WhatsApp de Glowny Essentials (RD).

Reglas:
- Respuestas cortas (1-3 líneas).
- Español dominicano neutro.
- No inventes precios ni productos.
- Si el cliente pregunta algo fuera de productos, responde amable y vuelve a guiar al pedido.
- Usa pocos emojis femeninos.
`;
}

async function callOpenAI(history, userText, extraContext = "") {
  if (!OPENAI_API_KEY) {
    return "Ahora mismo no puedo responder eso 😥 ¿Me dices qué producto te interesa?";
  }

  const messages = [
    { role: "system", content: getSystemPromptShort() + extraContext },
    ...history,
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
      return "Dame 5 segunditos 🙏 y me lo repites porfa.";
    }
    return "Ahora mismo tuve un error 😥 ¿Me lo repites?";
  }

  return (
    data.choices?.[0]?.message?.content?.trim() ||
    "¿Me lo repites? 😊"
  );
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
// HEALTH CHECK (para ver catálogo cargado)
// =============================
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    products: PRODUCTS.length,
    model: MODEL,
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
    console.log("✅ Webhook verificado");
    return res.status(200).send(challenge);
  }

  console.log("❌ Error verificando webhook");
  return res.sendStatus(403);
});

// =============================
// MAIN FLOW (estado de pedido)
// =============================
async function getState(wa) {
  const st = (await redisGet(K.state(wa))) || {};
  return {
    step: st.step || "IDLE", // IDLE | PRODUCT_SELECTED | ASK_QTY | ASK_LOCATION | ASK_REFERENCE | ASK_PAYMENT | CONFIRM
    productId: st.productId || null,
    qty: st.qty || 1,
    name: st.name || null,
    reference: st.reference || null,
    payment: st.payment || null,
    location: st.location || null, // {lat,lon,address,name}
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

function getProductById(id) {
  return PRODUCTS.find((p) => p.id === id) || null;
}

function money(n) {
  return `RD$${Number(n || 0).toLocaleString("en-US")}`;
}

// =============================
// ADMIN ORDER TEXT
// =============================
function buildAdminOrderText(from, prod, st) {
  const subtotal = prod.price * st.qty;

  let text = `📦 NUEVO PEDIDO CONFIRMADO - Glowny Essentials\n\n`;
  text += `🛒 Producto:\n- ${st.qty}x ${prod.name} — ${money(prod.price)} (Sub: ${money(subtotal)})\n\n`;
  text += `💰 Total: ${money(subtotal)}\n`;
  text += `💳 Pago: ${st.payment || "No indicado"}\n`;
  if (st.name) text += `👤 Nombre: ${st.name}\n`;
  if (st.reference) text += `📍 Referencia: ${st.reference}\n`;

  text += `\n📲 WhatsApp cliente: ${from}\n`;
  text += `Abrir chat: https://wa.me/${from}\n`;

  if (st.location?.lat && st.location?.lon) {
    text += `\n🗺️ Ubicación:\nGoogle Maps: https://www.google.com/maps?q=${st.location.lat},${st.location.lon}\n`;
    if (st.location.address) text += `Dirección mapa: ${st.location.address}\n`;
    if (st.location.name) text += `Nombre ubicación: ${st.location.name}\n`;
  }

  return text;
}

// =============================
// WEBHOOK RECEIVE
// =============================
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const message = value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    let userText = "";

    // 🔒 Mini lock (evita doble respuesta si entran 2 mensajes rápidos)
    const lockKey = K.pendingLock(from);
    const existingLock = await redisGet(lockKey);
    if (existingLock) return res.sendStatus(200);
    await redisSet(lockKey, "1", 3); // lock 3s

    // Location message
    if (message.type === "location" && message.location) {
      const loc = message.location;
      userText = "📍 Ubicación enviada";

      const st = await getState(from);
      st.location = {
        lat: loc.latitude,
        lon: loc.longitude,
        address: loc.address || "",
        name: loc.name || "",
      };

      // si estamos esperando ubicación, pasamos al siguiente paso
      if (st.step === "ASK_LOCATION") {
        st.step = "ASK_REFERENCE";
      }

      await setState(from, st);
    } else {
      userText = message.text?.body || "";
    }

    const st = await getState(from);

    // Guardar nombre si lo detecta
    const possibleName = extractName(userText);
    if (possibleName && !st.name) {
      st.name = possibleName;
      await setState(from, st);
    }

    // Guardar pago si lo detecta
    const pay = extractPayment(userText);
    if (pay) {
      st.payment = pay;
      await setState(from, st);
    }

    // =============================
    // 1) Si el user pregunta por producto
    // =============================
    const matches = findProducts(userText);

    // Si pidió imagen y ya hay producto seleccionado
    if (isAskingForImage(userText) && st.productId) {
      const prod = getProductById(st.productId);
      if (prod?.image) {
        await sendWhatsAppImage(
          from,
          prod.image,
          `${prod.name}\nPrecio: ${money(prod.price)}\n¿Lo quieres para pedirlo? 💗`
        );
        await redisDel(lockKey);
        return res.sendStatus(200);
      }
    }

    // Si el mensaje menciona un producto claramente -> lo seleccionamos
    if (matches.length === 1) {
      const prod = matches[0];
      st.productId = prod.id;
      await redisSet(K.lastprod(from), prod.id);

      // Si estaba idle, lo movemos a pedir confirmación/cantidad
      if (st.step === "IDLE") st.step = "PRODUCT_SELECTED";
      await setState(from, st);

      // Respuesta directa, SIN OpenAI
      // Si preguntó precio o “quiero” -> directo reservar y pedir qty
      const q = normalizeText(userText);
      const wantsOrder =
        q.includes("quiero") ||
        q.includes("necesito") ||
        q.includes("pedido") ||
        q.includes("ordenar") ||
        q.includes("reservar");

      // si pregunta por imagen, envíala
      if (isAskingForImage(userText) && prod.image) {
        await sendWhatsAppImage(
          from,
          prod.image,
          `${prod.name}\nPrecio: ${money(prod.price)}\n¿Lo quieres para pedirlo? 💗`
        );
        await redisDel(lockKey);
        return res.sendStatus(200);
      }

      if (wantsOrder) {
        st.step = "ASK_QTY";
        await setState(from, st);

        await sendWhatsAppMessage(
          from,
          `Tengo ese 💗\n${prod.name}\nPrecio: ${money(prod.price)} c/u\n¿Cuántos deseas? 😊`
        );
      } else {
        await sendWhatsAppMessage(
          from,
          `Sí mi amor 💗\n${prod.name}\nPrecio: ${money(prod.price)}\n¿Te lo reservo? 😊`
        );
      }

      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    // Si hay varios matches, pedimos aclaración
    if (matches.length > 1) {
      const list = matches
        .map((p, i) => `${i + 1}) ${p.name} — ${money(p.price)}`)
        .join("\n");

      await sendWhatsAppMessage(
        from,
        `¿Cuál de estos quieres? 💗\n${list}\n\nRespóndeme con 1, 2 o 3 😊`
      );

      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    // =============================
    // 2) Flujo por estado (evita repetirse)
    // =============================
    // Si el bot preguntó “¿te lo reservo?” y el user dice SI
    if (st.step === "PRODUCT_SELECTED" && isConfirmYes(userText)) {
      // si no tiene producto, intenta con el último visto
      if (!st.productId) {
        const last = await redisGet(K.lastprod(from));
        if (last) st.productId = last;
      }

      const prod = getProductById(st.productId);
      if (prod) {
        st.step = "ASK_QTY";
        await setState(from, st);
        await sendWhatsAppMessage(from, `Perfecto 😊 ¿Cuántos deseas?`);
        await redisDel(lockKey);
        return res.sendStatus(200);
      }
    }

    // Cantidad
    if (st.step === "ASK_QTY") {
      const qty = extractQty(userText) || (isConfirmYes(userText) ? 1 : null);

      if (!qty) {
        await sendWhatsAppMessage(from, `¿Cuántos deseas mi amor? 😊 (Ej: 1, 2, 3)`);
        await redisDel(lockKey);
        return res.sendStatus(200);
      }

      st.qty = qty;
      st.step = "ASK_LOCATION";
      await setState(from, st);

      await sendWhatsAppMessage(
        from,
        `Listo ✅\nAhora envíame tu ubicación por WhatsApp 📍\n📎 (clip) > Ubicación > Enviar ubicación actual`
      );

      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    // Referencia (solo una)
    if (st.step === "ASK_REFERENCE") {
      if (!st.location) {
        st.step = "ASK_LOCATION";
        await setState(from, st);
        await sendWhatsAppMessage(
          from,
          `Mi amor envíame tu ubicación por el botón 📍\n📎 > Ubicación > Enviar ubicación actual`
        );
        await redisDel(lockKey);
        return res.sendStatus(200);
      }

      // aquí el user debe mandar referencia
      const ref = (userText || "").trim();
      if (!ref || normalizeText(ref) === "ubicacion enviada") {
        await sendWhatsAppMessage(
          from,
          `Perfecto 😊 Ahora solo dime una referencia breve (Ej: “cerca del colmado…”).`
        );
        await redisDel(lockKey);
        return res.sendStatus(200);
      }

      st.reference = ref;
      st.step = "ASK_PAYMENT";
      await setState(from, st);

      await sendWhatsAppMessage(
        from,
        `Gracias 💗\n¿El pago será contra entrega o transferencia? 😊`
      );

      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    // Pago
    if (st.step === "ASK_PAYMENT") {
      const payment = extractPayment(userText);

      if (!payment) {
        await sendWhatsAppMessage(
          from,
          `¿Contra entrega o transferencia mi amor? 😊`
        );
        await redisDel(lockKey);
        return res.sendStatus(200);
      }

      st.payment = payment;
      st.step = "CONFIRM";
      await setState(from, st);

      const prod = getProductById(st.productId);
      if (!prod) {
        await sendWhatsAppMessage(from, `No pude encontrar el producto 😥 ¿Cuál deseas?`);
        st.step = "IDLE";
        st.productId = null;
        await setState(from, st);
        await redisDel(lockKey);
        return res.sendStatus(200);
      }

      const total = prod.price * st.qty;

      await sendWhatsAppMessage(
        from,
        `Perfecto mi amor ✅\n🛒 Tu pedido:\n- ${st.qty}x ${prod.name}\n💰 Total: ${money(total)}\n¿Confirmas para procesarlo? 😊`
      );

      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    // Confirmación final
    if (st.step === "CONFIRM" && isConfirmYes(userText)) {
      const prod = getProductById(st.productId);
      if (!prod) {
        await sendWhatsAppMessage(from, `No pude confirmar 😥 ¿Cuál producto deseas?`);
        st.step = "IDLE";
        st.productId = null;
        await setState(from, st);
        await redisDel(lockKey);
        return res.sendStatus(200);
      }

      // Mensaje al cliente
      await sendWhatsAppMessage(
        from,
        `Listoo 💗✅\nTu pedido quedó confirmado.\nEn breve te lo coordinamos 😊`
      );

      // Mensaje al admin
      const adminText = buildAdminOrderText(from, prod, st);
      await sendWhatsAppMessage(ADMIN_PHONE, adminText);

      // reset estado
      await redisDel(K.state(from));
      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    // Si el user escribe pero está en confirm y no confirma
    if (st.step === "CONFIRM" && !isConfirmYes(userText)) {
      await sendWhatsAppMessage(from, `¿Confirmas mi amor? 😊 (Responde “sí”)`);
      await redisDel(lockKey);
      return res.sendStatus(200);
    }

    // =============================
    // 3) FALLBACK OPENAI (si escribe algo raro)
    // =============================
    const history = await getMemory(from);

    // Extra context si hay producto seleccionado
    let extraContext = "";
    if (st.productId) {
      const prod = getProductById(st.productId);
      if (prod) {
        extraContext = `\nProducto seleccionado:\n${prod.name}\nPrecio: ${money(prod.price)}\n`;
      }
    }

    const aiReply = await callOpenAI(history, userText, extraContext);

    // Guardar memoria
    const newHistory = [
      ...history,
      { role: "user", content: userText },
      { role: "assistant", content: aiReply },
    ];
    await saveMemory(from, newHistory);

    await sendWhatsAppMessage(from, aiReply);

    await redisDel(lockKey);
    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error en /webhook:", err);
    return res.sendStatus(200);
  }
});

// =============================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Bot corriendo en puerto ${PORT}`);
});
