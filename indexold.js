const express = require("express");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json());

// 🔐 Variables de entorno
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "glowny_verify";
const WA_TOKEN = process.env.WA_TOKEN; // Token de WhatsApp Cloud
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // ID de número
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // API key de OpenAI

// 🧠 Memoria simple por número de WhatsApp
// Map: waNumber -> [{ role, content }, ...]
const memory = new Map();

function getSystemPrompt() {
  return `
Eres un asistente de ventas por WhatsApp de la tienda "Glowny Essentials" en República Dominicana.
Tu objetivo: ayudar al cliente, recomendar y cerrar ventas.

REGLAS:
- Escribe siempre en ESPAÑOL neutro, tono cálido y profesional.
- Responde corto y claro (3–5 líneas máximo).
- Siempre que veas oportunidad, guía a la COMPRA.
- Pregunta datos clave solo cuando tenga sentido (tipo de piel, zona de entrega, etc.).
- Si el cliente pregunta por precio, sé directa y clara.

PRODUCTOS PRINCIPALES (ejemplos):
1) Colágeno sabor limón con magnesio y vitamina C – RD$900
   - Beneficios: articulaciones, piel, uñas, cabello, energía.
   - Forma de uso: 1 scoop diario disuelto en agua.

2) Protectores solares Deliplus FPS 50+
   - Facial, corporal, infantil, en spray, protector labial.
   - Recomendados para uso diario en RD.

SIEMPRE:
- Si el cliente muestra intención de compra, pide:
  • Nombre
  • Teléfono
  • Sector / ciudad
  • Método de pago (transferencia / contra entrega)
- Nunca inventes precios nuevos, si dudas di que el precio de referencia es RD$900 y que puede variar por ofertas.

Si no entiendes algo, pide aclaración con amabilidad.
`;
}

// 🧩 Llamada a OpenAI
async function callChatGPT(waNumber, userText) {
  if (!OPENAI_API_KEY) {
    console.error("❌ Falta OPENAI_API_KEY en las variables de entorno");
    return "Ahora mismo tengo un problema técnico con el asistente. ¿Puedes escribirnos por Instagram mientras lo solucionamos, por favor?";
  }

  // Mensajes previos del usuario (memoria corta)
  const history = memory.get(waNumber) || [];

  const messages = [
    { role: "system", content: getSystemPrompt() },
    ...history,
    { role: "user", content: userText },
  ];

  console.log("🧠 Enviando a OpenAI para:", waNumber);
  console.log(
    "🧠 Último mensaje del cliente:",
    userText?.slice(0, 200) || "(vacío)"
  );

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(
      "❌ Error desde OpenAI:",
      response.status,
      response.statusText,
      errorText
    );
    return "Estamos teniendo un inconveniente con el asistente en este momento. Intenta de nuevo en unos minutos, por favor.";
  }

  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content || "";

  // Actualizamos memoria (máx 8 mensajes para no crecer infinito)
  const newHistory = [...history, { role: "user", content: userText }, { role: "assistant", content: reply }];
  const trimmed = newHistory.slice(-8);
  memory.set(waNumber, trimmed);

  console.log("🤖 Respuesta generada por OpenAI:", reply?.slice(0, 200));

  return reply;
}

// ✅ Verificación de Webhook (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("📥 Petición GET /webhook para verificación", {
    mode,
    tokenReceived: token,
  });

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado correctamente");
    return res.status(200).send(challenge);
  }

  console.warn("⚠️ Verificación de webhook fallida");
  return res.sendStatus(403);
});

// 📩 Recepción de mensajes (POST)
app.post("/webhook", async (req, res) => {
  try {
    console.log("📩 Webhook POST recibido");
    console.log("📦 Body bruto:", JSON.stringify(req.body, null, 2));

    const body = req.body;

    // Validar estructura básica de WhatsApp Cloud
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) {
      console.log("ℹ️ No hay mensaje en el payload (puede ser un evento de estado)");
      return res.sendStatus(200);
    }

    const from = message.from; // número del cliente
    const text = message.text?.body || message.interactive?.button_reply?.title || "";

    console.log("👤 Mensaje entrante de:", from);
    console.log("💬 Texto recibido:", text);

    if (!from || !text) {
      console.log("ℹ️ No hay texto que procesar");
      return res.sendStatus(200);
    }

    // 👉 Llamamos a OpenAI para generar la respuesta
    const replyText = await callChatGPT(from, text);

    // 👉 Enviamos la respuesta al cliente
    await sendWhatsAppMessage(from, replyText);

    console.log("✅ Respuesta enviada correctamente a:", from);

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error manejando el webhook:", err);
    return res.sendStatus(200); // WhatsApp recomienda 200 incluso en errores
  }
});

// 🚀 Enviar mensaje por WhatsApp Cloud API
async function sendWhatsAppMessage(to, messageText) {
  if (!WA_TOKEN || !PHONE_NUMBER_ID) {
    console.error(
      "❌ Faltan WA_TOKEN o PHONE_NUMBER_ID en las variables de entorno"
    );
    return;
  }

  console.log("📤 Enviando mensaje a WhatsApp:", { to, messageText });

  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: messageText },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const t = await resp.text();
    console.error("❌ Error enviando mensaje a WhatsApp:", resp.status, t);
  } else {
    const data = await resp.json();
    console.log("✅ Respuesta de WhatsApp API:", JSON.stringify(data, null, 2));
  }
}

// Ruta simple para comprobar que el server corre
app.get("/", (req, res) => {
  res.send("Glowny WA Bot está corriendo ✅");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot corriendo en el puerto ${PORT}`);
});
