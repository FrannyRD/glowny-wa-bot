const express = require("express");
const crypto = require("crypto");

// node-fetch dinámico (Render friendly)
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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-nano"; // ✅ recomendado

// ✅ ADMIN donde llegan pedidos listos (sin +)
const ADMIN_PHONE = process.env.ADMIN_PHONE || "18492010239";

// ✅ Upstash Redis
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// TTLs
const MEM_TTL_SECONDS = 60 * 60 * 24; // 24h
const PENDING_TTL_SECONDS = 60 * 60 * 24; // 24h
const PROFILE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 días
const REPLY_TTL_SECONDS = 60 * 10; // 10 min anti-loop

// Tag interno (si quieres enviarlo al admin)
const ORDER_TAG = "PEDIDO_CONFIRMADO:";

// =============================
// CATÁLOGO (Tu JSON)
// =============================
const PRODUCTS = [
  {
    id: "0333fadc-c608-4c6e-a8d4-67d7a3ed117e",
    name: "Crema corporal hidratante Esferas VIT - E Deliplus con ácido hialurónico",
    price: 550,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.47356556525844695.jpg",
  },
  {
    id: "0552881d-7395-4d9e-8d60-10e01a879e10",
    name: "Comprimidos efervescentes magnesio Deliplus 300 mg sabor naranja vitaminas B1, B6 y B12 20und/80g",
    price: 400,
    category: "Suplementos",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.6344341855892877.jpg",
  },
  {
    id: "0e290ffc-c710-40b8-8409-206466bc5217",
    name: "Aceite corporal rosa mosqueta Deliplus 100% puro y natural 30 ml",
    price: 950,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.01851007574591812.jpg",
  },
  {
    id: "104666b4-2391-4ba9-be6b-68fa012f630e",
    name: "Crema protección solar facial Deliplus FPS 50+ resistente al agua 50 ml",
    price: 700,
    category: "Rostro",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.07349553219793581.jpg",
  },
  {
    id: "5161a1bf-a837-4d3f-a589-d1987aea4c91",
    name: "Colágeno soluble sabor limón Colagen complemento alimenticio Deliplus 250 g",
    price: 900,
    category: "Suplementos",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7143289581985477.jpg",
  },
  {
    id: "8eb7cdea-a920-489a-97ad-60f3ec58497a",
    name: "Comprimidos efervescentes vitamina C y zinc Deliplus sabor limón 20und/80g",
    price: 400,
    category: "Suplementos",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7343292665638652.jpg",
  },
  // ✅ (Puedes seguir pegando el resto igual)
];

// =============================
// ALIAS (para que no confunda colágeno con magnesio)
// =============================
const PRODUCT_ALIASES = [
  { key: "colageno", productId: "5161a1bf-a837-4d3f-a589-d1987aea4c91" },
  { key: "colágeno", productId: "5161a1bf-a837-4d3f-a589-d1987aea4c91" },
  { key: "rosa mosqueta", productId: "0e290ffc-c710-40b8-8409-206466bc5217" },
  { key: "protector solar facial", productId: "104666b4-2391-4ba9-be6b-68fa012f630e" },
  { key: "magnesio", productId: "0552881d-7395-4d9e-8d60-10e01a879e10" },
  { key: "vitamina c", productId: "8eb7cdea-a920-489a-97ad-60f3ec58497a" },
];

// =============================
// HELPERS
// =============================
function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function parseQty(text) {
  const t = normalizeText(text);
  // busca "1", "2", etc
  const m = t.match(/\b(\d{1,2})\b/);
  if (m) return Math.max(1, Math.min(99, parseInt(m[1], 10)));

  // palabras comunes
  if (t.includes("una") || t.includes("un ")) return 1;
  if (t.includes("dos")) return 2;
  if (t.includes("tres")) return 3;

  return null;
}

function isYes(text) {
  const t = normalizeText(text);
  return (
    t === "si" ||
    t === "sí" ||
    t.includes("claro") ||
    t.includes("dale") ||
    t.includes("ok") ||
    t.includes("perfecto") ||
    t.includes("confirmo") ||
    t.includes("confirmar") ||
    t.includes("lo quiero") ||
    t.includes("quiero ese") ||
    t.includes("reserva") ||
    t.includes("reservalo")
  );
}

function isNo(text) {
  const t = normalizeText(text);
  return t === "no" || t.includes("no gracias") || t.includes("despues");
}

function isPaymentMessage(text) {
  const t = normalizeText(text);
  return (
    t.includes("contra entrega") ||
    t.includes("contraentrega") ||
    t.includes("transferencia") ||
    t.includes("transfer") ||
    t.includes("deposito") ||
    t.includes("depósito") ||
    t.includes("tarjeta")
  );
}

function isAskingForImage(text) {
  const q = normalizeText(text);
  return (
    q.includes("foto") ||
    q.includes("imagen") ||
    q.includes("presentacion") ||
    q.includes("presentación") ||
    q.includes("ver") ||
    q.includes("muestrame") ||
    q.includes("muestra") ||
    q.includes("ensename") ||
    q.includes("enseñame")
  );
}

// Match product by aliases first, then by fuzzy words
function findProduct(text) {
  const q = normalizeText(text);
  if (!q) return null;

  // 1) Alias exactos
  for (const a of PRODUCT_ALIASES) {
    if (q.includes(normalizeText(a.key))) {
      const p = PRODUCTS.find((x) => x.id === a.productId);
      if (p) return p;
    }
  }

  // 2) Fuzzy por palabras
  let best = null;
  let bestScore = 0;

  const qWords = q.split(" ").filter(Boolean);

  for (const p of PRODUCTS) {
    const name = normalizeText(p.name);
    const nameWords = new Set(name.split(" ").filter(Boolean));
    let score = 0;

    // contains fuerte
    if (name.includes(q)) score += 6;

    // words hits
    const hits = qWords.filter((w) => w.length >= 4 && nameWords.has(w)).length;
    score += hits;

    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  if (bestScore >= 2) return best;
  return null;
}

// =============================
// UPSTASH REDIS (REST)
// =============================
async function upstashCmd(cmd, ...args) {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) return null;

  const path = [cmd, ...args].map((x) => encodeURIComponent(String(x))).join("/");
  const url = `${UPSTASH_REDIS_REST_URL}/${path}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
    },
  });

  const data = await resp.json();
  return data;
}

async function redisGet(key) {
  const r = await upstashCmd("get", key);
  return r?.result ?? null;
}

async function redisSet(key, value, ttlSec) {
  // set key value
  await upstashCmd("set", key, value);
  if (ttlSec) await upstashCmd("expire", key, ttlSec);
}

async function redisDel(key) {
  await upstashCmd("del", key);
}

function kMem(wa) {
  return `glowny:mem:${wa}`;
}
function kPending(wa) {
  return `glowny:pending:${wa}`;
}
function kProfile(wa) {
  return `glowny:profile:${wa}`;
}
function kLoc(wa) {
  return `glowny:loc:${wa}`;
}
function kLastProd(wa) {
  return `glowny:lastprod:${wa}`;
}
function kLastReply(wa) {
  return `glowny:lastreply:${wa}`;
}

// =============================
// DATA LAYERS
// =============================
async function getMemory(wa) {
  const raw = await redisGet(kMem(wa));
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function setMemory(wa, arr) {
  const limited = Array.isArray(arr) ? arr.slice(-10) : [];
  await redisSet(kMem(wa), JSON.stringify(limited), MEM_TTL_SECONDS);
}

async function appendToMemory(wa, role, content) {
  const mem = await getMemory(wa);
  mem.push({ role, content });
  await setMemory(wa, mem);
}

async function getPending(wa) {
  const raw = await redisGet(kPending(wa));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function setPending(wa, obj) {
  await redisSet(kPending(wa), JSON.stringify(obj), PENDING_TTL_SECONDS);
}

async function clearPending(wa) {
  await redisDel(kPending(wa));
}

async function getProfile(wa) {
  const raw = await redisGet(kProfile(wa));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function setProfile(wa, profile) {
  await redisSet(kProfile(wa), JSON.stringify(profile), PROFILE_TTL_SECONDS);
}

async function getLastLocation(wa) {
  const raw = await redisGet(kLoc(wa));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function setLastLocation(wa, loc) {
  await redisSet(kLoc(wa), JSON.stringify(loc), MEM_TTL_SECONDS);
}

async function getLastProductSeen(wa) {
  const raw = await redisGet(kLastProd(wa));
  return raw || null;
}

async function setLastProductSeen(wa, productId) {
  await redisSet(kLastProd(wa), String(productId), MEM_TTL_SECONDS);
}

async function preventSameReply(wa, replyText) {
  // devuelve true si es repetido (y lo bloquea)
  const lastHash = await redisGet(kLastReply(wa));
  const nowHash = sha1(replyText);

  if (lastHash && lastHash === nowHash) {
    return true;
  }

  await redisSet(kLastReply(wa), nowHash, REPLY_TTL_SECONDS);
  return false;
}

// =============================
// WhatsApp Senders
// =============================
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
  console.log("WhatsApp send text:", JSON.stringify(data, null, 2));
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
  console.log("WhatsApp send image:", JSON.stringify(data, null, 2));
}

// ✅ Botón nativo: pedir ubicación
async function sendWhatsAppLocationRequest(to) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "location_request_message",
      body: {
        text: "📍 Para entregarte, envíame tu ubicación tocando el botón de abajo 💗",
      },
      action: {
        name: "send_location",
      },
    },
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
  console.log("WhatsApp location request:", JSON.stringify(data, null, 2));
}

// =============================
// OpenAI (solo fallback)
// =============================
function getFallbackSystemPrompt() {
  return `
Eres una asistente de ventas de Glowny Essentials (RD).
Responde corto (1-3 líneas).
Si el cliente pregunta cosas fuera del catálogo, explica breve y guía a pedir.
No inventes precios.
Si no entiendes, pide que lo repita.
`;
}

async function callOpenAI(waNumber, userText) {
  if (!OPENAI_API_KEY) {
    return "Mi amor 💗 ¿me lo repites más claro para ayudarte mejor?";
  }

  const history = await getMemory(waNumber);

  const messages = [
    { role: "system", content: getFallbackSystemPrompt() },
    ...history.slice(-6),
    { role: "user", content: userText },
  ];

  const payload = {
    model: OPENAI_MODEL,
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
    console.log("OpenAI error:", JSON.stringify(data, null, 2));
    return "Dame 5 segunditos 🙏 y me lo repites.";
  }

  const reply =
    data.choices?.[0]?.message?.content ||
    "Mi amor 💗 ¿me lo repites?";

  await appendToMemory(waNumber, "user", userText);
  await appendToMemory(waNumber, "assistant", reply);

  return reply;
}

// =============================
// FLOW CORE (sin OpenAI)
// =============================
function makeProductCard(prod) {
  return (
    `Tengo este 💗\n` +
    `${prod.name}\n` +
    `Precio: RD$${prod.price} c/u\n` +
    `¿Te reservo 1 unidad? 😊`
  );
}

function makeOrderSummary(items) {
  let total = 0;
  let lines = [];
  for (const it of items) {
    const p = PRODUCTS.find((x) => x.id === it.productId);
    if (!p) continue;
    const qty = Number(it.qty || 1);
    const sub = p.price * qty;
    total += sub;
    lines.push(`• ${qty}x ${p.name} — RD$${p.price}`);
  }
  return { lines, total };
}

// =============================
// Webhook Verify
// =============================
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

// =============================
// Webhook Receive
// =============================
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const message = value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const type = message.type;

    // =============================
    // 1) SI ES UBICACIÓN -> GUARDAR Y AVANZAR FLUJO
    // =============================
    if (type === "location" && message.location) {
      const loc = message.location;

      await setLastLocation(from, {
        latitude: loc.latitude,
        longitude: loc.longitude,
        name: loc.name || "",
        address: loc.address || "",
      });

      // si estamos esperando ubicación, seguimos
      const pending = await getPending(from);
      if (pending && pending.stage === "await_location") {
        pending.stage = "await_reference";
        await setPending(from, pending);

        const reply =
          "Perfecto ✅\nAhora dime solo una *referencia* (Ej: edificio, apto, color puerta o punto cerca) 💗";

        if (!(await preventSameReply(from, reply))) {
          await appendToMemory(from, "assistant", reply);
          await sendWhatsAppMessage(from, reply);
        }
      }
      return res.sendStatus(200);
    }

    // =============================
    // 2) TEXTO NORMAL
    // =============================
    const userText = message.text?.body || "";
    const textNorm = normalizeText(userText);

    // Cargar pending / profile
    let pending = await getPending(from);
    let profile = await getProfile(from);

    // =============================
    // A) DETECTAR PRODUCTO (si viene en el texto)
    // =============================
    const detectedProduct = findProduct(userText);
    if (detectedProduct) {
      await setLastProductSeen(from, detectedProduct.id);
    }

    // =============================
    // B) SI PIDE FOTO/IMAGEN => ENVIAR IMAGEN DEL ÚLTIMO PRODUCTO
    // =============================
    if (isAskingForImage(userText)) {
      const pid = await getLastProductSeen(from);
      const prod = PRODUCTS.find((p) => p.id === pid);
      if (prod?.image) {
        const caption = `${prod.name}\nPrecio: RD$${prod.price}\n¿Te lo reservo? 💗`;
        if (!(await preventSameReply(from, caption))) {
          await sendWhatsAppImage(from, prod.image, caption);
        }
        return res.sendStatus(200);
      }
    }

    // =============================
    // C) INICIO / SIN PENDING
    // =============================
    if (!pending) {
      // si detectó producto, responde producto
      if (detectedProduct) {
        const reply = makeProductCard(detectedProduct);

        if (!(await preventSameReply(from, reply))) {
          await appendToMemory(from, "assistant", reply);
          await sendWhatsAppMessage(from, reply);
        }

        // crear pending de venta
        pending = {
          stage: "await_reserve",
          items: [{ productId: detectedProduct.id, qty: 1 }],
        };
        await setPending(from, pending);

        return res.sendStatus(200);
      }

      // si no detecta producto, saluda y pregunta
      const hi =
        "¡Hola! 😊\n¿Qué producto estás buscando hoy en Glowny Essentials? 💗";

      if (!(await preventSameReply(from, hi))) {
        await appendToMemory(from, "assistant", hi);
        await sendWhatsAppMessage(from, hi);
      }

      pending = { stage: "idle", items: [] };
      await setPending(from, pending);

      return res.sendStatus(200);
    }

    // =============================
    // D) FLUJO DE PEDIDO (STATE MACHINE)
    // =============================

    // 1) idle -> si menciona producto ahora
    if (pending.stage === "idle") {
      if (detectedProduct) {
        const reply = makeProductCard(detectedProduct);

        if (!(await preventSameReply(from, reply))) {
          await appendToMemory(from, "assistant", reply);
          await sendWhatsAppMessage(from, reply);
        }

        pending.stage = "await_reserve";
        pending.items = [{ productId: detectedProduct.id, qty: 1 }];
        await setPending(from, pending);
        return res.sendStatus(200);
      }

      // fallback
      const fallback =
        "Dime cuál producto deseas 💗 (Ej: colágeno, rosa mosqueta, protector solar).";
      if (!(await preventSameReply(from, fallback))) {
        await appendToMemory(from, "assistant", fallback);
        await sendWhatsAppMessage(from, fallback);
      }
      return res.sendStatus(200);
    }

    // 2) await_reserve -> si dice sí/no o manda cantidad
    if (pending.stage === "await_reserve") {
      if (isNo(userText)) {
        pending.stage = "idle";
        pending.items = [];
        await setPending(from, pending);

        const reply = "Está bien mi amor 💗\nCuando quieras me dices qué necesitas 😊";
        if (!(await preventSameReply(from, reply))) {
          await appendToMemory(from, "assistant", reply);
          await sendWhatsAppMessage(from, reply);
        }
        return res.sendStatus(200);
      }

      // si dice sí, preguntar cantidad o tomar la que venga
      if (isYes(userText)) {
        pending.stage = "await_qty";
        await setPending(from, pending);

        const reply = "Perfecto 😊\n¿Cuántas unidades quieres? (Ej: 1, 2, 3)";
        if (!(await preventSameReply(from, reply))) {
          await appendToMemory(from, "assistant", reply);
          await sendWhatsAppMessage(from, reply);
        }
        return res.sendStatus(200);
      }

      // si ya escribió "quiero 2 colágenos" etc
      const qty = parseQty(userText);
      if (qty) {
        pending.items[0].qty = qty;
        pending.stage = "await_name";
        await setPending(from, pending);

        // si ya tiene nombre guardado en profile, saltar name
        if (profile?.name) {
          pending.name = profile.name;
          pending.stage = "await_location";
          await setPending(from, pending);

          await sendWhatsAppLocationRequest(from);

          const reply =
            "Perfecto ✅\nEscríbeme solo una *referencia* (Ej: edificio, apto o punto cerca) 💗";
          if (!(await preventSameReply(from, reply))) {
            await appendToMemory(from, "assistant", reply);
            await sendWhatsAppMessage(from, reply);
          }
          return res.sendStatus(200);
        }

        const reply = "Dime tu *nombre completo* para el pedido 💗";
        if (!(await preventSameReply(from, reply))) {
          await appendToMemory(from, "assistant", reply);
          await sendWhatsAppMessage(from, reply);
        }
        return res.sendStatus(200);
      }

      // si no dice sí/no -> repite info del producto detectado o último
      const pid = await getLastProductSeen(from);
      const prod = PRODUCTS.find((p) => p.id === pid) || detectedProduct;
      if (prod) {
        const reply = makeProductCard(prod);
        if (!(await preventSameReply(from, reply))) {
          await appendToMemory(from, "assistant", reply);
          await sendWhatsAppMessage(from, reply);
        }
        pending.stage = "await_reserve";
        pending.items = [{ productId: prod.id, qty: 1 }];
        await setPending(from, pending);
        return res.sendStatus(200);
      }

      // fallback OpenAI
      const ai = await callOpenAI(from, userText);
      if (!(await preventSameReply(from, ai))) {
        await sendWhatsAppMessage(from, ai);
      }
      return res.sendStatus(200);
    }

    // 3) await_qty -> guardar qty
    if (pending.stage === "await_qty") {
      const qty = parseQty(userText);
      if (!qty) {
        const reply = "Mi amor 😊\nDime un número de unidades (Ej: 1, 2, 3)";
        if (!(await preventSameReply(from, reply))) {
          await appendToMemory(from, "assistant", reply);
          await sendWhatsAppMessage(from, reply);
        }
        return res.sendStatus(200);
      }

      pending.items[0].qty = qty;
      pending.stage = "await_name";
      await setPending(from, pending);

      // si ya hay profile name, saltar
      if (profile?.name) {
        pending.name = profile.name;
        pending.stage = "await_location";
        await setPending(from, pending);

        await sendWhatsAppLocationRequest(from);

        const reply =
          "Perfecto ✅\nEscríbeme solo una *referencia* (Ej: edificio, apto o punto cerca) 💗";
        if (!(await preventSameReply(from, reply))) {
          await appendToMemory(from, "assistant", reply);
          await sendWhatsAppMessage(from, reply);
        }
        return res.sendStatus(200);
      }

      const reply = "Dime tu *nombre completo* para el pedido 💗";
      if (!(await preventSameReply(from, reply))) {
        await appendToMemory(from, "assistant", reply);
        await sendWhatsAppMessage(from, reply);
      }
      return res.sendStatus(200);
    }

    // 4) await_name -> guardar nombre y pedir ubicación por botón
    if (pending.stage === "await_name") {
      const name = userText.trim();
      if (name.length < 3) {
        const reply = "Mi amor 💗\nDime tu *nombre completo* porfa 😊";
        if (!(await preventSameReply(from, reply))) {
          await appendToMemory(from, "assistant", reply);
          await sendWhatsAppMessage(from, reply);
        }
        return res.sendStatus(200);
      }

      pending.name = name;
      pending.stage = "await_location";
      await setPending(from, pending);

      // guardar profile
      profile = profile || {};
      profile.name = name;
      await setProfile(from, profile);

      // pedir ubicación botón
      await sendWhatsAppLocationRequest(from);

      const reply =
        "Perfecto ✅\nEscríbeme solo una *referencia* (Ej: edificio, apto o punto cerca) 💗";
      if (!(await preventSameReply(from, reply))) {
        await appendToMemory(from, "assistant", reply);
        await sendWhatsAppMessage(from, reply);
      }
      return res.sendStatus(200);
    }

    // 5) await_location -> aquí esperamos el location message (se maneja arriba)
    if (pending.stage === "await_location") {
      const reply =
        "📍 Mi amor, envíame tu ubicación tocando el botón de WhatsApp (Enviar ubicación) 💗";
      if (!(await preventSameReply(from, reply))) {
        await appendToMemory(from, "assistant", reply);
        await sendWhatsAppLocationRequest(from);
        await sendWhatsAppMessage(from, reply);
      }
      return res.sendStatus(200);
    }

    // 6) await_reference -> guardar referencia y pedir método de pago
    if (pending.stage === "await_reference") {
      const ref = userText.trim();
      if (ref.length < 3) {
        const reply = "Dime una referencia cortita porfa 😊 (Ej: Edificio L, apto 3B)";
        if (!(await preventSameReply(from, reply))) {
          await appendToMemory(from, "assistant", reply);
          await sendWhatsAppMessage(from, reply);
        }
        return res.sendStatus(200);
      }

      pending.reference = ref;
      pending.stage = "await_payment";
      await setPending(from, pending);

      const reply = "Listo ✅\n¿El pago será *contra entrega* o *transferencia*? 😊";
      if (!(await preventSameReply(from, reply))) {
        await appendToMemory(from, "assistant", reply);
        await sendWhatsAppMessage(from, reply);
      }
      return res.sendStatus(200);
    }

    // 7) await_payment -> guardar pago y mostrar resumen (confirmación)
    if (pending.stage === "await_payment") {
      if (!isPaymentMessage(userText)) {
        const reply = "Mi amor 😊\n¿Será *contra entrega* o *transferencia*?";
        if (!(await preventSameReply(from, reply))) {
          await appendToMemory(from, "assistant", reply);
          await sendWhatsAppMessage(from, reply);
        }
        return res.sendStatus(200);
      }

      pending.payment = userText.trim();
      pending.stage = "await_confirm";
      await setPending(from, pending);

      const { lines, total } = makeOrderSummary(pending.items);

      const reply =
        `Perfecto mi amor ✅\n🛒 Tu pedido:\n${lines.join("\n")}\n\n💰 Total: RD$${total}\n¿Confirmas para procesarlo? 😊`;

      if (!(await preventSameReply(from, reply))) {
        await appendToMemory(from, "assistant", reply);
        await sendWhatsAppMessage(from, reply);
      }
      return res.sendStatus(200);
    }

    // 8) await_confirm -> confirmar y mandar al admin
    if (pending.stage === "await_confirm") {
      if (!isYes(userText)) {
        const reply =
          "Dime *sí* para confirmarlo ✅ o dime qué quieres cambiar 😊";
        if (!(await preventSameReply(from, reply))) {
          await appendToMemory(from, "assistant", reply);
          await sendWhatsAppMessage(from, reply);
        }
        return res.sendStatus(200);
      }

      const { lines, total } = makeOrderSummary(pending.items);
      const loc = await getLastLocation(from);

      // mensaje al cliente
      const customerReply =
        "✅ Listo mi amor 💗\nTu pedido fue procesado. En un momentico te confirmamos el envío 😊";

      if (!(await preventSameReply(from, customerReply))) {
        await appendToMemory(from, "assistant", customerReply);
        await sendWhatsAppMessage(from, customerReply);
      }

      // mensaje al admin
      let adminText = `📦 ${ORDER_TAG}\n`;
      adminText += `👤 Cliente: ${pending.name || "N/A"}\n`;
      adminText += `📲 WhatsApp: ${from}\n`;
      adminText += `🛒 Pedido:\n${lines.join("\n")}\n`;
      adminText += `💰 Total catálogo: RD$${total}\n`;
      adminText += `💳 Pago: ${pending.payment || "N/A"}\n`;
      adminText += `🧭 Referencia: ${pending.reference || "N/A"}\n`;
      adminText += `🔗 Chat: https://wa.me/${from}\n`;

      if (loc?.latitude && loc?.longitude) {
        adminText += `\n📍 Ubicación:\n`;
        adminText += `Lat: ${loc.latitude}, Lon: ${loc.longitude}\n`;
        adminText += `Maps: https://www.google.com/maps?q=${loc.latitude},${loc.longitude}\n`;
        if (loc.address) adminText += `Dirección (mapa): ${loc.address}\n`;
        if (loc.name) adminText += `Nombre (mapa): ${loc.name}\n`;
      }

      await sendWhatsAppMessage(ADMIN_PHONE, adminText);

      // limpiar pending
      await clearPending(from);

      return res.sendStatus(200);
    }

    // =============================
    // E) FALLBACK OPENAI (si algo extraño)
    // =============================
    const ai = await callOpenAI(from, userText);
    if (!(await preventSameReply(from, ai))) {
      await sendWhatsAppMessage(from, ai);
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error("Error webhook:", err);
    return res.sendStatus(200);
  }
});

// =============================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Bot corriendo en puerto ${PORT}`));
