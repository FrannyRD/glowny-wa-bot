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

// Stopwords + palabras muy comunes
const SPANISH_STOPWORDS = new Set([
  "de","la","y","con","para","del","en","el","al","por","una","un","unos","unas",
  "lo","los","las","le","les","tu","su","sus","mi","mis","que","me","te","se",
  "a","o","u","es","son","esto","esta","estas","estos","ese","esa","eses","esas",
  "porfa","porfavor","favor","ahi","aqui","aquí","allá","alla","ahí"
]);

const BRAND_WORDS = new Set(["deliplus", "nivea", "sisbela", "florena"]);

const GENERIC_WORDS = new Set([
  "producto","productos","lista","dime","todos","todas","cuales","cuáles",
  "tienes","tenga","disponible","disponibles","hay","quiero","necesito",
  "ver","muestrame","muéstrame","ensename","enséñame","recomiendame","recomiéndame",
  "otra","otro","cambiar","cambio","buscar","busco",
  // Evitar el bug de “cómo se usa”
  "como","cómo","usa","usar","uso","usarlo","usarla","usarse","usas","usan"
]);

// Confirmaciones para avanzar
const CONFIRM_WORDS = new Set([
  "si","sí","sii","siii","sip","sipi","ok","okay","okey","dale","va","deuna","de una",
  "claro","perfecto","listo","bien","correcto","confirmo","acepto","haganlo","hagalo",
  "hagámoslo","hagamelo","házmelo","hazmelo"
]);

function isConfirmation(text) {
  const t = normalizeText(text);
  if (!t) return false;
  if (CONFIRM_WORDS.has(t)) return true;
  const words = t.split(" ");
  return words.some((w) => CONFIRM_WORDS.has(w));
}

function wantsOtherProduct(text) {
  const t = normalizeText(text);
  return (
    t === "otro" ||
    t === "otra" ||
    t.includes("otro producto") ||
    t.includes("otra cosa") ||
    t.includes("quiero otro") ||
    t.includes("cambiar producto") ||
    t.includes("cambio de producto") ||
    t.includes("ver otro") ||
    t.includes("seguir viendo")
  );
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
    nameNorm,
    descNorm: normalizeText(prod.description || ""),
    catNorm: normalizeText(prod.category || ""),
    typeNorm: normalizeText(prod.type || ""),
  };
});

// Match “mejor producto” (1 resultado)
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

// ✅ Match “lista de productos por palabra” (varios resultados)
function findProductsByKeyword(keyword) {
  const k = normalizeText(keyword);
  if (!k) return [];

  if (GENERIC_WORDS.has(k) || SPANISH_STOPWORDS.has(k)) return [];

  const results = [];

  for (const item of productIndex) {
    const inName = item.nameNorm.includes(k);
    const inDesc = item.descNorm.includes(k);
    const inCat = item.catNorm.includes(k);
    const inType = item.typeNorm.includes(k);

    if (inName || inDesc || inCat || inType) {
      results.push(item.data);
    }
  }

  return results;
}

// Detectar intención de "lista"
function isListIntent(text) {
  const t = normalizeText(text);
  if (!t) return false;

  if (
    t.includes("como se usa") ||
    t.includes("cómo se usa") ||
    t.includes("como usar")
  ) {
    return false;
  }

  return (
    t.includes("dime todos") ||
    t.includes("dime todas") ||
    t.includes("cuales tienes") ||
    t.includes("cuáles tienes") ||
    t.includes("cuales son") ||
    t.includes("cuáles son") ||
    t.includes("que tienes") ||
    t.includes("qué tienes") ||
    t.includes("lista") ||
    t.includes("muestrame") ||
    t.includes("muéstrame") ||
    t.includes("disponible") ||
    t.includes("disponibles")
  );
}

// Extraer palabra clave para listar
function extractKeywordForList(text) {
  const t = normalizeText(text);

  const quoted = text.match(/"([^"]+)"/);
  if (quoted && quoted[1]) return quoted[1];

  const deMatch = t.match(/\bde\s+([a-z0-9ñáéíóúü]+)/i);
  if (deMatch && deMatch[1]) return deMatch[1];

  const words = t.split(" ").filter(Boolean);

  let candidates = words.filter(
    (w) =>
      !SPANISH_STOPWORDS.has(w) &&
      !GENERIC_WORDS.has(w) &&
      w.length >= 3
  );

  if (candidates.length === 0) return words[words.length - 1] || "";
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}

// Formato lista bonita
function formatProductList(products, keyword) {
  const top = products.slice(0, 10);
  const lines = top.map((p, idx) => {
    const price = p.price ? `RD$${p.price}` : "";
    return `${idx + 1}) *${p.name}* ${price ? `— ${price}` : ""}`;
  });

  return `✨ Estos son los productos que tengo con *${keyword}*:\n\n${lines.join(
    "\n"
  )}\n\nDime el número o el nombre del producto 😊💗`;
}

// Reset para pedir otro producto
function resetToChooseNewProduct(session) {
  session.state = "INIT";
  session.order = {};
  session.product = null;
  session.sentImage = false;
  session.awaitingListChoice = false;
  session.listCandidates = [];
  return session;
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
// ✅ messaging_product: "whatsapp"
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

// =============================
// OPENAI - CHAT
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
// ✅ OPENAI - AUDIO TRANSCRIPTION (UPGRADE)
// =============================
function getFileExtFromMime(mime) {
  const m = (mime || "").toLowerCase();
  if (m.includes("ogg")) return "ogg";
  if (m.includes("mpeg")) return "mp3";
  if (m.includes("mp4")) return "mp4";
  if (m.includes("wav")) return "wav";
  if (m.includes("webm")) return "webm";
  return "ogg";
}

async function fetchWhatsAppMedia(mediaId) {
  // 1) Obtener URL del media
  const metaUrl = `https://graph.facebook.com/v20.0/${mediaId}`;
  const metaRes = await axios.get(metaUrl, {
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
  });

  const mediaUrl = metaRes.data?.url;
  const mimeType = metaRes.data?.mime_type || "audio/ogg";

  if (!mediaUrl) throw new Error("No se pudo obtener URL del media");

  // 2) Descargar el archivo binario
  const fileRes = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
  });

  return { buffer: fileRes.data, mimeType };
}

async function transcribeAudioToText(buffer, mimeType) {
  if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");

  // ✅ Node 18+ tiene fetch/FormData/Blob global
  const ext = getFileExtFromMime(mimeType);
  const fileName = `audio.${ext}`;

  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("language", "es");

  const blob = new Blob([buffer], { type: mimeType });
  form.append("file", blob, fileName);

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: form,
  });

  const data = await resp.json();
  if (!resp.ok) {
    console.error("❌ Error transcripción:", data);
    throw new Error("Fallo transcripción");
  }

  return (data.text || "").trim();
}

// =============================
// ✅ TEXT PROCESSOR (reutilizable para texto y audio)
// =============================
async function processUserText({
  userPhone,
  customerName,
  session,
  userText,
}) {
  const lowText = normalizeText(userText);

  // ✅ “otro producto” en cualquier punto → resetea
  if (wantsOtherProduct(userText)) {
    resetToChooseNewProduct(session);
    await sendWhatsAppText(
      userPhone,
      `Perfecto 😊✨\n¿Cuál producto deseas ahora? (Ej: “aloe”, “colágeno”, “exfoliante”) 💗`
    );
    await setSession(userPhone, session);
    return;
  }

  // ✅ Si está esperando cantidad y dicen “ok/si/dale”
  if (session.state === "AWAIT_QUANTITY" && isConfirmation(userText)) {
    await sendWhatsAppText(
      userPhone,
      `Perfecto 😊🛒\nSolo dime la cantidad por favor (Ej: 1, 2, 3).`
    );
    await setSession(userPhone, session);
    return;
  }

  // ✅ Intención de lista (“dime todos los aloe / cuales aloe tienes”)
  if (isListIntent(userText)) {
    const keyword = extractKeywordForList(userText);
    const list = findProductsByKeyword(keyword);

    if (list.length === 0) {
      await sendWhatsAppText(
        userPhone,
        `Mmm 🤔 no encontré productos con *${keyword}*.\n¿Me dices otra palabra? (Ej: “aloe”, “repara”, “magnesio”) 💗`
      );
      await setSession(userPhone, session);
      return;
    }

    session.awaitingListChoice = true;
    session.listCandidates = list;

    await sendWhatsAppText(userPhone, formatProductList(list, keyword));
    await setSession(userPhone, session);
    return;
  }

  // ✅ Si está esperando selección de una lista y el cliente escribe número o nombre
  if (session.awaitingListChoice && session.listCandidates?.length > 0) {
    const digitMatch = userText.match(/\d+/);
    let selected = null;

    if (digitMatch) {
      const idx = parseInt(digitMatch[0], 10) - 1;
      if (idx >= 0 && idx < session.listCandidates.length) {
        selected = session.listCandidates[idx];
      }
    }

    if (!selected) {
      const norm = normalizeText(userText);
      selected = session.listCandidates.find((p) =>
        normalizeText(p.name).includes(norm)
      );
    }

    if (selected) {
      session.product = selected;
      session.awaitingListChoice = false;
      session.listCandidates = [];
      session.state = "Q&A";
      session.sentImage = false;

      await sendWhatsAppText(
        userPhone,
        `¡Perfecto! 😊✨\nHablemos de *${selected.name}* 💗\n¿Te gustaría más info o hacemos tu pedido? 🛒`
      );

      if (selected.image) {
        await sendWhatsAppImage(userPhone, selected.image, selected.name);
        session.sentImage = true;
      }

      await setSession(userPhone, session);
      return;
    } else {
      await sendWhatsAppText(
        userPhone,
        `No logré identificar cuál 😔\nDime el número o el nombre del producto (Ej: 1 o “loción aloe”) 💗`
      );
      await setSession(userPhone, session);
      return;
    }
  }

  // Detectar intención de compra (más fácil)
  const wantsToBuy =
    lowText.includes("quiero") ||
    lowText.includes("lo quiero") ||
    lowText.includes("pedir") ||
    lowText.includes("comprar") ||
    lowText.includes("me lo llevo") ||
    lowText.includes("ordenar") ||
    lowText === "si" ||
    lowText === "sí";

  // Producto actual
  let currentProduct = session.product || null;

  // ✅ Si el mensaje es una sola palabra “aloe / repara” y hay varios → lista
  if (!currentProduct) {
    const simpleWord = lowText.split(" ").length === 1 ? lowText : "";
    if (simpleWord && !GENERIC_WORDS.has(simpleWord)) {
      const list = findProductsByKeyword(simpleWord);
      if (list.length >= 2) {
        session.awaitingListChoice = true;
        session.listCandidates = list;
        await sendWhatsAppText(userPhone, formatProductList(list, simpleWord));
        await setSession(userPhone, session);
        return;
      }
    }
  }

  // Buscar mejor match si no hay producto
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
    return;
  }

  // No se identifica producto
  if (!currentProduct) {
    await sendWhatsAppText(
      userPhone,
      `Disculpa 😔 no logré identificar el producto.\n¿Me dices el nombre o una palabra clave? (Ej: “aloe”, “colágeno”, “repara”) 💗`
    );
    session.state = "INIT";
    await setSession(userPhone, session);
    return;
  }

  // ✅ Compra → pedir cantidad
  if (wantsToBuy && session.state !== "AWAIT_LOCATION") {
    session.state = "AWAIT_QUANTITY";
    await sendWhatsAppText(
      userPhone,
      `Perfecto 😊🛒\n¿Cuántas unidades de *${currentProduct.name}* deseas?`
    );
    await setSession(userPhone, session);
    return;
  }

  // ✅ Esperando cantidad
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
      return;
    }

    session.order.quantity = quantity;
    session.state = "AWAIT_LOCATION";

    await sendWhatsAppText(
      userPhone,
      `✅ Anotado: *${quantity}* unidad(es) 😊🛒\nAhora envíame tu ubicación 📍 (clip 📎 > Ubicación > Enviar).`
    );
    await setSession(userPhone, session);
    return;
  }

  // ✅ Q&A con IA (uso, duración, etc)
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
    if (!session.listCandidates) session.listCandidates = [];
    if (!session.awaitingListChoice) session.awaitingListChoice = false;

    // ✅ TEXT
    if (msgType === "text") {
      const userText = msg.text?.body?.trim() || "";
      await processUserText({ userPhone, customerName, session, userText });
      return res.sendStatus(200);
    }

    // ✅ AUDIO UPGRADE (NOTA DE VOZ)
    if (msgType === "audio") {
      try {
        const mediaId = msg.audio?.id;
        if (!mediaId) {
          await sendWhatsAppText(
            userPhone,
            "No pude leer el audio 😔\n¿Me lo escribes por favor? 💗"
          );
          return res.sendStatus(200);
        }

        // 1) Descargar audio desde WhatsApp
        const { buffer, mimeType } = await fetchWhatsAppMedia(mediaId);

        // 2) Transcribir con OpenAI Whisper
        const transcript = await transcribeAudioToText(buffer, mimeType);

        if (!transcript) {
          await sendWhatsAppText(
            userPhone,
            "No pude entender el audio 😔\n¿Me lo repites más despacito o me lo escribes? 💗"
          );
          return res.sendStatus(200);
        }

        // 3) Procesarlo como texto normal
        await processUserText({
          userPhone,
          customerName,
          session,
          userText: transcript,
        });

        return res.sendStatus(200);
      } catch (err) {
        console.error("❌ Error audio:", err);
        await sendWhatsAppText(
          userPhone,
          "No pude entender el audio 😔\n¿Me lo escribes por favor? 💗"
        );
        return res.sendStatus(200);
      }
    }

    // ✅ LOCATION (finaliza pedido sin pago)
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

        await sendWhatsAppText(
          userPhone,
          `Perfecto 🤩 unos de nuestros representantes te estará contactando con los detalles de envíos y pagos.`
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
${locationInfo}`;

          await sendWhatsAppText(ADMIN_PHONE, adminMsg);
        }

        resetToChooseNewProduct(session);
        await setSession(userPhone, session);
        return res.sendStatus(200);
      }

      await sendWhatsAppText(
        userPhone,
        "Recibí tu ubicación 😊📍\n¿Te ayudo a pedir algún producto? 💗"
      );
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
