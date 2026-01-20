/**
 * Glowny Essentials WhatsApp Bot (PRO)
 * - Catálogo + precios 100% controlado por código (NO IA para precios)
 * - OpenAI solo para mensajes fuera de lo normal
 * - Memoria real en Upstash (historial completo)
 * - Anti-duplicado por message.id (WhatsApp reintentos)
 * - Flujo inteligente de pedido (Si -> datos de envío)
 */

const express = require("express");

// node-fetch dynamic import (compatible con CommonJS)
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
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-nano"; // ✅ recomendado para bajar tokens
const ADMIN_PHONE = process.env.ADMIN_PHONE || "18492010239"; // sin +
const ORDER_TAG = "PEDIDO_CONFIRMADO:";

// Upstash (Redis REST)
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// =========================
// ✅ TU CATÁLOGO (JSON)
// =========================
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
    id: "0feaf32e-4201-4cbd-ac77-830486f9192c",
    name: "Aceite corporal romero Botella 200 ml Deliplus",
    price: 550,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.36263807809930526.jpg",
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
    id: "144c0a12-1549-4a07-b11e-84e16fcb9217",
    name: "Crema facial protectora anti-manchas Deliplus FPS 50+ todo tipo de piel 50 ml",
    price: 900,
    category: "Rostro",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.766836007795388.jpg",
  },
  {
    id: "2382b32e-952c-46a7-85f0-4716ecc8216e",
    name: "Toallitas Limpiagafas Bosque Verde monodosis perfumadas 32und",
    price: 450,
    category: "Otros",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.9901194809376783.jpg",
  },
  {
    id: "2816c73d-ec50-49f0-9311-848539849ae7",
    name: "Desodorante para pies fresh & dry Deliplus antitranspirante spray 150 ml",
    price: 400,
    category: "Otros",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7412669567328445.jpg",
  },
  {
    id: "2f57e03f-4d2e-4dc6-bd8a-13abda985333",
    name: "Deliplus Gel higiene intimo liquido hidratante con dosificador 500 ml",
    price: 500,
    category: "Higiene íntima",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7787574431351961.jpg",
  },
  {
    id: "363d9ce6-cde3-4e3d-b569-94be86fa0fb7",
    name: "Exfoliante corporal mineral Deliplus Mar Muerto 400 ml",
    price: 650,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.964762992512799.jpg",
  },
  {
    id: "38dac334-d123-4a85-bca1-b0c2e805a4e9",
    name: "Exfoliante corporal marino Deliplus Sal Mar Muerto 400 g",
    price: 650,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.3357927369198168.jpg",
  },
  {
    id: "45c3abbe-206d-4568-8810-8cb07c844fa4",
    name: "Gel de baño tiernos recuerdos Deliplus piel normal 750 ml",
    price: 350,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7576058214157932.jpg",
  },
  {
    id: "4f900df6-82b0-4ffc-a3f3-0a65731d8394",
    name: "Exfoliante Arcilla Blanca Facial Clean Deliplus piel normal o mixta 100 ml",
    price: 600,
    category: "Rostro",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.9089123499909787.jpg",
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
    id: "55e72417-24eb-4d69-9972-cca5fc3edf8a",
    name: "Crema protección solar infantil FPS 50+ Deliplus para pieles sensibles y atópicas",
    price: 650,
    category: "Rostro",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.8439793539752637.jpg",
  },
  {
    id: "615f78c9-b15d-422e-9260-893132c135d8",
    name: "Gel refrescante mentol Deliplus para pies y piernas 300 ml",
    price: 550,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.13998940319484232.jpg",
  },
  {
    id: "61f74869-4dbe-4213-91e4-e79d08e9f008",
    name: "Loción corporal Calm Deliplus omega 3, 6, 9 y niacinamida piel sensible y atópica 400 ml",
    price: 450,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.8733127834132417.jpg",
  },
  {
    id: "671e458a-fdcd-47b3-93d4-cd21af1005ab",
    name: "Loción corporal Repara Deliplus urea 10% y dexpantenol piel muy seca 400 ml",
    price: 450,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.6565286896440724.jpg",
  },
  {
    id: "6e5c316e-25b9-429c-ba79-c549f6d20423",
    name: "Loción corporal Hidrata Deliplus aloe vera y ácido hialurónico piel normal 600 g",
    price: 550,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.4615014729316803.jpg",
  },
  {
    id: "71dc99d1-e026-4aec-b116-e6c4e14638d5",
    name: "Crema corporal Nivea 250 ml",
    price: 600,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.8937379278968904.jpg",
  },
  {
    id: "80b3d654-8381-4bad-b29c-6bbc3043c3d6",
    name: "Gel facial limpiador Facial clean todo tipo de piel Deliplus 250 ml",
    price: 500,
    category: "Rostro",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.14096114588484898.jpg",
  },
  {
    id: "88539069-1373-48ee-a1d1-31430869815a",
    name: "Gel de baño frutal Deliplus piel normal 750 ml",
    price: 350,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.6750012951424128.jpg",
  },
  {
    id: "8b6f913b-9eff-4233-96c5-d483b70f09a4",
    name: "Crema de manos hidratante con aloe vera Deliplus 75 ml",
    price: 350,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7971261774222368.jpg",
  },
  {
    id: "8eb7cdea-a920-489a-97ad-60f3ec58497a",
    name: "Comprimidos efervescentes vitamina C y zinc Deliplus sabor limón 20und/80g",
    price: 400,
    category: "Suplementos",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7343292665638652.jpg",
  },
  {
    id: "901ffafd-9ce6-48ec-8b14-87bd993a62ef",
    name: "Gel de baño vainilla y miel Deliplus piel normal 750 ml",
    price: 350,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.9119627229156263.jpg",
  },
  {
    id: "92d65ef0-475e-4b89-ae11-639fd51fb423",
    name: "Concentrado manual Florena con manteca de karité y aceite de argán 50 ml",
    price: 250,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7890441674096778.jpg",
  },
  {
    id: "a0f25ca3-e821-4075-87db-40d97372ee67",
    name: "Serum Facial Potenciador Sisbela Reafirm Deliplus 12% silicio tipo pieles frasco",
    price: 950,
    category: "Rostro",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.8420422814402666.jpg",
  },
  {
    id: "a161e422-0196-435d-9755-0350ed8ac8c5",
    name: "Crema depilatoria mujer para el cuerpo Deliplus piel sensible bajo la ducha incluye manopla 200 ml",
    price: 500,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7471298043382055.jpg",
  },
  {
    id: "aeea794a-564d-49a9-9616-c6122315b423",
    name: "Sérum facial Ácido Hialurónico y Ceramidas Deliplus Hidrata todo tipo de piel 30 ml",
    price: 800,
    category: "Rostro",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/1767924116543-0.399580346122166.jpg",
  },
  {
    id: "b031231b-ac2f-4555-8223-10f7d0cf413c",
    name: "Gel de baño granada y frutos silvestres Deliplus piel normal 750 ml",
    price: 350,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.8889156108119076.jpg",
  },
  {
    id: "c0373445-7be4-49b1-bd3e-d20095d8a264",
    name: "Gel corporal aloe vera Deliplus 400 ml",
    price: 600,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.07272257840533858.jpg",
  },
  {
    id: "c1dfe6da-edca-49ec-88d3-48247ca8f7d8",
    name: "Deliplus Gel de higiene íntimo líquido con dosificador 500 ml",
    price: 500,
    category: "Higiene íntima",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7470060378444082.jpg",
  },
  {
    id: "c37f4b97-2ab7-45db-b79c-6fd7db2afd02",
    name: "Crema de manos nutritiva Karité Deliplus 75 ml",
    price: 350,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.013811606548578825.jpg",
  },
  {
    id: "c3c918b1-e179-4123-9dd1-e1597c447bab",
    name: "Loción corporal Nutre Deliplus almendras y cica piel seca 600 g",
    price: 550,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.1886844553433108.jpg",
  },
  {
    id: "c6e534e2-b54b-4d08-93f9-9d82569f297a",
    name: "Crema protección solar Deliplus FPS 50+ Resistente al agua 100 ml",
    price: 600,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.6036945328427022.jpg",
  },
  {
    id: "d56a63e7-687a-4282-8464-1e6f43e45283",
    name: "Gel de baño avena Deliplus piel sensible 750 ml",
    price: 350,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.10264727845100174.jpg",
  },
  {
    id: "d6791f25-c4ac-4669-8234-ffd0fc3b2f81",
    name: "Gel de baño frescor azul Deliplus piel normal 750 ml",
    price: 350,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.44323230998298535.jpg",
  },
  {
    id: "d695db2e-e466-4ce8-8778-38625b8ae129",
    name: "Gel de baño marino y cedro Deliplus piel normal 750 ml",
    price: 350,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.38823628813402555.jpg",
  },
  {
    id: "dbb208a2-31e2-4a58-9f09-04bb4dba8d18",
    name: "Crema facial noche Deliplus aclarante anti-manchas todo tipo de piel 50 ml",
    price: 900,
    category: "Rostro",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.1687269797256935.jpg",
  },
  {
    id: "e04590e5-aa64-49c2-8346-2ad8c712915b",
    name: "Protector Labial Deliplus FPS 15 1und",
    price: 350,
    category: "Rostro",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.26585338094003164.jpg",
  },
  {
    id: "e150c27a-c825-4390-b2b2-3c539c4ba4c7",
    name: "Crema depilatoria hombre Deliplus piel normal bajo la ducha incluye manopla 200 ml",
    price: 500,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.8309128377524708.jpg",
  },
  {
    id: "e498fd92-e734-4227-9340-7ed097fd79d1",
    name: "Gel de baño 10% urea Deliplus piel áspera y deshidratada 500 ml",
    price: 400,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.47965691702378466.jpg",
  },
  {
    id: "e5504c4e-83f9-4937-b819-9419292da3c8",
    name: "Manteca corporal Murumuru Deliplus 300 ml",
    price: 550,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.17408592890249042.jpg",
  },
  {
    id: "e69f2c20-3841-4af7-9a2e-cbbfec30bb80",
    name: "Leche facial limpiadora Facial Clean todo tipo de piel Deliplus 250 ml",
    price: 450,
    category: "Rostro",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.6289164249460402.jpg",
  },
  {
    id: "e72e17d0-38b8-4aa2-b66f-bd47fd807cb1",
    name: "Crema solar SPF 50+ en formato spray",
    price: 900,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.890999533523696.jpg",
  },
  {
    id: "e7589330-248e-4fd7-a645-3d27e924ad5a",
    name: "Deliplus Crema corporal aceite argan 250 ml",
    price: 450,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.05540865085271529.jpg",
  },
  {
    id: "e88b9703-973e-4b56-901f-0ef39c2e4fca",
    name: "Desodorante piedra de alumbre mineral Deonat para todo tipo de piel 60 g",
    price: 400,
    category: "Otros",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.9331449890013408.jpg",
  },
  {
    id: "ea3e8d68-fd4b-486b-98ac-2408fc05f855",
    name: "Deliplus Crema corporal aceite oliva 250 ml",
    price: 450,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.792738396021052.jpg",
  },
  {
    id: "f1ef9bad-471c-4edc-8436-5b0625f1eaba",
    name: "Gel de baño ambar y vetiver Deliplus piel normal 750 ml",
    price: 350,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.29018513988843364.jpg",
  },
  {
    id: "f7a9aed0-a940-4584-aaf5-807e24c34bd4",
    name: "Deliplus Exfoliante corporal con coco 250 ml",
    price: 650,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.6693914752431569.jpg",
  },
  {
    id: "fa1ac7aa-48e4-4c4b-97f2-0c7ce3f812a9",
    name: "Gel de baño argán Deliplus piel muy seca 500 ml",
    price: 400,
    category: "Cuerpo",
    image:
      "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.3166909672180076.jpg",
  },
];

// =========================
// Upstash Redis REST helpers
// =========================
async function upstashFetch(path, body = null) {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    throw new Error("Faltan UPSTASH_REDIS_REST_URL o UPSTASH_REDIS_REST_TOKEN en ENV");
  }

  const url = `${UPSTASH_REDIS_REST_URL}${path}`;
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  return data;
}

async function redisGet(key) {
  const data = await upstashFetch(`/get/${encodeURIComponent(key)}`);
  return data?.result ?? null;
}

async function redisSet(key, value, ttlSeconds = null) {
  // Upstash REST set: /set/<key>/<value>
  // Para TTL usamos /set + /expire
  await upstashFetch(`/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`);
  if (ttlSeconds) {
    await upstashFetch(`/expire/${encodeURIComponent(key)}/${ttlSeconds}`);
  }
}

async function redisDel(key) {
  await upstashFetch(`/del/${encodeURIComponent(key)}`);
}

async function redisGetJson(key) {
  const raw = await redisGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function redisSetJson(key, obj, ttlSeconds = null) {
  const value = JSON.stringify(obj);
  await redisSet(key, value, ttlSeconds);
}

// =========================
// Keys helpers
// =========================
function memKey(wa) {
  return `glowny:mem:${wa}`;
}
function pendingKey(wa) {
  return `glowny:pending:${wa}`;
}
function lastProdKey(wa) {
  return `glowny:lastprod:${wa}`;
}
function lastReplyKey(wa) {
  return `glowny:lastreply:${wa}`;
}
function seenMsgKey(msgId) {
  return `glowny:seen:${msgId}`;
}
function lastLocKey(wa) {
  return `glowny:loc:${wa}`;
}
function entryProductKey(wa) {
  return `glowny:entry:${wa}`;
}

// =========================
// Text helpers
// =========================
function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
    q.includes("muéstrame") ||
    q.includes("ensename") ||
    q.includes("enséñame")
  );
}

function isYes(text) {
  const q = normalizeText(text);
  return ["si", "sí", "dale", "ok", "okay", "de acuerdo", "confirmo", "claro", "ajá", "aha", "yes"].some((w) =>
    q === w || q.includes(w)
  );
}

function isNo(text) {
  const q = normalizeText(text);
  return ["no", "nel", "negativo", "no gracias", "despues", "después"].some((w) => q === w || q.includes(w));
}

function extractQty(text) {
  const q = normalizeText(text);
  // buscar "2", "3", etc
  const m = q.match(/\b(\d{1,2})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// =========================
// Product matching (MUY MEJORADO)
// =========================
function findBestProduct(text) {
  const q = normalizeText(text);
  if (!q) return null;

  // 🔥 atajo fuerte: si mencionan colageno => devolver el colageno siempre
  if (q.includes("colageno") || q.includes("colágeno")) {
    return PRODUCTS.find((p) => normalizeText(p.name).includes("colageno")) || null;
  }

  // atajos por keywords comunes
  const keywordMap = [
    { key: "rosa mosqueta", contains: ["rosa", "mosqueta"], must: "rosa mosqueta" },
    { key: "protector solar", contains: ["protector", "solar"], must: "proteccion solar" },
    { key: "magnesio", contains: ["magnesio"], must: "magnesio" },
    { key: "vitamina c", contains: ["vitamina", "c"], must: "vitamina c" },
    { key: "gel intimo", contains: ["intimo", "íntimo"], must: "higiene intimo" },
  ];

  for (const km of keywordMap) {
    const ok = km.contains.every((w) => q.includes(normalizeText(w)));
    if (ok) {
      const prod = PRODUCTS.find((p) => normalizeText(p.name).includes(normalizeText(km.must)));
      if (prod) return prod;
    }
  }

  // scoring general
  let best = null;
  let bestScore = 0;

  const qWords = q.split(" ").filter(Boolean);

  for (const p of PRODUCTS) {
    const name = normalizeText(p.name);
    let score = 0;

    // exact contains grandes
    if (name.includes(q)) score += 12;

    // hits por palabra (evita “de”, “con”, etc)
    const stop = new Set(["de", "con", "para", "y", "el", "la", "los", "las", "un", "una", "ml", "g", "und"]);
    const nameWords = new Set(name.split(" ").filter((w) => w && !stop.has(w)));
    const filteredQ = qWords.filter((w) => w && !stop.has(w));

    const hits = filteredQ.filter((w) => nameWords.has(w)).length;
    score += hits * 2;

    // boost por categoria si preguntan "suplemento", "rostro", etc
    if (q.includes("suplemento") && normalizeText(p.category).includes("suplement")) score += 3;
    if (q.includes("rostro") && normalizeText(p.category).includes("rostro")) score += 3;
    if (q.includes("cuerpo") && normalizeText(p.category).includes("cuerpo")) score += 3;

    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  if (bestScore >= 4) return best; // umbral seguro
  return null;
}

// =========================
// Memory (Upstash) - GUARDA SIEMPRE TODO
// =========================
async function appendToMemory(wa, role, content) {
  const key = memKey(wa);
  let mem = await redisGetJson(key);
  if (!Array.isArray(mem)) mem = [];

  mem.push({ role, content });

  // guardar max 20 mensajes
  if (mem.length > 20) mem = mem.slice(-20);

  // 30 días
  await redisSetJson(key, mem, 60 * 60 * 24 * 30);
}

async function getMemory(wa) {
  const mem = await redisGetJson(memKey(wa));
  return Array.isArray(mem) ? mem : [];
}

// =========================
// Pending State (Upstash)
// stage:
// - "await_confirm" : esperando que diga "Si" para reservar
// - "await_name"    : pedir nombre
// - "await_address" : pedir sector + direccion
// - "await_location": pedir ubicacion mapa opcional
// - "await_payment" : pedir metodo de pago
// - "done"          : pedido listo
// =========================
async function getPending(wa) {
  const p = await redisGetJson(pendingKey(wa));
  return p && typeof p === "object" ? p : null;
}

async function setPending(wa, obj) {
  await redisSetJson(pendingKey(wa), obj, 60 * 60 * 24 * 2); // 48h
}

async function clearPending(wa) {
  await redisDel(pendingKey(wa));
}

// =========================
// Location store
// =========================
async function setLastLocation(wa, loc) {
  await redisSetJson(lastLocKey(wa), loc, 60 * 60 * 24 * 7);
}

async function getLastLocation(wa) {
  const loc = await redisGetJson(lastLocKey(wa));
  return loc && typeof loc === "object" ? loc : null;
}

// =========================
// last product store
// =========================
async function setLastProduct(wa, productId) {
  await redisSet(productId ? lastProdKey(wa) : lastProdKey(wa), productId || "", 60 * 60 * 24 * 7);
}

async function getLastProduct(wa) {
  const v = await redisGet(lastProdKey(wa));
  return v || null;
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
  console.log("WhatsApp send text:", JSON.stringify(data, null, 2));
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

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WA_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  console.log("WhatsApp send image:", JSON.stringify(data, null, 2));
}

// =========================
// OpenAI (solo fallback)
// =========================
function buildSystemPrompt({ pending, productContext }) {
  return `
Eres una asistente de ventas por WhatsApp de "Glowny Essentials" (República Dominicana).

REGLAS:
- Responde en español dominicano neutro.
- Respuestas cortas (1-3 líneas).
- No inventes precios, ni inventes productos.
- Si el cliente escribe algo raro, responde amable y vuelve al objetivo: elegir producto y cerrar pedido.

IMPORTANTE:
Los precios y productos los maneja el sistema, NO tú.
Tú solo ayudas a guiar la conversación.

ESTADO ACTUAL:
${pending ? JSON.stringify(pending) : "Sin pedido en proceso"}

CONTEXTO DE PRODUCTO (si existe):
${productContext ? JSON.stringify(productContext) : "N/A"}

Cuando el cliente confirme el pedido, responde pidiendo:
1) Nombre completo
2) Ciudad/sector
3) Dirección + referencia
4) Método de pago

Nunca pidas "qué producto" si ya hay uno confirmado en el estado.
`.trim();
}

async function callOpenAI({ waNumber, userText, pending, productContext }) {
  // memoria corta para OpenAI
  const mem = await getMemory(waNumber);
  const shortHistory = mem.slice(-8); // max 8 mensajes para bajar tokens

  const messages = [
    { role: "system", content: buildSystemPrompt({ pending, productContext }) },
    ...shortHistory,
    { role: "user", content: userText },
  ];

  const payload = {
    model: OPENAI_MODEL,
    messages,
    temperature: 0.2,
    max_tokens: 180,
  };

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok) {
      console.log("OpenAI error:", JSON.stringify(data, null, 2));
      const code = data?.error?.code || "";
      if (code === "rate_limit_exceeded") {
        return "Dame 5 segunditos 🙏 y me lo repites.";
      }
      return "Ay mi amor 😥 tuve un fallito. ¿Me lo repites?";
    }

    const reply = data?.choices?.[0]?.message?.content?.trim();
    return reply || "¿Me lo repites porfa? 😊";
  } catch (e) {
    console.log("OpenAI exception:", e);
    return "Ay mi amor 😥 tuve un fallito. ¿Me lo repites?";
  }
}

// =========================
// Anti-duplicate replies
// =========================
async function preventSameReply(wa, newReply) {
  const last = await redisGet(lastReplyKey(wa));
  if (last && normalizeText(last) === normalizeText(newReply)) {
    return true;
  }
  await redisSet(lastReplyKey(wa), newReply, 60 * 60 * 6);
  return false;
}

// =========================
// Build admin order
// =========================
function calcTotal(items) {
  let total = 0;
  for (const it of items) {
    const p = PRODUCTS.find((x) => x.id === it.productId);
    if (!p) continue;
    total += (it.qty || 1) * p.price;
  }
  return total;
}

function buildOrderJson(pending) {
  // estructura segura
  return {
    cliente: pending?.name || "",
    items: (pending?.items || []).map((x) => ({
      name: x.nameExact || "",
      qty: x.qty || 1,
    })),
    nota: pending?.note || "",
  };
}

// =========================
// Webhook Verify (GET)
// =========================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado ✅");
    return res.status(200).send(challenge);
  }

  console.log("Webhook no verificado ❌");
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

    // a veces solo vienen statuses
    const message = value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const msgId = message.id;
    const from = message.from;

    // ✅ ANTI DUPLICADO por msgId
    if (msgId) {
      const seen = await redisGet(seenMsgKey(msgId));
      if (seen) return res.sendStatus(200);
      await redisSet(seenMsgKey(msgId), "1", 60 * 60); // 1 hora
    }

    // texto usuario
    let userText = "";
    if (message.type === "location" && message.location) {
      const loc = message.location;
      await setLastLocation(from, {
        latitude: loc.latitude,
        longitude: loc.longitude,
        name: loc.name || "",
        address: loc.address || "",
      });

      userText =
        "Te acabo de enviar mi ubicación por el mapa de WhatsApp. " +
        (loc.address ? `Dirección del mapa: ${loc.address}.` : "");
    } else {
      userText = message.text?.body || "";
    }

    userText = userText.trim();
    if (!userText) return res.sendStatus(200);

    // ✅ Guardar SIEMPRE el mensaje del usuario en memoria
    await appendToMemory(from, "user", userText);

    // =========================
    // Referral / anuncio
    // =========================
    if (message.referral) {
      const ref = message.referral;
      const posibleNombre = ref.headline || ref.body || ref.source_url || "";
      if (posibleNombre) {
        await redisSet(entryProductKey(from), posibleNombre, 60 * 60 * 24 * 7);
        // intenta detectar producto del anuncio
        const adProd = findBestProduct(posibleNombre);
        if (adProd) await setLastProduct(from, adProd.id);
      }
    }

    // =========================
    // Detectar producto por texto
    // =========================
    const matchedProduct = findBestProduct(userText);
    if (matchedProduct) {
      await setLastProduct(from, matchedProduct.id);
    }

    // =========================
    // Responder imagen si piden
    // =========================
    if (isAskingForImage(userText)) {
      const pid = (matchedProduct && matchedProduct.id) || (await getLastProduct(from));
      const prod = PRODUCTS.find((p) => p.id === pid);
      if (prod?.image) {
        const caption = `${prod.name}\nPrecio: RD$${prod.price}\n¿Te lo reservo? 💗`;
        // guardar memoria
        await appendToMemory(from, "assistant", `[IMG] ${caption}`);
        await sendWhatsAppImage(from, prod.image, caption);
        return res.sendStatus(200);
      }
    }

    // =========================
    // Pending / flujo de pedido
    // =========================
    let pending = await getPending(from);

    // Si no hay pending y detectamos producto => iniciar confirmación
    if (!pending && matchedProduct) {
      const qty = extractQty(userText) || 1;

      pending = {
        stage: "await_confirm",
        items: [
          {
            productId: matchedProduct.id,
            nameExact: matchedProduct.name,
            qty,
            price: matchedProduct.price,
          },
        ],
        createdAt: Date.now(),
      };

      await setPending(from, pending);

      const reply = `Tengo este 💗\n${matchedProduct.name}\nPrecio: RD$${matchedProduct.price} c/u\n¿Te reservo ${qty} unidad${qty > 1 ? "es" : ""}? 😊`;
      if (!(await preventSameReply(from, reply))) {
        await appendToMemory(from, "assistant", reply);
        await sendWhatsAppMessage(from, reply);
      }
      return res.sendStatus(200);
    }

    // Si hay pending
    if (pending) {
      // Si dice NO => cancelar
      if (isNo(userText)) {
        await clearPending(from);
        const reply = "Perfecto mi amor 😊 ¿Qué otro producto te interesa ver?";
        if (!(await preventSameReply(from, reply))) {
          await appendToMemory(from, "assistant", reply);
          await sendWhatsAppMessage(from, reply);
        }
        return res.sendStatus(200);
      }

      // Si está esperando confirmación y dice SI => pedir nombre
      if (pending.stage === "await_confirm" && isYes(userText)) {
        pending.stage = "await_name";
        await setPending(from, pending);

        const reply = "Perfecto 💗\nDime tu *nombre completo* para el envío 😊";
        if (!(await preventSameReply(from, reply))) {
          await appendToMemory(from, "assistant", reply);
          await sendWhatsAppMessage(from, reply);
        }
        return res.sendStatus(200);
      }

      // Si esperan nombre
      if (pending.stage === "await_name") {
        // guardar nombre
        pending.name = userText;
        pending.stage = "await_address";
        await setPending(from, pending);

        const reply =
          "Gracias mi amor 😊\nAhora dime tu *ciudad + sector* y tu *dirección* (con una referencia).";
        if (!(await preventSameReply(from, reply))) {
          await appendToMemory(from, "assistant", reply);
          await sendWhatsAppMessage(from, reply);
        }
        return res.sendStatus(200);
      }

      // Si esperan dirección
      if (pending.stage === "await_address") {
        pending.address = userText;
        pending.stage = "await_payment";
        await setPending(from, pending);

        const reply = "Listo 💗\n¿El pago será *contra entrega* o *transferencia*? 😊";
        if (!(await preventSameReply(from, reply))) {
          await appendToMemory(from, "assistant", reply);
          await sendWhatsAppMessage(from, reply);
        }
        return res.sendStatus(200);
      }

      // Si esperan pago
      if (pending.stage === "await_payment") {
        pending.payment = userText;
        pending.stage = "done";
        await setPending(from, pending);

        // total catálogo
        const total = calcTotal(pending.items);

        const prodLines = pending.items
          .map((it) => {
            const p = PRODUCTS.find((x) => x.id === it.productId);
            if (!p) return `- ${it.qty}x ${it.nameExact}`;
            return `- ${it.qty}x ${p.name} — RD$${p.price}`;
          })
          .join("\n");

        const reply =
          `Perfecto mi amor ✅\n🛒 Tu pedido:\n${prodLines}\n💰 Total: RD$${total}\n¿Confirmas para procesarlo? 😊`;

        if (!(await preventSameReply(from, reply))) {
          await appendToMemory(from, "assistant", reply);
          await sendWhatsAppMessage(from, reply);
        }

        // Si confirma con SI luego, aquí lo capturamos en la próxima interacción
        return res.sendStatus(200);
      }

      // Si ya está done y dice SI => enviar al admin y cerrar
      if (pending.stage === "done" && isYes(userText)) {
        // pedido confirmado
        const loc = await getLastLocation(from);

        const total = calcTotal(pending.items);
        const orderJson = buildOrderJson(pending);

        let adminText = `📦 NUEVO PEDIDO CONFIRMADO - Glowny Essentials\n\n`;
        adminText += `👤 Cliente: ${pending.name || ""}\n`;
        adminText += `📍 Dirección: ${pending.address || ""}\n`;
        adminText += `💳 Pago: ${pending.payment || ""}\n\n`;
        adminText += `🛒 Productos:\n`;

        for (const it of pending.items) {
          const p = PRODUCTS.find((x) => x.id === it.productId);
          if (!p) {
            adminText += `- ${it.qty}x ${it.nameExact}\n`;
            continue;
          }
          adminText += `- ${it.qty}x ${p.name} — RD$${p.price}\n`;
        }

        adminText += `\n💰 Total catálogo: RD$${total}\n\n`;
        adminText += `Número del cliente: ${from}\nChat: https://wa.me/${from}\n\n`;
        adminText += `${ORDER_TAG}\n${JSON.stringify(orderJson, null, 2)}\n`;

        if (loc?.latitude && loc?.longitude) {
          adminText += `\n📍 Ubicación mapa:\nLat: ${loc.latitude}, Lon: ${loc.longitude}\n`;
          adminText += `Google Maps: https://www.google.com/maps?q=${loc.latitude},${loc.longitude}\n`;
          if (loc.address) adminText += `Dirección aprox: ${loc.address}\n`;
          if (loc.name) adminText += `Nombre: ${loc.name}\n`;
        }

        await sendWhatsAppMessage(ADMIN_PHONE, adminText);

        const reply = "Listo mi amor ✅ Ya tu pedido está confirmado 💗\nEn breve te lo estaremos entregando 😊";
        if (!(await preventSameReply(from, reply))) {
          await appendToMemory(from, "assistant", reply);
          await sendWhatsAppMessage(from, reply);
        }

        await clearPending(from);
        return res.sendStatus(200);
      }

      // Si está done y dice NO => reiniciar
      if (pending.stage === "done" && isNo(userText)) {
        pending.stage = "await_confirm";
        await setPending(from, pending);

        const reply = "Dime qué deseas cambiar mi amor 😊 (cantidad o producto)";
        if (!(await preventSameReply(from, reply))) {
          await appendToMemory(from, "assistant", reply);
          await sendWhatsAppMessage(from, reply);
        }
        return res.sendStatus(200);
      }
    }

    // =========================
    // Si NO hay producto detectado, pero hay "colágeno" => responder directo
    // =========================
    if (!matchedProduct) {
      const q = normalizeText(userText);
      if (q.includes("colageno") || q.includes("colágeno")) {
        const prod = PRODUCTS.find((p) => normalizeText(p.name).includes("colageno"));
        if (prod) {
          await setLastProduct(from, prod.id);

          const reply = `Tengo este 💗\n${prod.name}\nPrecio: RD$${prod.price} c/u\n¿Te reservo 1 unidad? 😊`;
          if (!(await preventSameReply(from, reply))) {
            await appendToMemory(from, "assistant", reply);
            await sendWhatsAppMessage(from, reply);
          }
          return res.sendStatus(200);
        }
      }
    }

    // =========================
    // Fallback OpenAI (solo si no pudo resolver)
    // =========================
    const lastPid = await getLastProduct(from);
    const prodContext = lastPid ? PRODUCTS.find((p) => p.id === lastPid) : null;

    const aiReply = await callOpenAI({
      waNumber: from,
      userText,
      pending: pending || null,
      productContext: prodContext || null,
    });

    // evitar spam
    if (!(await preventSameReply(from, aiReply))) {
      await appendToMemory(from, "assistant", aiReply);
      await sendWhatsAppMessage(from, aiReply);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Error en /webhook:", err);
    return res.sendStatus(200);
  }
});

// =========================
// Start server
// =========================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Bot corriendo en puerto ${PORT}`);
});
