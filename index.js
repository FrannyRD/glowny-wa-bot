const express = require("express");

const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "glowny_verify";
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Memoria simple por usuario (se reinicia si Render se reinicia)
const memory = new Map();

function getSystemPrompt() {
  return `
Eres una vendedora experta por WhatsApp de la tienda Glowny Essentials en República Dominicana.

Tu objetivo es:
- Ayudar al cliente
- Recomendar productos
- Resolver dudas
- Cerrar la venta

Productos:
Colágeno en polvo 250g con magnesio y vitamina C.
Precio: RD$900

Envío:
- Santo Domingo: RD$200 contra entrega
- Interior del país: RD$250 por Vimenca o Vimepaq (transferencia)

Reglas:
- Habla natural, amigable y persuasivo
- Pregunta ubicación cuando sea necesario
- Si detectas intención de compra, confirma datos y total
- Nunca digas que eres una IA
`;
}

// Webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Incoming messages
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const message = value?.messages?.[0];
    const from = message?.from;
    const text = message?.text?.body;

    if (!from || !text) return res.sendStatus(200);

    if (!memory.has(from)) {
      memory.set(from, [
        { role: "system", content: getSystemPrompt() }
      ]);
    }

    const chat = memory.get(from);
    chat.push({ role: "user", content: text });

    const aiResponse = await getChatGPTResponse(chat);

    chat.push({ role: "assistant", content: aiResponse });

    await sendWhatsAppMessage(from, aiResponse);

    return res.sendStatus(200);
  } catch (err) {
    console.error(err);
    return res.sendStatus(200);
  }
});

async function getChatGPTResponse(messages) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.7
    })
  });

  const data = await response.json();
  return data.choices[0].message.content;
}

async function sendWhatsAppMessage(to, message) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message }
    })
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Bot running on port " + PORT));
