const express = require("express");
const fs = require("fs");
const path = require("path");

const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json());

// =========================
// ENV
// =========================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "glowny_verify";
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const ADMIN_PHONE = "18492010239"; // tu numero admin sin +
const ORDER_TAG = "PEDIDO_CONFIRMADO:";

// Upstash
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Catálogo
const CATALOG_URL = process.env.CATALOG_URL || ""; // opcional

// =========================
// Redis Helpers (Upstash)
// =========================
async function redisGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;

  const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });

  const data = await r.json();
  return data?.result ?? null;
}

async function redisSet(key, value, ttlSeconds = 86400) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;

  // set + expire
  await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(value),
  });

  await fetch(`${UPSTASH_URL}/expire/${encodeURIComponent(key)}/${ttlSeconds}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
}

// =========================
// Text utils
// =========================
function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isYes(text) {
  const t = normalizeText(text);
  return (
    t === "si" ||
    t === "sí" ||
    t.includes("claro") ||
    t.includes("ok") ||
    t.includes("dale") ||
    t.includes("de acuerdo") ||
    t.includes("confirmo") ||
    t.includes("confirmar") ||
    t.includes("quiero") ||
    t.includes("lo quiero") ||
    t.includes("reservame") ||
    t.includes("resérvame") ||
    t.includes("realizar el pedido") ||
    t.includes("hacer el pedido") ||
    t.includes("hacer mi pedido") ||
    t.includes("ordenar") ||
    t.includes("comprar") ||
    t.includes("pedirlo")
  );
}

function isNo(text) {
  const t = normalizeText(text);
  return t.includes("no") || t.includes("despues") || t.includes("luego");
}

function detectQty(text) {
  const t = normalizeText(text);

  // si manda "1", "2", "3"
  const n = parseInt(t, 10);
  if (!isNaN(n) && n > 0 && n <= 50) return n;

  // si manda "una", "dos"
  if (t.includes("una")) return 1;
  if (t.includes("dos")) return 2;
  if (t.includes("tres")) return 3;

  return null;
}

function isAskingForImage(text) {
  const t = normalizeText(text);
  return (
    t.includes("foto") ||
    t.includes("imagen") ||
    t.includes("ver") ||
    t.includes("muestrame") ||
    t.includes("muéstrame") ||
    t.includes("ensename") ||
    t.includes("enséñame") ||
    t.includes("presentacion") ||
    t.includes("presentación")
  );
}

// =========================
// Catalog Loader
// =========================
let PRODUCTS = [];
let productIndex = []; // cache normalize names

async function loadCatalog() {
  try {
    // 1) si hay URL externa (Supabase / CDN)
    if (CATALOG_URL) {
      const r = await fetch(CATALOG_URL);
      const data = await r.json();
      if (Array.isArray(data) && data.length > 0) {
        PRODUCTS = data;
      }
    }

    // 2) si no hay URL o falla, lee catalog.json local
    if (!PRODUCTS.length) {
      const filePath = path.join(__dirname, "catalog.json");
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8");
        const data = JSON.parse(raw);
        if (Array.isArray(data) && data.length > 0) {
          PRODUCTS = data;
        }
      }
    }

    // 3) fallback mínimo (solo para que no crashee)
    if (!PRODUCTS.length) {
      PRODUCTS = [
        {
          id: "5161a1bf-a837-4d3f-a589-d1987aea4c91",
          name: "Colágeno soluble sabor limón Colagen complemento alimenticio Deliplus 250 g",
          category: "Suplementos",
          price: 900,
          image:
            "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7143289581985477.jpg",
        },
      ];
    }

    // Index rápido
    productIndex = PRODUCTS.map((p) => ({
      ...p,
      normName: normalizeText(p.name),
      tokens: new Set(normalizeText(p.name).split(" ").filter(Boolean)),
    }));

    console.log(`✅ Catálogo cargado: ${PRODUCTS.length} productos`);
  } catch (err) {
    console.error("❌ Error cargando catálogo:", err);
  }
}

function findBestProduct(queryText) {
  const q = normalizeText(queryText);
  if (!q) return null;

  // match directo por contains
  let best = null;
  let bestScore = 0;

  const qWords = q.split(" ").filter(Boolean);

  for (const p of productIndex) {
    let score = 0;

    // contains completo
    if (p.normName.includes(q) || q.includes(p.normName)) score += 15;

    // score por palabras
    const hits = qWords.filter((w) => p.tokens.has(w)).length;
    score += hits;

    // bonus si menciona marca / keyword importante
    if (q.includes("colageno") && p.normName.includes("colageno")) score += 5;
    if (q.includes("rosa mosqueta") && p.normName.includes("rosa mosqueta"))
      score += 6;

    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  // minimo para evitar que confunda magnesio con colágeno
  if (bestScore >= 3) return best;
  return null;
}

function compactProductLine(p) {
  return `${p.name} — RD$${p.price}`;
}

// =========================
// WhatsApp Senders
// =========================
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WA_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  console.log("📩 WhatsApp:", JSON.stringify(data, null, 2));
}

async function sendWhatsAppImage(to, imageUrl, caption = "") {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { link: imageUrl, caption },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  console.log("🖼 WhatsApp IMG:", JSON.stringify(data, null, 2));
}

// =========================
// Order State (Upstash)
// =========================
function memKey(phone) {
  return `glowny:mem:${phone}`;
}
function stateKey(phone) {
  return `glowny:state:${phone}`;
}
function lastReplyKey(phone) {
  return `glowny:lastreply:${phone}`;
}

async function getState(phone) {
  const raw = await redisGet(stateKey(phone));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function setState(phone, state) {
  await redisSet(stateKey(phone), JSON.stringify(state), 60 * 60 * 24);
}

async function clearState(phone) {
  await redisSet(stateKey(phone), "", 10);
}

async function getMemory(phone) {
  const raw = await redisGet(memKey(phone));
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveMemory(phone, history) {
  // guarda max 8 turnos
  const short = history.slice(-8);
  await redisSet(memKey(phone), JSON.stringify(short), 60 * 60 * 24);
}

async function getLastReply(phone) {
  const r = await redisGet(lastReplyKey(phone));
  return r || "";
}

async function setLastReply(phone, reply) {
  await redisSet(lastReplyKey(phone), reply, 60 * 60 * 12);
}

// =========================
// OpenAI (solo fallback)
// =========================
function systemPrompt() {
  return `
Eres una asistente de ventas por WhatsApp de Glowny Essentials (RD).
Responde corto, claro y directo (1-3 líneas).
Si el cliente escribe algo raro o fuera de productos/pedidos, contesta amable y vuelve al pedido.

IMPORTANTE:
- No inventes precios.
- Si no entiendes el producto: pide que escriba el nombre.
`;
}

async function callOpenAI(phone, userText) {
  const history = await getMemory(phone);

  const messages = [
    { role: "system", content: systemPrompt() },
    ...history,
    { role: "user", content: userText },
  ];

  const payload = {
    model: "gpt-4.1-mini",
    temperature: 0.2,
    max_tokens: 180,
    messages,
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await r.json();

  if (!r.ok) {
    const code = data?.error?.code || "";
    if (code === "rate_limit_exceeded") {
      return "Dame 5 segunditos 🙏 y me lo repites.";
    }
    return "Ay amor 😥 tuve un error… ¿me lo repites?";
  }

  const reply = data.choices?.[0]?.message?.content?.trim() || "¿Me lo repites?";

  const newHistory = [
    ...history,
    { role: "user", content: userText },
    { role: "assistant", content: reply },
  ];
  await saveMemory(phone, newHistory);

  return reply;
}

// =========================
// Main Logic (sin perderse)
// =========================
async function handleMessage(phone, text, locationObj = null) {
  const userText = text || "";
  const norm = normalizeText(userText);

  // 1) cargar estado
  let state = await getState(phone);
  if (!state) {
    state = {
      step: "idle",
      name: "",
      items: [],
      reference: "",
      payment: "",
      location: null,
      lastProductId: "",
    };
  }

  // 2) si manda ubicación
  if (locationObj) {
    state.location = {
      latitude: locationObj.latitude,
      longitude: locationObj.longitude,
      address: locationObj.address || "",
      name: locationObj.name || "",
    };
    if (state.step === "ask_location") {
      state.step = "ask_reference";
      await setState(phone, state);
      return "Perfecto 💗 ahora dime una referencia cortita (ej: Edificio L, apto 3B).";
    }
  }

  // 3) detectar producto por texto
  const product = findBestProduct(userText);
  if (product) {
    state.lastProductId = product.id;
  }

  // 4) si pide imagen y tenemos producto
  if (isAskingForImage(userText) && state.lastProductId) {
    const prod = PRODUCTS.find((p) => p.id === state.lastProductId);
    if (prod?.image) {
      await setState(phone, state);
      return { type: "image", url: prod.image, caption: `${prod.name}\nRD$${prod.price}\n¿Te reservo 1? 💗` };
    }
  }

  // =========================
  // FLOW DE PEDIDO
  // =========================
  if (state.step === "idle") {
    // si preguntó por un producto
    if (product) {
      await setState(phone, state);
      return `Tengo este 💗\n${product.name}\nPrecio: RD$${product.price}\n¿Te reservo 1? 😊`;
    }

    // si solo dijo "hola"
    if (norm === "hola" || norm.includes("buenas") || norm.includes("buenos")) {
      await setState(phone, state);
      return "¡Hola! 💗 ¿Qué producto estás buscando hoy?";
    }

    // fallback openai
    const ai = await callOpenAI(phone, userText);
    return ai;
  }

  // Si ya está eligiendo producto:
  // Si dijo que sí a reservar
  if (state.step === "idle" && isYes(userText) && state.lastProductId) {
    const prod = PRODUCTS.find((p) => p.id === state.lastProductId);
    if (prod) {
      state.step = "ask_qty";
      state.items = [{ id: prod.id, name: prod.name, price: prod.price, qty: 1 }];
      await setState(phone, state);
      return "¿Cuántas unidades deseas? 😊";
    }
  }

  // Si el último mensaje fue producto y el cliente dice "sí"
  if (isYes(userText) && state.lastProductId && state.step === "idle") {
    const prod = PRODUCTS.find((p) => p.id === state.lastProductId);
    if (prod) {
      state.step = "ask_qty";
      state.items = [{ id: prod.id, name: prod.name, price: prod.price, qty: 1 }];
      await setState(phone, state);
      return "¿Cuántas unidades deseas? 😊";
    }
  }

  // ask_qty
  if (state.step === "ask_qty") {
    const qty = detectQty(userText);
    if (!qty) {
      await setState(phone, state);
      return "Dime la cantidad en número porfa 😊 (ej: 1, 2, 3)";
    }
    // aplicar qty
    if (state.items?.length) state.items[0].qty = qty;

    state.step = state.name ? "ask_location" : "ask_name";
    await setState(phone, state);

    if (!state.name) return "Perfecto 💗 ¿Me dices tu nombre completo?";
    return "Perfecto 💗 Envíame tu ubicación por WhatsApp 📎 > Ubicación > Enviar ubicación actual.";
  }

  // ask_name
  if (state.step === "ask_name") {
    if (userText.length < 3) {
      await setState(phone, state);
      return "¿Me escribes tu nombre completo porfa? 💗";
    }
    state.name = userText.trim();
    state.step = "ask_location";
    await setState(phone, state);
    return "Listo 💗 ahora envíame tu ubicación por WhatsApp 📎 > Ubicación > Enviar ubicación actual.";
  }

  // ask_location
  if (state.step === "ask_location") {
    await setState(phone, state);
    return "Envíame tu ubicación por el botón 📎 > Ubicación > Enviar ubicación actual 📍";
  }

  // ask_reference
  if (state.step === "ask_reference") {
    state.reference = userText.trim();
    state.step = "ask_payment";
    await setState(phone, state);
    return "¿El pago será contra entrega o transferencia? 😊";
  }

  // ask_payment
  if (state.step === "ask_payment") {
    const t = normalizeText(userText);
    if (!(t.includes("contra") || t.includes("transfer"))) {
      await setState(phone, state);
      return "Solo dime: *contra entrega* o *transferencia* 😊";
    }

    state.payment = t.includes("contra") ? "Contra entrega" : "Transferencia";
    state.step = "confirm";
    await setState(phone, state);

    const item = state.items?.[0];
    const total = item ? item.price * item.qty : 0;

    return (
      `Perfecto ${state.name} ✅\n` +
      `🛒 Pedido:\n- ${item.qty}x ${item.name} — RD$${item.price}\n` +
      `💰 Total: RD$${total}\n` +
      `📍 Ref: ${state.reference}\n` +
      `💳 Pago: ${state.payment}\n` +
      `¿Confirmas para procesarlo? 😊`
    );
  }

  // confirm
  if (state.step === "confirm") {
    if (!isYes(userText)) {
      await setState(phone, state);
      return "Está bien 💗 ¿Qué deseas cambiar del pedido?";
    }

    // enviar al admin con ORDER_TAG + JSON
    const item = state.items?.[0];
    const total = item ? item.price * item.qty : 0;

    let adminText =
      "📦 NUEVO PEDIDO CONFIRMADO - Glowny Essentials\n\n" +
      `👤 Cliente: ${state.name}\n` +
      `🛒 ${item.qty}x ${item.name} — RD$${item.price}\n` +
      `💰 Total: RD$${total}\n` +
      `📍 Ref: ${state.reference}\n` +
      `💳 Pago: ${state.payment}\n` +
      `📲 WhatsApp: ${phone}\n` +
      `Abrir chat: https://wa.me/${phone}`;

    if (state.location) {
      adminText +=
        "\n\n📍 Ubicación:\n" +
        `https://www.google.com/maps?q=${state.location.latitude},${state.location.longitude}\n` +
        (state.location.address ? `Dirección: ${state.location.address}\n` : "");
    }

    await sendWhatsAppMessage(ADMIN_PHONE, adminText);

    // limpiar estado
    await clearState(phone);

    return (
      "Listo mi amor ✅💗 tu pedido fue confirmado.\n" +
      "En breve te escribimos para coordinar la entrega 😊"
    );
  }

  // fallback final
  const ai = await callOpenAI(phone, userText);
  return ai;
}

// =========================
// Webhook Verify (GET)
// =========================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// =========================
// Webhook Receive (POST)
// =========================
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const message = value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    let text = "";
    let locationObj = null;

    if (message.type === "location" && message.location) {
      locationObj = {
        latitude: message.location.latitude,
        longitude: message.location.longitude,
        name: message.location.name || "",
        address: message.location.address || "",
      };
      text = "Ubicación enviada";
    } else {
      text = message.text?.body || "";
    }

    // evitar respuestas repetidas exactas
    const reply = await handleMessage(from, text, locationObj);

    const last = await getLastReply(from);

    // Si reply es imagen
    if (typeof reply === "object" && reply.type === "image") {
      await sendWhatsAppImage(from, reply.url, reply.caption);
      await setLastReply(from, reply.caption);
      return res.sendStatus(200);
    }

    // Si es texto
    if (reply && reply !== last) {
      await sendWhatsAppMessage(from, reply);
      await setLastReply(from, reply);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error webhook:", err);
    return res.sendStatus(200);
  }
});

// =========================
// Start
// =========================
const PORT = process.env.PORT || 10000;

loadCatalog().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Bot corriendo en puerto ${PORT}`);
  });
});
