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

// Match 1 producto (se mantiene igual)
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

// Buscar MUCHOS productos por palabra clave
function findProductsByKeyword(keyword, limit = 12) {
  const key = normalizeText(keyword);
  if (!key) return [];

  const results = [];

  for (const p of catalog) {
    const name = normalizeText(p.name || "");
    const category = normalizeText(p.category || "");
    const desc = normalizeText(p.description || "");
    const type = normalizeText(p.type || "");
    const how = normalizeText(p.how_to_use || "");
    const ing = normalizeText(p.ingredients || "");

    if (
      name.includes(key) ||
      category.includes(key) ||
      desc.includes(key) ||
      type.includes(key) ||
      how.includes(key) ||
      ing.includes(key)
    ) {
      results.push(p);
    }
  }

  const unique = [];
  const seen = new Set();
  for (const r of results) {
    if (!seen.has(r.id)) {
      unique.push(r);
      seen.add(r.id);
    }
  }

  return unique.slice(0, limit);
}

// Detecta si la clienta está pidiendo LISTA
function isListIntent(textNorm) {
  const t = textNorm || "";
  return (
    t.includes("cuales") ||
    t.includes("cuáles") ||
    t.includes("que tienes") ||
    t.includes("qué tienes") ||
    t.includes("que hay") ||
    t.includes("qué hay") ||
    t.includes("tienes de") ||
    t.includes("hay de") ||
    t.includes("lista") ||
    t.includes("muestrame") ||
    t.includes("muéstrame") ||
    t.includes("disponible") ||
    t.includes("disponibles") ||
    t.includes("opciones") ||
    t.includes("variedad")
  );
}

// Encontrar keyword principal
function extractMainKeyword(userText) {
  const norm = normalizeText(userText);
  const words = norm.split(" ").filter(Boolean);

  const cleaned = words.filter(
    (w) => !SPANISH_STOPWORDS.has(w) && !BRAND_WORDS.has(w) && w.length >= 3
  );

  return cleaned[cleaned.length - 1] || "";
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
      "❌ Error guardando sesión en Redis:",
      error?.response?.data || error
    );
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
// AUDIO TRANSCRIPTION
// =============================
async function getWhatsAppMediaUrl(mediaId) {
  const url = `https://graph.facebook.com/v20.0/${mediaId}`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
  });

  return {
    url: res.data?.url,
    mime_type: res.data?.mime_type || "audio/ogg",
  };
}

async function downloadWhatsAppMedia(mediaUrl) {
  const res = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
  });
  return Buffer.from(res.data);
}

async function transcribeAudioBuffer(buffer, mimeType = "audio/ogg") {
  try {
    const blob = new Blob([buffer], { type: mimeType });
    const file = new File([blob], "audio.ogg", { type: mimeType });

    const form = new FormData();
    form.append("model", "gpt-4o-mini-transcribe");
    form.append("language", "es");
    form.append("file", file);

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });

    const data = await response.json();
    return (data?.text || "").trim();
  } catch (err) {
    console.error("❌ Error transcribiendo audio:", err);
    return "";
  }
}

async function transcribeWhatsAppAudio(mediaId) {
  if (!mediaId) return "";
  if (!WA_TOKEN) return "";
  if (!OPENAI_API_KEY) return "";

  const media = await getWhatsAppMediaUrl(mediaId);
  if (!media?.url) return "";

  const audioBuffer = await downloadWhatsAppMedia(media.url);
  const transcript = await transcribeAudioBuffer(audioBuffer, media.mime_type);

  return transcript;
}

// =============================
// OPENAI CHAT
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
    if (!session.listResults) session.listResults = [];

    // =============================
    // CENTRAL TEXT HANDLER
    // =============================
    async function handleUserText(userText) {
      const lowText = normalizeText(userText);

      // ✅✅ CAMBIO ÚNICO: si estamos esperando que elija un producto de la lista,
      // ahora puede escoger por número O por nombre/parcial.
      if (session.state === "AWAIT_PRODUCT_PICK" && Array.isArray(session.listResults)) {
        // 1) si manda número
        const digitMatch = userText.match(/\d+/);
        const pick = digitMatch ? parseInt(digitMatch[0], 10) : null;

        if (pick && pick >= 1 && pick <= session.listResults.length) {
          const chosen = session.listResults[pick - 1];
          if (chosen) {
            session.product = chosen;
            session.state = "Q&A";
            session.listResults = [];

            await sendWhatsAppText(
              userPhone,
              `Perfecto 😊✨\nElegiste: *${chosen.name}* 🛒💗\n¿Deseas pedirlo o tienes alguna pregunta?`
            );

            if (!session.sentImage && chosen.image) {
              await sendWhatsAppImage(userPhone, chosen.image, chosen.name);
              session.sentImage = true;
            }

            await setSession(userPhone, session);
            return;
          }
        }

        // 2) si manda nombre o parte del nombre
        const typed = normalizeText(userText);
        if (typed && typed.length >= 3) {
          let best = null;
          let bestScore = 0;

          for (const p of session.listResults) {
            const pName = normalizeText(p?.name || "");
            if (!pName) continue;

            // Score simple: si contiene el texto o viceversa
            let score = 0;
            if (pName.includes(typed)) score += 5;
            if (typed.includes(pName)) score += 2;

            // score extra por palabras en común
            const typedWords = typed.split(" ").filter(Boolean);
            const nameWords = pName.split(" ").filter(Boolean);
            const common = typedWords.filter((w) => nameWords.includes(w)).length;
            score += common;

            if (score > bestScore) {
              bestScore = score;
              best = p;
            }
          }

          if (best && bestScore >= 2) {
            session.product = best;
            session.state = "Q&A";
            session.listResults = [];
            session.sentImage = false;

            await sendWhatsAppText(
              userPhone,
              `Perfecto 😊✨\nElegiste: *${best.name}* 🛒💗\n¿Deseas pedirlo o tienes alguna pregunta?`
            );

            if (!session.sentImage && best.image) {
              await sendWhatsAppImage(userPhone, best.image, best.name);
              session.sentImage = true;
            }

            await setSession(userPhone, session);
            return;
          }
        }

        // si no logró seleccionar
        await sendWhatsAppText(
          userPhone,
          `Dime el número o el nombre del producto 😊\n(Ej: 1, 2, 3 o “loción aloe”) 💗`
        );
        await setSession(userPhone, session);
        return;
      }

      // Detectar intención de lista
      if (isListIntent(lowText)) {
        const keyword = extractMainKeyword(userText);
        const matches = findProductsByKeyword(keyword, 12);

        if (!keyword || matches.length === 0) {
          await sendWhatsAppText(
            userPhone,
            `Claro 😊💗\n¿De cuál producto o palabra quieres la lista?\n(Ej: “aloe”, “colágeno”, “magnesio”, “crema”)`
          );
          session.state = "INIT";
          await setSession(userPhone, session);
          return;
        }

        let listText = `✨ Estos son los productos que tengo con *${keyword}*:\n\n`;
        matches.forEach((p, i) => {
          listText += `${i + 1}) *${p.name}* — RD$${p.price}\n`;
        });

        listText += `\n💗 Dime el número o el nombre del que te interesa 😊`;

        session.listResults = matches;
        session.state = "AWAIT_PRODUCT_PICK";
        session.product = null;
        session.sentImage = false;

        await sendWhatsAppText(userPhone, listText);

        const btnCount = Math.min(3, matches.length);
        const buttons = [];
        for (let i = 1; i <= btnCount; i++) {
          buttons.push({ id: `pick_${i}`, title: `${i}` });
        }

        await sendWhatsAppButtons(userPhone, "Elige una opción:", buttons);

        await setSession(userPhone, session);
        return;
      }

      // Detectar intención de compra (y confirmaciones)
      const wantsToBuy =
        lowText.includes("quiero") ||
        lowText.includes("lo quiero") ||
        lowText.includes("pedir") ||
        lowText.includes("comprar") ||
        lowText.includes("me lo llevo") ||
        lowText.includes("ordenar") ||
        lowText === "si" ||
        lowText === "sí" ||
        lowText === "ok" ||
        lowText === "dale" ||
        lowText === "claro" ||
        lowText === "perfecto" ||
        lowText === "de una" ||
        lowText === "vamos" ||
        lowText === "esta bien" ||
        lowText === "está bien";

      let currentProduct = session.product || null;

      const found = findProductForMessage(userText);
      if (found) {
        currentProduct = found.data;
        session.product = currentProduct;
      }

      // ✅✅ Si escribe SOLO palabra y hay varios productos, lista + botones
      const keywordSolo = extractMainKeyword(userText);
      const multipleMatches = findProductsByKeyword(keywordSolo, 8);

      const isShortKeywordMessage =
        normalizeText(userText).split(" ").filter(Boolean).length <= 2;

      if (
        isShortKeywordMessage &&
        keywordSolo &&
        multipleMatches.length >= 2 &&
        !wantsToBuy
      ) {
        let listText = `😊 Tengo varias opciones con *${keywordSolo}*:\n\n`;
        multipleMatches.forEach((p, i) => {
          listText += `${i + 1}) *${p.name}* — RD$${p.price}\n`;
        });
        listText += `\n💗 Elige el número o dime el nombre 😊`;

        session.listResults = multipleMatches;
        session.state = "AWAIT_PRODUCT_PICK";
        session.product = null;
        session.sentImage = false;

        await sendWhatsAppText(userPhone, listText);

        const btnCount = Math.min(3, multipleMatches.length);
        const buttons = [];
        for (let i = 1; i <= btnCount; i++) {
          buttons.push({ id: `pick_${i}`, title: `${i}` });
        }

        await sendWhatsAppButtons(userPhone, "Elige una opción:", buttons);

        await setSession(userPhone, session);
        return;
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

      // Si no identifica producto
      if (!currentProduct) {
        await sendWhatsAppText(
          userPhone,
          `Disculpa 😔 no logré identificar el producto.\n¿Me dices el nombre o una palabra clave? (Ej: “colágeno”, “aloe”, “magnesio”) 💗`
        );
        session.state = "INIT";
        await setSession(userPhone, session);
        return;
      }

      // Si quiere comprar -> pedir cantidad
      if (
        wantsToBuy &&
        session.state !== "AWAIT_LOCATION" &&
        session.state !== "AWAIT_PAYMENT"
      ) {
        session.state = "AWAIT_QUANTITY";
        await sendWhatsAppText(
          userPhone,
          `Perfecto 😊🛒\n¿Cuántas unidades de *${currentProduct.name}* deseas?`
        );
        await setSession(userPhone, session);
        return;
      }

      // Esperando cantidad
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

      // Q&A normal con IA
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
    // HANDLERS
    // =============================
    if (msgType === "text") {
      const userText = msg.text?.body?.trim() || "";
      await handleUserText(userText);
      return res.sendStatus(200);
    }

    if (msgType === "audio") {
      await sendWhatsAppText(userPhone, "Recibido 😊🎧 Dame un segundito y te respondo…✨");

      const mediaId = msg.audio?.id;
      const transcript = await transcribeWhatsAppAudio(mediaId);

      if (!transcript) {
        await sendWhatsAppText(
          userPhone,
          "No pude escuchar bien el audio 😔\n¿Me lo repites más despacito o me lo escribes? 💗"
        );
        await setSession(userPhone, session);
        return res.sendStatus(200);
      }

      await handleUserText(transcript);
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

        // Botones de selección de producto 1/2/3 (igual)
        if (session.state === "AWAIT_PRODUCT_PICK" && buttonId.startsWith("pick_")) {
          const n = parseInt(buttonId.replace("pick_", ""), 10);
          if (n && session.listResults && session.listResults[n - 1]) {
            const chosen = session.listResults[n - 1];

            session.product = chosen;
            session.state = "Q&A";
            session.listResults = [];
            session.sentImage = false;

            await sendWhatsAppText(
              userPhone,
              `Perfecto 😊✨\nElegiste: *${chosen.name}* 🛒💗\n¿Deseas pedirlo o tienes alguna pregunta?`
            );

            if (!session.sentImage && chosen.image) {
              await sendWhatsAppImage(userPhone, chosen.image, chosen.name);
              session.sentImage = true;
            }

            await setSession(userPhone, session);
            return res.sendStatus(200);
          }

          await sendWhatsAppText(userPhone, "Disculpa 😊💗 no pude seleccionar esa opción. ¿Me dices el número?");
          await setSession(userPhone, session);
          return res.sendStatus(200);
        }

        // Botones de pago (igual)
        if (session.state === "AWAIT_PAYMENT") {
          if (buttonId === "pay_cash") session.order.payment = "Contra entrega";
          if (buttonId === "pay_transfer") session.order.payment = "Transferencia";
        }

        // Finalizar pedido si ya hay pago (mensaje final nuevo SIN pago)
        if (session.state === "AWAIT_PAYMENT" && session.order.payment) {
          const order = session.order;
          const productName = session.product?.name || "Producto";
          const qty = order.quantity || 1;

          await sendWhatsAppText(
            userPhone,
            `Perfecto 🤩 unos de nuestros representantes te estará contactando con los detalles de envíos y pagos. 💗`
          );

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

          session.state = "INIT";
          session.order = {};
          session.history = [];
          session.product = null;
          session.sentImage = false;
          session.listResults = [];

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
