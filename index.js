const express = require("express");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "glowny_verify";
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ✅ ADMIN (recibe pedidos listos)
const ADMIN_PHONE = "18492010239"; // sin +
// Si quieres mandar datos bancarios cuando elijan transferencia:
const BANK_INFO =
  process.env.BANK_INFO ||
  "✅ Transferencia disponible. Te paso los datos al confirmar 💖";

// TAG para pedidos confirmados por IA (fallback)
const ORDER_TAG = "PEDIDO_CONFIRMADO:";

// ✅ IDs de botones (PRO 2)
const BTN_CONFIRM = "confirm_order";
const BTN_ADD_MORE = "add_more";
const BTN_CANCEL = "cancel_order";

const BTN_PAY_TRANSFER = "pay_transfer";
const BTN_PAY_CASH = "pay_cash";

const BTN_TIME_TODAY = "time_today";
const BTN_TIME_TOMORROW = "time_tomorrow";
const BTN_TIME_COORD = "time_coord";

// ✅ Memorias y estados
const lastLocation = new Map(); // from -> {latitude,longitude,name,address}
const memory = new Map(); // from -> openai history
const entryProduct = new Map(); // from -> texto del anuncio/referral
const currentProduct = new Map(); // from -> productId (producto principal detectado)
const carts = new Map(); // from -> { items:[{id,qty}], data:{} }

// ✅ Carga catálogo desde JSON (NO dentro del prompt)
let PRODUCTS = [];
try {
  PRODUCTS = require("./products.json");
  console.log(`✅ Productos cargados: ${PRODUCTS.length}`);
} catch (e) {
  console.log("⚠️ No existe products.json. PRODUCTS quedará vacío.");
}

// =========================
// HELPERS
// =========================
function normalizeText(str = "") {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getProductById(id) {
  return PRODUCTS.find((p) => p.id === id) || null;
}

function findBestProduct(queryText = "") {
  const q = normalizeText(queryText);
  if (!q || PRODUCTS.length === 0) return null;

  let best = null;
  let bestScore = 0;

  for (const p of PRODUCTS) {
    if (!p?.in_stock) continue;

    const name = normalizeText(p.name || "");
    if (!name) continue;

    const words = q.split(" ");
    let score = 0;

    for (const w of words) {
      if (w.length < 3) continue;
      if (name.includes(w)) score += 1;
    }

    // bonus por keywords frecuentes
    if (q.includes("rosa mosqueta") && name.includes("rosa mosqueta")) score += 6;
    if (q.includes("colageno") && name.includes("colageno")) score += 6;
    if (q.includes("protector") && name.includes("proteccion solar")) score += 4;

    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  return bestScore >= 2 ? best : null;
}

function getOrCreateCart(from) {
  let cart = carts.get(from);
  if (!cart) {
    cart = { items: [], data: { step: "idle" } };
    carts.set(from, cart);
  }
  return cart;
}

function addToCart(from, productId, qty = 1) {
  const cart = getOrCreateCart(from);

  const existing = cart.items.find((x) => x.id === productId);
  if (existing) existing.qty += qty;
  else cart.items.push({ id: productId, qty });

  carts.set(from, cart);
  return cart;
}

function calcCartTotal(cart) {
  let total = 0;
  for (const it of cart.items || []) {
    const p = getProductById(it.id);
    if (!p) continue;
    total += Number(p.price || 0) * Number(it.qty || 1);
  }
  return total;
}

function buildCartSummary(from) {
  const cart = carts.get(from);
  if (!cart || !cart.items || cart.items.length === 0) return null;

  let lines = [];
  let total = 0;

  for (const it of cart.items) {
    const p = getProductById(it.id);
    if (!p) continue;

    const sub = Number(p.price || 0) * Number(it.qty || 1);
    total += sub;

    lines.push(`• ${it.qty}x ${p.name} — RD$${p.price}`);
  }

  return {
    text:
      `🧾 *Tu pedido:* \n${lines.join("\n")}\n\n` +
      `💰 *Total:* RD$${total}\n\n` +
      `¿Confirmamos para procesarlo? 💖`,
    total,
    lines,
  };
}

function buildAdminSummary(from) {
  const cart = carts.get(from);
  if (!cart || !cart.items || cart.items.length === 0) return null;

  let lines = [];
  let total = 0;

  for (const it of cart.items) {
    const p = getProductById(it.id);
    if (!p) continue;

    total += Number(p.price || 0) * Number(it.qty || 1);
    lines.push(`- ${it.qty}x ${p.name} (RD$${p.price})`);
  }

  const data = cart.data || {};

  let text =
    `📦 *PEDIDO LISTO - Glowny Essentials*\n\n` +
    `${lines.join("\n")}\n\n` +
    `💰 Total: RD$${total}\n` +
    `👤 Cliente: ${data.name || "No indicado"}\n` +
    `📍 Sector: ${data.sector || "No indicado"}\n` +
    `🏠 Dirección: ${data.address || "No indicada"}\n` +
    `💳 Pago: ${data.payment || "No indicado"}\n` +
    `🕒 Entrega: ${data.delivery_time || "No indicado"}\n\n` +
    `📲 Cliente (WA): ${from}\n` +
    `🔗 Chat: https://wa.me/${from}`;

  const loc = lastLocation.get(from);
  if (loc) {
    text +=
      `\n\n📍 Ubicación por mapa:\n` +
      `Lat: ${loc.latitude}, Lon: ${loc.longitude}\n` +
      `Google Maps: https://www.google.com/maps?q=${loc.latitude},${loc.longitude}\n` +
      (loc.address ? `Dirección aprox: ${loc.address}\n` : "");
  }

  return text;
}

// =========================
// PROMPT OPENAI (fallback)
// =========================
function getSystemPromptMini(productContext = "") {
  return `
Eres una asistente de ventas por WhatsApp de Glowny Essentials (RD).
Responde corto (máx 2-4 líneas), tono femenino y amable con emojis suaves.
NUNCA inventes precios: solo usa el precio del CONTEXTO si existe.
Tu objetivo es cerrar el pedido: producto + cantidad + ubicación + pago.

${productContext ? "CONTEXTO_PRODUCTO:\n" + productContext : ""}

Si el cliente pide foto/presentación, responde: "Puedo enviarte la imagen ✅".
Si el cliente confirma compra, pide: nombre, sector, dirección y ubicación por mapa.
`;
}

async function callOpenAI(from, userText, productContext = "") {
  const history = memory.get(from) || [];

  const messages = [
    { role: "system", content: getSystemPromptMini(productContext) },
    ...history,
    { role: "user", content: userText },
  ];

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages,
      temperature: 0.2,
      max_tokens: 220,
    }),
  });

  const data = await response.json();

  if (data?.error?.code === "rate_limit_exceeded") {
    return "Ay mi amor 😭 ahora mismo estoy un chin ocupada. Escríbeme de nuevo en 1 minutico 🙏";
  }

  const reply =
    data.choices?.[0]?.message?.content ||
    "Disculpa mi amor 😅 ahora mismo tengo un inconveniente. Escríbeme de nuevo en un momento 💖";

  // memoria corta
  const newHistory = [
    ...history,
    { role: "user", content: userText },
    { role: "assistant", content: reply },
  ];
  memory.set(from, newHistory.slice(-8));

  return reply;
}

// =========================
// WHATSAPP SENDERS
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
  if (!res.ok) {
    console.log("❌ Error WhatsApp:", JSON.stringify(data, null, 2));
  }
}

async function sendWhatsAppImage(to, imageUrl, caption = "") {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: {
      link: imageUrl,
      caption,
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  if (!resp.ok) {
    console.log("❌ Error imagen WhatsApp:", JSON.stringify(data, null, 2));
  }
}

// ✅ Botones PRO 2
async function sendWhatsAppButtons(to, text, buttons = []) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  if (!resp.ok) {
    console.log("❌ Error botones WhatsApp:", JSON.stringify(data, null, 2));
  }
}

// =========================
// WEBHOOK GET
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
// WEBHOOK POST (PRO 2)
// =========================
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const message = value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const cart = getOrCreateCart(from);

    // ✅ Referral desde anuncio
    if (message.referral) {
      const ref = message.referral;
      const posibleNombre = ref.headline || ref.body || ref.source_url || "";
      if (posibleNombre) {
        entryProduct.set(from, posibleNombre);
        const p = findBestProduct(posibleNombre);
        if (p) currentProduct.set(from, p.id);
      }
    }

    // ✅ Ubicación por mapa
    if (message.type === "location" && message.location) {
      const loc = message.location;
      lastLocation.set(from, {
        latitude: loc.latitude,
        longitude: loc.longitude,
        name: loc.name || "",
        address: loc.address || "",
      });

      await sendWhatsAppMessage(from, "Perfecto mi amor 📍 ya tengo tu ubicación. ¿Confirmamos el pedido? 💖");
      return res.sendStatus(200);
    }

    // ✅ Detectar botones
    let interactiveId = null;
    if (message.type === "interactive") {
      const btn = message.interactive?.button_reply;
      interactiveId = btn?.id || null;
    }

    // ✅ Texto
    const userText = message.text?.body || "";
    const userNorm = normalizeText(userText);

    // =========================
    // FLUJO BOTONES PRO 2
    // =========================
    if (interactiveId === BTN_CONFIRM) {
      cart.data.step = "ask_payment";
      carts.set(from, cart);

      await sendWhatsAppButtons(from, "Perfecto 💖 ¿Cómo deseas pagar?", [
        { id: BTN_PAY_TRANSFER, title: "💳 Transferencia" },
        { id: BTN_PAY_CASH, title: "💵 Efectivo" },
      ]);
      return res.sendStatus(200);
    }

    if (interactiveId === BTN_ADD_MORE) {
      cart.data.step = "add_more";
      carts.set(from, cart);
      await sendWhatsAppMessage(from, "Dime cuál producto quieres agregar 😊");
      return res.sendStatus(200);
    }

    if (interactiveId === BTN_CANCEL) {
      carts.delete(from);
      currentProduct.delete(from);
      entryProduct.delete(from);
      await sendWhatsAppMessage(from, "Listo mi amor ✅ pedido cancelado. Cuando quieras vuelves y te ayudo 💖");
      return res.sendStatus(200);
    }

    if (interactiveId === BTN_PAY_TRANSFER || interactiveId === BTN_PAY_CASH) {
      cart.data.payment =
        interactiveId === BTN_PAY_TRANSFER ? "Transferencia" : "Efectivo contra entrega";

      cart.data.step = "ask_delivery_time";
      carts.set(from, cart);

      if (interactiveId === BTN_PAY_TRANSFER) {
        await sendWhatsAppMessage(from, BANK_INFO);
      }

      await sendWhatsAppButtons(from, "¿Para cuándo lo quieres? 🕒", [
        { id: BTN_TIME_TODAY, title: "📦 Hoy" },
        { id: BTN_TIME_TOMORROW, title: "📦 Mañana" },
        { id: BTN_TIME_COORD, title: "📲 Coordinar" },
      ]);
      return res.sendStatus(200);
    }

    if (
      interactiveId === BTN_TIME_TODAY ||
      interactiveId === BTN_TIME_TOMORROW ||
      interactiveId === BTN_TIME_COORD
    ) {
      cart.data.delivery_time =
        interactiveId === BTN_TIME_TODAY
          ? "Hoy"
          : interactiveId === BTN_TIME_TOMORROW
          ? "Mañana"
          : "Coordinar";

      cart.data.step = "ask_name";
      carts.set(from, cart);

      await sendWhatsAppMessage(from, "Perfecto mi amor 💖 ¿Cuál es tu nombre completo?");
      return res.sendStatus(200);
    }

    // ✅ Captura nombre/sector/dirección
    if (cart.data.step === "ask_name" && userText.trim().length > 2) {
      cart.data.name = userText.trim();
      cart.data.step = "ask_sector";
      carts.set(from, cart);

      await sendWhatsAppMessage(from, "¿En qué ciudad y sector estás? 📍");
      return res.sendStatus(200);
    }

    if (cart.data.step === "ask_sector" && userText.trim().length > 2) {
      cart.data.sector = userText.trim();
      cart.data.step = "ask_address";
      carts.set(from, cart);

      await sendWhatsAppMessage(
        from,
        "Dime tu dirección breve y un punto de referencia 🏠\n(ó envíame tu ubicación por el mapa 📎→Ubicación)"
      );
      return res.sendStatus(200);
    }

    if (cart.data.step === "ask_address" && userText.trim().length > 2) {
      cart.data.address = userText.trim();
      cart.data.step = "ready_to_confirm";
      carts.set(from, cart);

      const summary = buildCartSummary(from);
      if (summary) {
        await sendWhatsAppButtons(from, summary.text, [
          { id: BTN_CONFIRM, title: "✅ Confirmar" },
          { id: BTN_ADD_MORE, title: "➕ Agregar" },
          { id: BTN_CANCEL, title: "❌ Cancelar" },
        ]);
      } else {
        await sendWhatsAppMessage(from, "Dime qué producto deseas llevar y te lo agrego al pedido 💖");
      }
      return res.sendStatus(200);
    }

    // ✅ Confirmación escrita ("si / confirmo / ok")
    if (
      cart.data.step === "ready_to_confirm" &&
      (userNorm === "si" || userNorm.includes("confirmo") || userNorm.includes("ok"))
    ) {
      const adminText = buildAdminSummary(from);
      if (adminText) {
        await sendWhatsAppMessage(from, "✅ Listo mi amor 💖 ya procesé tu pedido. En breve te confirmamos el envío 📦✨");
        await sendWhatsAppMessage(ADMIN_PHONE, adminText);

        // limpieza
        carts.delete(from);
        currentProduct.delete(from);
        entryProduct.delete(from);
        memory.delete(from);

        return res.sendStatus(200);
      }
    }

    // =========================
    // PRO: DETECTAR PRODUCTO (texto/referral)
    // =========================
    let product = null;
    const currentId = currentProduct.get(from);
    if (currentId) product = getProductById(currentId);

    if (!product) {
      // si entró por anuncio, intentamos con el texto del anuncio
      const fromAd = entryProduct.get(from);
      if (fromAd) product = findBestProduct(fromAd);
    }

    // si aún no hay producto, intentamos por el texto del usuario
    if (!product) {
      product = findBestProduct(userText);
      if (product) currentProduct.set(from, product.id);
    }

    // =========================
    // RESPUESTAS DIRECTAS (sin IA)
    // =========================
    const qtyMatch = userNorm.match(/\b(\d+)\b/);
    const wantsBuy =
      userNorm.includes("quiero") ||
      userNorm.includes("dame") ||
      userNorm.includes("lo llevo") ||
      userNorm.includes("lo quiero") ||
      userNorm.includes("ordenar") ||
      userNorm.includes("comprar");

    // precio directo
    if (product && (userNorm.includes("precio") || userNorm.includes("cuanto") || userNorm.includes("cuesta"))) {
      await sendWhatsAppMessage(from, `💰 ${product.name}\nPrecio: RD$${product.price}\n¿Lo quieres llevar? ¿Cuántos? 💖`);
      return res.sendStatus(200);
    }

    // presentación/foto
    if (product && (userNorm.includes("foto") || userNorm.includes("imagen") || userNorm.includes("presentacion"))) {
      await sendWhatsAppImage(
        from,
        product.image,
        `${product.name}\n💰 RD$${product.price}\n¿Lo quieres llevar? 💖`
      );
      return res.sendStatus(200);
    }

    // agregar al carrito
    if (product && wantsBuy) {
      const qty = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;
      addToCart(from, product.id, qty);

      const summary = buildCartSummary(from);
      await sendWhatsAppMessage(
        from,
        `✅ Perfecto mi amor 💖 agregué: ${qty}x ${product.name}\n💰 Precio: RD$${product.price}`
      );

      if (summary) {
        await sendWhatsAppButtons(from, summary.text, [
          { id: BTN_CONFIRM, title: "✅ Confirmar" },
          { id: BTN_ADD_MORE, title: "➕ Agregar" },
          { id: BTN_CANCEL, title: "❌ Cancelar" },
        ]);
      }
      return res.sendStatus(200);
    }

    // si pide envío
    if (userNorm.includes("envio") || userNorm.includes("llegar") || userNorm.includes("tarda")) {
      await sendWhatsAppMessage(from, "📦 El envío suele tardar 24 a 48 horas según tu zona 💖\n¿En qué ciudad y sector estás?");
      return res.sendStatus(200);
    }

    // =========================
    // FALLBACK IA (solo si hace falta)
    // =========================
    const productContext = product
      ? `Producto: ${product.name}\nPrecio: RD$${product.price}\nImagen: ${product.image}`
      : "";

    const aiReply = await callOpenAI(from, userText, productContext);
    await sendWhatsAppMessage(from, aiReply);

    return res.sendStatus(200);
  } catch (err) {
    console.error("Error en /webhook:", err);
    return res.sendStatus(200);
  }
});

// =========================
// SERVER
// =========================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Bot corriendo en el puerto ${PORT}`);
});
