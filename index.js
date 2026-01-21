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

// ✅ Confirmaciones típicas
const CONFIRM_WORDS = new Set([
  "si",
  "sí",
  "sii",
  "sip",
  "ok",
  "okay",
  "dale",
  "claro",
  "aja",
  "ajá",
  "perfecto",
  "correcto",
  "esta bien",
  "ta bien",
  "bien",
  "listo",
  "okey",
  "va",
  "vamos",
  "de acuerdo",
  "confirmo",
  "confirmar",
  "confirmado",
  "asi mismo",
  "así mismo",
]);

// ✅ Colores (si lo dicen suelto)
const COLOR_WORDS = new Set([
  "rosado",
  "rosa",
  "azul",
  "amarillo",
  "verde",
  "morado",
  "lila",
  "blanco",
  "negro",
  "beige",
  "dorado",
  "plateado",
  "naranja",
  "rojo",
  "gris",
]);

// ✅ Frases de compra naturales
const BUY_PHRASES = [
  "quiero ese",
  "quiero esa",
  "quiero eso",
  "quiero el de la foto",
  "quiero el de la imagen",
  "me lo llevo",
  "lo quiero",
  "lo compro",
  "lo voy a pedir",
  "voy a pedir",
  "quiero pedir",
  "quiero comprar",
  "dame ese",
  "dame esa",
  "mandamelo",
  "mándamelo",
  "agregamelo",
  "agrégamelo",
  "agregame ese",
  "agrégame ese",
  "ponmelo",
  "pónmelo",
  "ponme ese",
  "pónme ese",
  "si lo quiero",
  "si lo compro",
  "si ese",
  "si esa",
  "ese mismo",
  "esa misma",
  "ese de ahi",
  "ese de ahí",
  "esa de ahi",
  "esa de ahí",
];

// ✅ Número en palabras
const NUMBER_WORDS = {
  cero: 0,
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
};

// ✅ Extraer cantidad
function extractQuantity(rawText) {
  const text = normalizeText(rawText);
  if (!text) return null;

  const digitMatch = text.match(/\d+/);
  if (digitMatch) {
    const n = parseInt(digitMatch[0], 10);
    if (n > 0) return n;
  }

  const words = text.split(" ").filter(Boolean);
  for (const w of words) {
    if (NUMBER_WORDS[w] !== undefined && NUMBER_WORDS[w] > 0) {
      return NUMBER_WORDS[w];
    }
  }

  return null;
}

// ✅ Confirmación simple (sí/ok/dale)
function isSimpleConfirmation(rawText) {
  const t = normalizeText(rawText);
  if (!t) return false;

  if (CONFIRM_WORDS.has(t)) return true;

  const words = t.split(" ").filter(Boolean);
  if (words.length <= 2) {
    if (words.includes("si") || words.includes("ok") || words.includes("dale"))
      return true;
  }

  if (t.startsWith("si ") || t.startsWith("ok ") || t.startsWith("dale "))
    return true;

  return false;
}

// ✅ Referencia al producto anterior: “ese/el de la foto”
function isReferencingPreviousProduct(rawText) {
  const t = normalizeText(rawText);
  if (!t) return false;

  if (isSimpleConfirmation(t)) return true;

  for (const p of BUY_PHRASES) {
    if (t.includes(p)) return true;
  }

  if (
    t.includes("de la foto") ||
    t.includes("de la imagen") ||
    t.includes("de la fotografia")
  )
    return true;

  const words = t.split(" ").filter(Boolean);

  if (
    words.length === 1 &&
    (words[0] === "ese" || words[0] === "esa" || words[0] === "eso")
  )
    return true;

  if (
    words.length === 2 &&
    (words[0] === "el" || words[0] === "la") &&
    COLOR_WORDS.has(words[1])
  )
    return true;

  if (
    words.length === 2 &&
    (words[0] === "ese" || words[0] === "esa") &&
    COLOR_WORDS.has(words[1])
  )
    return true;

  return false;
}

// =============================
// ✅ FUZZY MATCH (errores de escritura)
// =============================
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const matrix = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0)
  );

  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[a.length][b.length];
}

function fuzzyWordMatch(word, keyword) {
  if (!word || !keyword) return false;
  if (word === keyword) return true;

  if (word.length < 4 || keyword.length < 4) return false;

  const dist = levenshtein(word, keyword);
  const maxDist = keyword.length <= 6 ? 1 : 2;

  return dist <= maxDist;
}

// =============================
// Index del catálogo
// =============================
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
  const msgWordsArr = msgNorm
    .split(" ")
    .filter((w) => w && !SPANISH_STOPWORDS.has(w) && !BRAND_WORDS.has(w));

  const msgWords = new Set(msgWordsArr);

  let bestMatch = null;
  let bestScore = 0;

  for (const item of productIndex) {
    const exactCount = [...msgWords].filter((w) => item.keywords.has(w)).length;

    let fuzzyCount = 0;
    for (const w of msgWordsArr) {
      for (const kw of item.keywords) {
        if (fuzzyWordMatch(w, kw)) {
          fuzzyCount++;
          break;
        }
      }
    }

    const score = exactCount * 3 + fuzzyCount;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = item;
    }
  }

  if (bestScore < 2) return null;
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
    console.error(
      "❌ Error obteniendo sesión de Redis:",
      error?.response?.data || error
    );
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
    console.error(
      "❌ Error guardando sesión de Redis:",
      error?.response?.data || error
    );
  }
}

// =============================
// WHATSAPP CLOUD API
// ✅ FIX: messaging_product: "whatsapp"
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
        messaging_product: "whatsapp",
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
    console.error("❌ Error enviando WhatsApp:", error?.response?.data || error);
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

  const systemContent = `Eres Glowny, asistente virtual de Glowny Essentials (República Dominicana).
Hablas en español, tono femenino suave, humano y servicial (ideal para señoras mayores).
Respondes claro y corto (2 a 6 líneas). Usa 1-3 emojis suaves: ✨😊💗🛒📍

REGLAS IMPORTANTES:
- NUNCA uses "querida" ni frases parecidas.
- NO inventes información. Solo usa el catálogo y el contexto.
- Si te falta un dato exacto di: "No tengo ese dato exacto ahora mismo ✅".
- Si la clienta dice “sí/ok/dale/ese/el de la foto”, avanza el pedido con calma.

INFO DE PRODUCTO:
${productInfo}`;

  const messages = [{ role: "system", content: systemContent }];

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

    return (
      response.data.choices?.[0]?.message?.content?.trim() ||
      "😊 ¿En qué puedo ayudarte?"
    );
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
    const userPhone = msg.from;
    const msgType = msg.type;

    const customerName = value?.contacts?.[0]?.profile?.name || "";

    let session = (await getSession(userPhone)) || {};
    if (!session.history) session.history = [];
    if (!session.order) session.order = {};
    if (!session.state) session.state = "INIT";
    if (!session.lastMediaType) session.lastMediaType = null;

    // =============================
    // MEDIA
    // =============================
    if (
      msgType === "image" ||
      msgType === "audio" ||
      msgType === "sticker" ||
      msgType === "video" ||
      msgType === "document"
    ) {
      session.lastMediaType = msgType;

      await sendWhatsAppText(
        userPhone,
        "Recibido 😊✨\nSi te refieres al producto que estábamos viendo, dime *sí* o la cantidad 🛒💗"
      );

      await setSession(userPhone, session);
      return res.sendStatus(200);
    }

    // =============================
    // TEXT
    // =============================
    if (msgType === "text") {
      const userText = msg.text?.body?.trim() || "";
      const lowText = normalizeText(userText);

      // Buscar producto
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
        session.lastMediaType = null;
        await setSession(userPhone, session);
        return res.sendStatus(200);
      }

      // Referencia tipo “sí/ese/el de la foto”
      const referentialNow = isReferencingPreviousProduct(userText);
      if (!found && referentialNow && session.product) {
        currentProduct = session.product;
      }

      // ✅ UPGRADE: cantidad aunque no diga "quiero comprar"
      const qtyFromText = extractQuantity(userText);
      const shortMessage = normalizeText(userText).split(" ").filter(Boolean).length <= 6;

      if (
        qtyFromText &&
        qtyFromText > 0 &&
        currentProduct &&
        (referentialNow || shortMessage) &&
        session.state !== "AWAIT_LOCATION"
      ) {
        session.order.quantity = qtyFromText;
        session.state = "AWAIT_LOCATION";

        await sendWhatsAppText(
          userPhone,
          `✅ Perfecto 😊🛒\nAnoté *${qtyFromText}* unidad(es) de *${currentProduct.name}*.\nAhora envíame tu ubicación 📍\n(clip 📎 > Ubicación > Enviar)`
        );

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
        session.lastMediaType = null;
        await setSession(userPhone, session);
        return res.sendStatus(200);
      }

      // Intención de compra
      const wantsToBuy =
        referentialNow ||
        lowText.includes("quiero") ||
        lowText.includes("pedir") ||
        lowText.includes("comprar") ||
        lowText.includes("me lo llevo") ||
        lowText.includes("ordenar");

      // Si quiere comprar → pedir cantidad
      if (wantsToBuy && session.state !== "AWAIT_LOCATION") {
        session.state = "AWAIT_QUANTITY";
        await sendWhatsAppText(
          userPhone,
          `Perfecto 😊🛒\n¿Cuántas unidades de *${currentProduct.name}* deseas?`
        );
        await setSession(userPhone, session);
        return res.sendStatus(200);
      }

      // Esperando cantidad
      if (session.state === "AWAIT_QUANTITY") {
        const q = extractQuantity(userText);

        if (!q || q <= 0) {
          await sendWhatsAppText(userPhone, "¿Cuántas unidades deseas? 😊\n(Ej: 1, 2, 3)");
          await setSession(userPhone, session);
          return res.sendStatus(200);
        }

        session.order.quantity = q;
        session.state = "AWAIT_LOCATION";

        await sendWhatsAppText(
          userPhone,
          `✅ Anotado: *${q}* unidad(es) 😊🛒\nAhora envíame tu ubicación 📍\n(clip 📎 > Ubicación > Enviar)`
        );

        await setSession(userPhone, session);
        return res.sendStatus(200);
      }

      // Q&A con IA
      const aiReply = await callOpenAI(session, currentProduct, userText);
      await sendWhatsAppText(userPhone, aiReply);

      session.history.push({ user: userText, assistant: aiReply });
      if (session.history.length > 6) session.history.shift();

      if (!session.sentImage && currentProduct.image) {
        await sendWhatsAppImage(userPhone, currentProduct.image, currentProduct.name);
        session.sentImage = true;
      }

      session.state = "Q&A";
      await setSession(userPhone, session);
      return res.sendStatus(200);
    }

    // =============================
    // LOCATION (✅ finaliza sin pago)
    // =============================
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

        const order = session.order;
        const productName = session.product?.name || "Producto";
        const qty = order.quantity || 1;

        // ✅ MENSAJE FINAL AL CLIENTE
        await sendWhatsAppText(
          userPhone,
          "Perfecto 🤩 unos de nuestros representantes te estará contactando con los detalles de envíos y pagos."
        );

        // ✅ MENSAJE AL ADMIN
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
${locationInfo}

📝 Nota: Confirmar pago y envío manualmente con la clienta.`;

          await sendWhatsAppText(ADMIN_PHONE, adminMsg);
        }

        // Reset sesión
        session.state = "INIT";
        session.order = {};
        session.history = [];
        session.product = null;
        session.sentImage = false;
        session.lastMediaType = null;

        await setSession(userPhone, session);
        return res.sendStatus(200);
      }

      await sendWhatsAppText(userPhone, "Recibí tu ubicación 😊📍\n¿Te ayudo a pedir algún producto? 💗");
      await setSession(userPhone, session);
      return res.sendStatus(200);
    }

    // Interactive (lo dejamos por si llega alguno)
    if (msgType === "interactive") {
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
