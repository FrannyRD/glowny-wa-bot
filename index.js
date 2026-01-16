const express = require("express");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "glowny_verify";
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ✅ Número ADMIN donde recibes pedidos listos (sin +)
const ADMIN_PHONE = "18492010239";

// ✅ Tag para pedido confirmado
const ORDER_TAG = "PEDIDO_CONFIRMADO:";

// ✅ Memoria simple por número de WhatsApp
const memory = new Map(); // waNumber -> [{ role, content }]
const entryProduct = new Map(); // waNumber -> texto producto de anuncio/referral
const lastLocation = new Map(); // waNumber -> { latitude, longitude, name, address }
const lastProductSeen = new Map(); // waNumber -> productId (último producto detectado)

// ======================================================
// ✅ TU CATÁLOGO (JSON) - pegado aquí (del CSV)
// ======================================================
const PRODUCTS = [
  {
    "id": "0333fadc-c608-4c6e-a8d4-67d7a3ed117e",
    "name": "Crema corporal hidratante Esferas VIT - E Deliplus con ácido hialurónico",
    "price": 550,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.47356556525844695.jpg"
  },
  {
    "id": "0552881d-7395-4d9e-8d60-10e01a879e10",
    "name": "Comprimidos efervescentes magnesio Deliplus 300 mg sabor naranja vitaminas B1, B6 y B12 20und/80g",
    "price": 400,
    "category": "Suplementos",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.6344341855892877.jpg"
  },
  {
    "id": "0e290ffc-c710-40b8-8409-206466bc5217",
    "name": "Aceite corporal rosa mosqueta Deliplus 100% puro y natural 30 ml",
    "price": 950,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.01851007574591812.jpg"
  },
  {
    "id": "0feaf32e-4201-4cbd-ac77-830486f9192c",
    "name": "Aceite corporal romero Botella 200 ml Deliplus",
    "price": 550,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.36263807809930526.jpg"
  },
  {
    "id": "104666b4-2391-4ba9-be6b-68fa012f630e",
    "name": "Crema protección solar facial Deliplus FPS 50+ resistente al agua 50 ml",
    "price": 700,
    "category": "Rostro",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.07349553219793581.jpg"
  },
  {
    "id": "144c0a12-1549-4a07-b11e-84e16fcb9217",
    "name": "Crema facial protectora anti-manchas Deliplus FPS 50+ todo tipo de piel 50 ml",
    "price": 900,
    "category": "Rostro",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.766836007795388.jpg"
  },
  {
    "id": "2382b32e-952c-46a7-85f0-4716ecc8216e",
    "name": "Toallitas Limpiagafas Bosque Verde monodosis perfumadas 32und",
    "price": 450,
    "category": "Otros",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.9901194809376783.jpg"
  },
  {
    "id": "2816c73d-ec50-49f0-9311-848539849ae7",
    "name": "Desodorante para pies fresh & dry Deliplus antitranspirante spray 150 ml",
    "price": 400,
    "category": "Otros",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7412669567328445.jpg"
  },
  {
    "id": "2f57e03f-4d2e-4dc6-bd8a-13abda985333",
    "name": "Deliplus Gel higiene intimo liquido hidratante con dosificador 500 ml",
    "price": 500,
    "category": "Higiene íntima",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7787574431351961.jpg"
  },
  {
    "id": "363d9ce6-cde3-4e3d-b569-94be86fa0fb7",
    "name": "Exfoliante corporal mineral Deliplus Mar Muerto 400 ml",
    "price": 650,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.964762992512799.jpg"
  },
  {
    "id": "38dac334-d123-4a85-bca1-b0c2e805a4e9",
    "name": "Exfoliante corporal marino Deliplus Sal Mar Muerto 400 g",
    "price": 650,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.3357927369198168.jpg"
  },
  {
    "id": "45c3abbe-206d-4568-8810-8cb07c844fa4",
    "name": "Gel de baño tiernos recuerdos Deliplus piel normal 750 ml",
    "price": 350,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7576058214157932.jpg"
  },
  {
    "id": "4f900df6-82b0-4ffc-a3f3-0a65731d8394",
    "name": "Exfoliante Arcilla Blanca Facial Clean Deliplus piel normal o mixta 100 ml",
    "price": 600,
    "category": "Rostro",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.9089123499909787.jpg"
  },
  {
    "id": "5161a1bf-a837-4d3f-a589-d1987aea4c91",
    "name": "Colágeno soluble sabor limón Colagen complemento alimenticio Deliplus 250 g",
    "price": 900,
    "category": "Suplementos",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7143289581985477.jpg"
  },
  {
    "id": "55e72417-24eb-4d69-9972-cca5fc3edf8a",
    "name": "Crema protección solar infantil FPS 50+ Deliplus para pieles sensibles y atópicas",
    "price": 650,
    "category": "Rostro",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.8439793539752637.jpg"
  },
  {
    "id": "615f78c9-b15d-422e-9260-893132c135d8",
    "name": "Gel refrescante mentol Deliplus para pies y piernas 300 ml",
    "price": 550,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.13998940319484232.jpg"
  },
  {
    "id": "61f74869-4dbe-4213-91e4-e79d08e9f008",
    "name": "Loción corporal Calm Deliplus omega 3, 6, 9 y niacinamida piel sensible y atópica 400 ml",
    "price": 450,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.8733127834132417.jpg"
  },
  {
    "id": "671e458a-fdcd-47b3-93d4-cd21af1005ab",
    "name": "Loción corporal Repara Deliplus urea 10% y dexpantenol piel muy seca 400 ml",
    "price": 450,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.6565286896440724.jpg"
  },
  {
    "id": "6e5c316e-25b9-429c-ba79-c549f6d20423",
    "name": "Loción corporal Hidrata Deliplus aloe vera y ácido hialurónico piel normal 600 g",
    "price": 550,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.4615014729316803.jpg"
  },
  {
    "id": "71dc99d1-e026-4aec-b116-e6c4e14638d5",
    "name": "Crema corporal Nivea 250 ml",
    "price": 600,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.8937379278968904.jpg"
  },
  {
    "id": "80b3d654-8381-4bad-b29c-6bbc3043c3d6",
    "name": "Gel facial limpiador Facial clean todo tipo de piel Deliplus 250 ml",
    "price": 500,
    "category": "Rostro",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.14096114588484898.jpg"
  },
  {
    "id": "88539069-1373-48ee-a1d1-31430869815a",
    "name": "Gel de baño frutal Deliplus piel normal 750 ml",
    "price": 350,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.6750012951424128.jpg"
  },
  {
    "id": "8b6f913b-9eff-4233-96c5-d483b70f09a4",
    "name": "Crema de manos hidratante con aloe vera Deliplus 75 ml",
    "price": 350,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7971261774222368.jpg"
  },
  {
    "id": "8eb7cdea-a920-489a-97ad-60f3ec58497a",
    "name": "Comprimidos efervescentes vitamina C y zinc Deliplus sabor limón 20und/80g",
    "price": 400,
    "category": "Suplementos",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7343292665638652.jpg"
  },
  {
    "id": "901ffafd-9ce6-48ec-8b14-87bd993a62ef",
    "name": "Gel de baño vainilla y miel Deliplus piel normal 750 ml",
    "price": 350,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.9119627229156263.jpg"
  },
  {
    "id": "92d65ef0-475e-4b89-ae11-639fd51fb423",
    "name": "Concentrado manual Florena con manteca de karité y aceite de argán 50 ml",
    "price": 250,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7890441674096778.jpg"
  },
  {
    "id": "a0f25ca3-e821-4075-87db-40d97372ee67",
    "name": "Serum Facial Potenciador Sisbela Reafirm Deliplus 12% silicio tipo pieles frasco",
    "price": 950,
    "category": "Rostro",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.8420422814402666.jpg"
  },
  {
    "id": "a161e422-0196-435d-9755-0350ed8ac8c5",
    "name": "Crema depilatoria mujer para el cuerpo Deliplus piel sensible bajo la ducha incluye manopla 200 ml",
    "price": 500,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7471298043382055.jpg"
  },
  {
    "id": "aeea794a-564d-49a9-9616-c6122315b423",
    "name": "Sérum facial Ácido Hialurónico y Ceramidas Deliplus Hidrata todo tipo de piel 30 ml",
    "price": 800,
    "category": "Rostro",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/1767924116543-0.399580346122166.jpg"
  },
  {
    "id": "b031231b-ac2f-4555-8223-10f7d0cf413c",
    "name": "Gel de baño granada y frutos silvestres Deliplus piel normal 750 ml",
    "price": 350,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.8889156108119076.jpg"
  },
  {
    "id": "c0373445-7be4-49b1-bd3e-d20095d8a264",
    "name": "Gel corporal aloe vera Deliplus 400 ml",
    "price": 600,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.07272257840533858.jpg"
  },
  {
    "id": "c1dfe6da-edca-49ec-88d3-48247ca8f7d8",
    "name": "Deliplus Gel de higiene íntimo líquido con dosificador 500 ml",
    "price": 500,
    "category": "Higiene íntima",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7470060378444082.jpg"
  },
  {
    "id": "c37f4b97-2ab7-45db-b79c-6fd7db2afd02",
    "name": "Crema de manos nutritiva Karité Deliplus 75 ml",
    "price": 350,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.013811606548578825.jpg"
  },
  {
    "id": "c3c918b1-e179-4123-9dd1-e1597c447bab",
    "name": "Loción corporal Nutre Deliplus almendras y cica piel seca 600 g",
    "price": 550,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.1886844553433108.jpg"
  },
  {
    "id": "c6e534e2-b54b-4d08-93f9-9d82569f297a",
    "name": "Crema protección solar Deliplus FPS 50+ Resistente al agua 100 ml",
    "price": 600,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.6036945328427022.jpg"
  },
  {
    "id": "d56a63e7-687a-4282-8464-1e6f43e45283",
    "name": "Gel de baño avena Deliplus piel sensible 750 ml",
    "price": 350,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.10264727845100174.jpg"
  },
  {
    "id": "d6791f25-c4ac-4669-8234-ffd0fc3b2f81",
    "name": "Gel de baño frescor azul Deliplus piel normal 750 ml",
    "price": 350,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.44323230998298535.jpg"
  },
  {
    "id": "d695db2e-e466-4ce8-8778-38625b8ae129",
    "name": "Gel de baño marino y cedro Deliplus piel normal 750 ml",
    "price": 350,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.38823628813402555.jpg"
  },
  {
    "id": "dbb208a2-31e2-4a58-9f09-04bb4dba8d18",
    "name": "Crema facial noche Deliplus aclarante anti-manchas todo tipo de piel 50 ml",
    "price": 900,
    "category": "Rostro",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.1687269797256935.jpg"
  },
  {
    "id": "e04590e5-aa64-49c2-8346-2ad8c712915b",
    "name": "Protector Labial Deliplus FPS 15 1und",
    "price": 350,
    "category": "Rostro",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.26585338094003164.jpg"
  },
  {
    "id": "e150c27a-c825-4390-b2b2-3c539c4ba4c7",
    "name": "Crema depilatoria hombre Deliplus piel normal bajo la ducha incluye manopla 200 ml",
    "price": 500,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.8309128377524708.jpg"
  },
  {
    "id": "e498fd92-e734-4227-9340-7ed097fd79d1",
    "name": "Gel de baño 10% urea Deliplus piel áspera y deshidratada 500 ml",
    "price": 400,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.47965691702378466.jpg"
  },
  {
    "id": "e5504c4e-83f9-4937-b819-9419292da3c8",
    "name": "Manteca corporal Murumuru Deliplus 300 ml",
    "price": 550,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.17408592890249042.jpg"
  },
  {
    "id": "e69f2c20-3841-4af7-9a2e-cbbfec30bb80",
    "name": "Leche facial limpiadora Facial Clean todo tipo de piel Deliplus 250 ml",
    "price": 450,
    "category": "Rostro",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.6289164249460402.jpg"
  },
  {
    "id": "e72e17d0-38b8-4aa2-b66f-bd47fd807cb1",
    "name": "Crema solar SPF 50+ en formato spray",
    "price": 900,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.890999533523696.jpg"
  },
  {
    "id": "e7589330-248e-4fd7-a645-3d27e924ad5a",
    "name": "Deliplus Crema corporal aceite argan 250 ml",
    "price": 450,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.05540865085271529.jpg"
  },
  {
    "id": "e88b9703-973e-4b56-901f-0ef39c2e4fca",
    "name": "Desodorante piedra de alumbre mineral Deonat para todo tipo de piel 60 g",
    "price": 400,
    "category": "Otros",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.9331449890013408.jpg"
  },
  {
    "id": "ea3e8d68-fd4b-486b-98ac-2408fc05f855",
    "name": "Deliplus Crema corporal aceite oliva 250 ml",
    "price": 450,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.792738396021052.jpg"
  },
  {
    "id": "f1ef9bad-471c-4edc-8436-5b0625f1eaba",
    "name": "Gel de baño ambar y vetiver Deliplus piel normal 750 ml",
    "price": 350,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.29018513988843364.jpg"
  },
  {
    "id": "f7a9aed0-a940-4584-aaf5-807e24c34bd4",
    "name": "Deliplus Exfoliante corporal con coco 250 ml",
    "price": 650,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.6693914752431569.jpg"
  },
  {
    "id": "fa1ac7aa-48e4-4c4b-97f2-0c7ce3f812a9",
    "name": "Gel de baño argán Deliplus piel muy seca 500 ml",
    "price": 400,
    "category": "Cuerpo",
    "image": "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.3166909672180076.jpg"
  }
];

// ======================================================
// Helpers
// ======================================================
function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildCatalogText() {
  // catálogo compacto (NO JSON dentro del prompt para evitar rate limit)
  return PRODUCTS.map((p) => {
    const cat = p.category ? `[${p.category}] ` : "";
    return `- ${cat}${p.name} — RD$${p.price}`;
  }).join("\n");
}

function findBestProduct(text) {
  const q = normalizeText(text);
  if (!q) return null;

  // match simple por contains
  let best = null;
  let bestScore = 0;

  for (const p of PRODUCTS) {
    const name = normalizeText(p.name);
    let score = 0;

    // exact contains
    if (name.includes(q) || q.includes(name)) score += 10;

    // match por palabras
    const qWords = q.split(" ").filter(Boolean);
    const nameWords = new Set(name.split(" ").filter(Boolean));
    const hits = qWords.filter((w) => nameWords.has(w)).length;
    score += hits;

    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  // filtro mínimo para evitar matches raros
  if (bestScore >= 2) return best;
  return null;
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
    q.includes("muestrame") ||
    q.includes("ensename") ||
    q.includes("enseñame")
  );
}

// ======================================================
// System Prompt (corto pero fuerte)
// ======================================================
function getSystemPrompt() {
  return `
Eres una asistente de ventas por WhatsApp de "Glowny Essentials" (República Dominicana).

OBJETIVO:
- Responder corto, claro y directo.
- Identificar rápido qué quiere el cliente.
- Confirmar pedido y pedir datos de envío.
- NUNCA inventes precios. Solo usa el catálogo.

ESTILO:
- Español dominicano neutro.
- 1 a 3 líneas por mensaje máximo.
- Nada de párrafos largos.
- Puedes usar pocos emojis femeninos (sin exagerar).

REGLA DE ORO (PRECIOS):
- Solo existen los precios del catálogo.
- Si el cliente dice otro precio: responde con el precio oficial del catálogo.

UBICACIÓN (MAPA):
- Si falta ubicación: pide que la envíe con el clip 📎 > Ubicación > Enviar ubicación actual.

PEDIDO CONFIRMADO:
Cuando el cliente confirme, al final agrega:
${ORDER_TAG}
{"cliente":"...","items":[{"name":"nombre exacto catálogo","qty":1}],"nota":"..."}

CATÁLOGO (NOMBRE + PRECIO):
${buildCatalogText()}
`;
}

// ======================================================
// OpenAI (con control de rate limit y menos tokens)
// ======================================================
async function callOpenAI(waNumber, userText) {
  const history = memory.get(waNumber) || [];

  const baseSystem = getSystemPrompt();

  // contexto si viene de anuncio / referral
  const productFromAd = entryProduct.get(waNumber);
  const extraSystem = productFromAd
    ? `\nCONTEXTO ANUNCIO: El cliente llegó por: "${productFromAd}". Prioriza ese producto.`
    : "";

  const messages = [
    { role: "system", content: baseSystem + extraSystem },
    ...history,
    { role: "user", content: userText },
  ];

  // 🔥 IMPORTANTE: baja tokens para evitar rate limit
  const payload = {
    model: "gpt-4.1-mini",
    messages,
    temperature: 0.2,
    max_tokens: 250,
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

  // ✅ Si OpenAI tiró error (rate limit, etc.)
  if (!response.ok) {
    console.log("OpenAI raw response:", JSON.stringify(data, null, 2));
    const code = data?.error?.code || "";
    const msg =
      code === "rate_limit_exceeded"
        ? "Dame 5 segunditos 🙏 y me lo repites."
        : "Ahora mismo tuve un error 😥 ¿Me lo repites?";
    return msg;
  }

  const reply =
    data.choices?.[0]?.message?.content ||
    "Disculpa 😥 ¿Me lo repites?";

  // ✅ Memoria corta (máx 6)
  const newHistory = [
    ...history,
    { role: "user", content: userText },
    { role: "assistant", content: reply },
  ];
  memory.set(waNumber, newHistory.slice(-6));

  return reply;
}

// ======================================================
// WhatsApp Senders
// ======================================================
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };

  console.log("Enviando mensaje a WhatsApp:", JSON.stringify(body, null, 2));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WA_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  console.log("Respuesta de WhatsApp:", JSON.stringify(data, null, 2));
}

// ✅ Imagen nativa
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

  console.log("Enviando IMAGEN a WhatsApp:", JSON.stringify(body, null, 2));

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  console.log("Respuesta de WhatsApp (imagen):", JSON.stringify(data, null, 2));
}

// ======================================================
// Webhook Verify (GET)
// ======================================================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado correctamente ✅");
    return res.status(200).send(challenge);
  }

  console.log("Error al verificar webhook ❌");
  return res.sendStatus(403);
});

// ======================================================
// Webhook Receive (POST)
// ======================================================
app.post("/webhook", async (req, res) => {
  console.log("Webhook recibido:", JSON.stringify(req.body, null, 2));

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // ⚠️ A veces NO viene messages (statuses, etc.)
    const message = value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from; // ✅ seguro
    let userText = "";

    // ✅ Referral / anuncio (guardar producto entrada)
    if (message.referral) {
      const ref = message.referral;
      const posibleNombre = ref.headline || ref.body || ref.source_url || "";
      if (posibleNombre) {
        console.log("➡️ Referral detectado para", from, "=>", posibleNombre);
        entryProduct.set(from, posibleNombre);

        // intento de detectar producto real desde el texto del anuncio
        const p = findBestProduct(posibleNombre);
        if (p) lastProductSeen.set(from, p.id);
      }
    }

    // ✅ Si manda ubicación por mapa
    if (message.type === "location" && message.location) {
      const loc = message.location;

      lastLocation.set(from, {
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

    // ✅ Guardar producto visto por texto
    const directProduct = findBestProduct(userText);
    if (directProduct) lastProductSeen.set(from, directProduct.id);

    // ✅ Si el cliente pide imagen y tenemos producto detectado → mandarla directo
    if (isAskingForImage(userText)) {
      const pid = lastProductSeen.get(from);
      const prod = PRODUCTS.find((p) => p.id === pid);
      if (prod?.image) {
        await sendWhatsAppImage(
          from,
          prod.image,
          `${prod.name}\nPrecio: RD$${prod.price}\n¿Lo quieres para pedirlo? 💗`
        );
        return res.sendStatus(200);
      }
    }

    // ✅ Respuesta con OpenAI
    const rawReply = (await callOpenAI(from, userText)) || "";
    let reply = rawReply.trim();

    // ✅ Si el modelo devolvió el tag de pedido confirmado
    let orderInfo = null;
    if (reply.includes(ORDER_TAG)) {
      const parts = reply.split(ORDER_TAG);
      reply = parts[0].trim();
      orderInfo = parts[1].trim();
    }

    // ✅ Enviar mensaje al cliente (si hay texto)
    if (reply) {
      await sendWhatsAppMessage(from, reply);
    }

    // ✅ Reenviar pedido al admin si viene confirmado
    if (orderInfo) {
      let parsed = null;

      // Intentar parsear JSON (si el modelo lo mandó bien)
      try {
        parsed = JSON.parse(orderInfo);
      } catch (e) {
        parsed = null;
      }

      // ✅ Armado del pedido con precios SIEMPRE del catálogo
      let adminText = "📦 NUEVO PEDIDO CONFIRMADO - Glowny Essentials\n\n";

      if (parsed?.items?.length) {
        let total = 0;

        adminText += "🛒 Productos:\n";
        for (const it of parsed.items) {
          const qty = Number(it.qty || 1);

          // buscar producto exacto por nombre (fallback a búsqueda best match)
          let prod =
            PRODUCTS.find((p) => normalizeText(p.name) === normalizeText(it.name)) ||
            findBestProduct(it.name);

          if (!prod) {
            adminText += `- ${qty}x ${it.name} (NO encontrado en catálogo)\n`;
            continue;
          }

          const subtotal = prod.price * qty;
          total += subtotal;

          adminText += `- ${qty}x ${prod.name} — RD$${prod.price} (Sub: RD$${subtotal})\n`;
        }

        adminText += `\n💰 Total catálogo: RD$${total}\n`;

        if (parsed.nota) adminText += `\n📝 Nota: ${parsed.nota}\n`;
        if (parsed.cliente) adminText += `\n👤 Cliente: ${parsed.cliente}\n`;
      } else {
        // Si no viene JSON bien, mandamos lo que vino crudo
        adminText += orderInfo + "\n";
      }

      adminText +=
        "\n📲 Datos:\n" +
        `WhatsApp cliente: ${from}\n` +
        `Abrir chat: https://wa.me/${from}`;

      // ✅ Agregar ubicación si existe
      const loc = lastLocation.get(from);
      if (loc) {
        adminText +=
          "\n\n📍 Ubicación por mapa:\n" +
          `Lat: ${loc.latitude}, Lon: ${loc.longitude}\n` +
          `Google Maps: https://www.google.com/maps?q=${loc.latitude},${loc.longitude}\n` +
          (loc.address ? `Dirección: ${loc.address}\n` : "") +
          (loc.name ? `Nombre: ${loc.name}\n` : "");
      }

      await sendWhatsAppMessage(ADMIN_PHONE, adminText);
      console.log("✅ Pedido reenviado al administrador (con ubicación si aplica)");
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Error en /webhook:", err);
    return res.sendStatus(200); // Meta quiere 200
  }
});

// ======================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Bot corriendo en el puerto ${PORT}`);
});
