const express = require("express");
const axios = require("axios");

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

// =============================
// Helpers
// =============================
function onlyDigits(phone) {
  return String(phone || "").replace(/\D/g, "");
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
]);

const BRAND_WORDS = new Set(["deliplus", "nivea", "sisbela", "florena"]);

// Index del catálogo
const productIndex = catalog.map((prod) => {
  const nameNorm = normalizeText(prod.name);
  const keywords = new Set(
    nameNorm
      .split(" ")
      .filter((w) => w && !SPANISH_STOPWORDS.has(w) && !BRAND_WORDS.has(w))
  );
  return {
    id: prod.id,
    name: prod.name,
    keywords,
    data: prod,
  };
});

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

    if (commonWordsCount > bestScore) {
      bestScore = commonWordsCount;
      bestMatch = item;
    }
  }

  if (bestScore === 0) return null;
  return bestMatch;
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
    console.error("❌ Error obteniendo sesión de Redis:", error?.response?.data || error);
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
    console.error("❌ Error guardando sesión en Redis:", error?.response?.data || error);
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
        messaging_product: "whatsapp", // ✅ ESTA ES LA CLAVE DEL ERROR
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

async function sendWhatsAppButtons(to, text, buttons) {
  await waSend({
    to: onlyDigits(to),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text },
      action: {
        buttons: buttons.map((btn) => ({
          type: "reply",
          reply: { id: btn.id, title: btn.title },
        })),
      },
    },
  });
}

// =============================
// OPENAI
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

  const systemContent = `Eres Glowny, una asistente virtual de Glowny Essentials (República Dominicana).
Hablas en español, tono femenino suave, humano y servicial, ideal para señoras mayores.
Respondes claro y corto (2 a 6 líneas). Usa 1-3 emojis suaves: ✨😊💗🛒📍💳⏳🥄

REGLAS:
- NO inventes información. Solo usa el catálogo y el contexto.
- Si te falta un dato exacto di: "No tengo ese dato exacto ahora mismo ✅".
- Si la clienta quiere comprar, guía el pedido con calma.
- Si la clienta está confundida, no la regañes: explícate simple.

INFO DE PRODUCTO:
${productInfo}`;

  const messages = [{ role: "system", content: systemContent }];

  // contexto corto (1 ronda)
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

    return response.data.choices?.[0]?.message?.content?.trim() || "😊 ¿En qué puedo ayudarte?";
  } catch (error) {
    console.error("❌ Error OpenAI:", error?.response?.data || error);
    return "Lo siento 🙏 tuve un error momentáneo. ¿Me lo repites por favor? 😊";
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
    const userPhone = msg.from; // ya viene sin +
    const msgType = msg.type;

    const customerName =
      value?.contacts?.[0]?.profile?.name || "";

    let session = (await getSession(userPhone)) || {};
    if (!session.history) session.history = [];
    if (!session.order) session.order = {};
    if (!session.state) session.state = "INIT";

    // =============================
    // HANDLERS
    // =============================
    if (msgType === "text") {
      const userText = msg.text?.body?.trim() || "";
      const lowText = normalizeText(userText);

      // Detectar intención de compra más fácil para señoras
      const wantsToBuy =
        lowText.includes("quiero") ||
        lowText.includes("lo quiero") ||
        lowText.includes("pedir") ||
        lowText.includes("comprar") ||
        lowText.includes("me lo llevo") ||
        lowText.includes("ordenar");

      // Buscar producto si no hay producto en sesión
      let currentProduct = session.product || null;

      const found = findProductForMessage(userText);
      if (found) {
        currentProduct = found.data;
        session.product = currentProduct;
      }

      // Saludo
      if (!currentProduct && (lowText === "hola" || lowText.includes("buenas"))) {
        const greetingName = customerName ? ` ${customerName}` : "";
        await sendWhatsAppText(
          userPhone,
          `¡Hola${greetingName}! 😊✨\nCuéntame, ¿qué producto estás buscando hoy? 💗`
        );
        session.state = "INIT";
        await setSession(userPhone, session);
        return res.sendStatus(200);
      }

      // Si no se identifica producto
      if (!currentProduct) {
        await sendWhatsAppText(
          userPhone,
          `Disculpa 😔 no logré identificar el producto.\n¿Me dices el nombre o una palabra clave? (Ej: “colágeno”, “aloe”, “magnesio”) 💗`
        );
        session.state = "INIT";
        await setSession(userPhone, session);
        return res.sendStatus(200);
      }

      // Si quiere comprar -> pedir cantidad
      if (wantsToBuy && session.state !== "AWAIT_LOCATION" && session.state !== "AWAIT_PAYMENT") {
        session.state = "AWAIT_QUANTITY";
        await sendWhatsAppText(
          userPhone,
          `Perfecto 😊🛒\n¿Cuántas unidades de *${currentProduct.name}* deseas?`
        );
        await setSession(userPhone, session);
        return res.sendStatus(200);
      }

      // Si estamos esperando cantidad
      if (session.state === "AWAIT_QUANTITY") {
        let quantity = null;
        const digitMatch = userText.match(/\d+/);

        if (digitMatch) quantity = parseInt(digitMatch[0], 10);

        if (!quantity || quantity <= 0) {
          await sendWhatsAppText(
            userPhone,
            "¿Cuántas unidades deseas? 😊\n(Ej: 1, 2, 3)"
          );
          await setSession(userPhone, session);
          return res.sendStatus(200);
        }

        session.order.quantity = quantity;
        session.state = "AWAIT_LOCATION";

        await sendWhatsAppText(
          userPhone,
          `✅ Anotado: *${quantity}* unidad(es) 😊🛒\nAhora envíame tu ubicación 📍 (clip 📎 > Ubicación > Enviar).`
        );
        await setSession(userPhone, session);
        return res.sendStatus(200);
      }

      // Q&A normal con IA
      const aiReply = await callOpenAI(session, currentProduct, userText);
      await sendWhatsAppText(userPhone, aiReply);

      session.history.push({ user: userText, assistant: aiReply });
      if (session.history.length > 6) session.history.shift();

      // Enviar imagen una vez
      if (!session.sentImage && currentProduct.image) {
        await sendWhatsAppImage(userPhone, currentProduct.image, currentProduct.name);
        session.sentImage = true;
      }

      session.state = "Q&A";
      await setSession(userPhone, session);
      return res.sendStatus(200);
    }

    if (msgType === "location") {
      const loc = msg.location;
      if (!loc) return res.sendStatus(200);

      if (session.state === "AWAIT_LOCATION") {
        session.order.location = {
          latitude: loc.latitude,
          longitude: loc.longitude,
          name: loc.name || "",
          address: loc.address || "",
        };

        session.state = "AWAIT_PAYMENT";
        await sendWhatsAppText(userPhone, "Gracias 😊📍\n¿Cómo prefieres pagar? 💳");
        await sendWhatsAppButtons(userPhone, "Elige una opción:", [
          { id: "pay_cash", title: "Contra entrega" },
          { id: "pay_transfer", title: "Transferencia" },
        ]);

        await setSession(userPhone, session);
        return res.sendStatus(200);
      }

      await sendWhatsAppText(userPhone, "Recibí tu ubicación 😊📍\n¿Te ayudo a pedir algún producto? 💗");
      await setSession(userPhone, session);
      return res.sendStatus(200);
    }

    if (msgType === "interactive") {
      if (msg.interactive?.type === "button_reply") {
        const buttonId = msg.interactive.button_reply.id;

        if (session.state === "AWAIT_PAYMENT") {
          if (buttonId === "pay_cash") session.order.payment = "Contra entrega";
          if (buttonId === "pay_transfer") session.order.payment = "Transferencia";
        }

        // Finalizar pedido si ya hay pago
        if (session.state === "AWAIT_PAYMENT" && session.order.payment) {
          const order = session.order;
          const productName = session.product?.name || "Producto";
          const qty = order.quantity || 1;
          const payMethod = order.payment;

          await sendWhatsAppText(
            userPhone,
            `✅ ¡Listo! 😊🛒\nTu pedido: *${qty} x ${productName}*\nPago: *${payMethod}* 💳\nEn breve lo coordinamos 💗`
          );

          // Admin
          if (ADMIN_PHONE) {
            let locationInfo = "";
            if (order.location?.latitude && order.location?.longitude) {
              const { latitude, longitude, address, name } = order.location;
              const mapLink = `https://maps.google.com/?q=${latitude},${longitude}`;
              locationInfo = `📍 Ubicación: ${name ? name + " - " : ""}${address ? address + " - " : ""}${mapLink}`;
            }

            const adminMsg = `📦 NUEVO PEDIDO - Glowny Essentials
Cliente: ${customerName || "Sin nombre"} (${userPhone})
Producto: ${productName}
Cantidad: ${qty}
Pago: ${payMethod}
${locationInfo}`;

            await sendWhatsAppText(ADMIN_PHONE, adminMsg);
          }

          // Reset sesión
          session.state = "INIT";
          session.order = {};
          session.history = [];
          session.product = null;
          session.sentImage = false;

          await setSession(userPhone, session);
          return res.sendStatus(200);
        }
      }

      await setSession(userPhone, session);
      return res.sendStatus(200);
    }

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
