const express = require("express");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "glowny_verify";
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SHIPPING_FEE = Number(process.env.SHIPPING_FEE || 0);

// ✅ Upstash Redis (REST)
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// ✅ Número ADMIN (sin +)
const ADMIN_PHONE = "18492010239";
const ORDER_TAG = "PEDIDO_CONFIRMADO:";

// ======================================================
// ✅ TU CATÁLOGO (JSON)
// ======================================================
const PRODUCTS = [
  {
    id: "0333fadc-c608-4c6e-a8d4-67d7a3ed117e",
    name: "Crema corporal hidratante Esferas VIT - E Deliplus con ácido hialurónico",
    price: 550,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.47356556525844695.jpg",
  },
  {
    id: "0552881d-7395-4d9e-8d60-10e01a879e10",
    name: "Comprimidos efervescentes magnesio Deliplus 300 mg sabor naranja vitaminas B1, B6 y B12 20und/80g",
    price: 400,
    category: "Suplementos",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.6344341855892877.jpg",
  },
  {
    id: "0e290ffc-c710-40b8-8409-206466bc5217",
    name: "Aceite corporal rosa mosqueta Deliplus 100% puro y natural 30 ml",
    price: 950,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.01851007574591812.jpg",
  },
  {
    id: "0feaf32e-4201-4cbd-ac77-830486f9192c",
    name: "Aceite corporal romero Botella 200 ml Deliplus",
    price: 550,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.36263807809930526.jpg",
  },
  {
    id: "104666b4-2391-4ba9-be6b-68fa012f630e",
    name: "Crema protección solar facial Deliplus FPS 50+ resistente al agua 50 ml",
    price: 700,
    category: "Rostro",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.07349553219793581.jpg",
  },
  {
    id: "144c0a12-1549-4a07-b11e-84e16fcb9217",
    name: "Crema facial protectora anti-manchas Deliplus FPS 50+ todo tipo de piel 50 ml",
    price: 900,
    category: "Rostro",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.766836007795388.jpg",
  },
  {
    id: "2382b32e-952c-46a7-85f0-4716ecc8216e",
    name: "Toallitas Limpiagafas Bosque Verde monodosis perfumadas 32und",
    price: 450,
    category: "Otros",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.9901194809376783.jpg",
  },
  {
    id: "2816c73d-ec50-49f0-9311-848539849ae7",
    name: "Desodorante para pies fresh & dry Deliplus antitranspirante spray 150 ml",
    price: 400,
    category: "Otros",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7412669567328445.jpg",
  },
  {
    id: "2f57e03f-4d2e-4dc6-bd8a-13abda985333",
    name: "Deliplus Gel higiene intimo liquido hidratante con dosificador 500 ml",
    price: 500,
    category: "Higiene íntima",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7787574431351961.jpg",
  },
  {
    id: "363d9ce6-cde3-4e3d-b569-94be86fa0fb7",
    name: "Exfoliante corporal mineral Deliplus Mar Muerto 400 ml",
    price: 650,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.964762992512799.jpg",
  },
  {
    id: "38dac334-d123-4a85-bca1-b0c2e805a4e9",
    name: "Exfoliante corporal marino Deliplus Sal Mar Muerto 400 g",
    price: 650,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.3357927369198168.jpg",
  },
  {
    id: "45c3abbe-206d-4568-8810-8cb07c844fa4",
    name: "Gel de baño tiernos recuerdos Deliplus piel normal 750 ml",
    price: 350,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7576058214157932.jpg",
  },
  {
    id: "4f900df6-82b0-4ffc-a3f3-0a65731d8394",
    name: "Exfoliante Arcilla Blanca Facial Clean Deliplus piel normal o mixta 100 ml",
    price: 600,
    category: "Rostro",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.9089123499909787.jpg",
  },
  {
    id: "5161a1bf-a837-4d3f-a589-d1987aea4c91",
    name: "Colágeno soluble sabor limón Colagen complemento alimenticio Deliplus 250 g",
    price: 900,
    category: "Suplementos",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7143289581985477.jpg",
  },
  {
    id: "55e72417-24eb-4d69-9972-cca5fc3edf8a",
    name: "Crema protección solar infantil FPS 50+ Deliplus para pieles sensibles y atópicas",
    price: 650,
    category: "Rostro",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.8439793539752637.jpg",
  },
  {
    id: "615f78c9-b15d-422e-9260-893132c135d8",
    name: "Gel refrescante mentol Deliplus para pies y piernas 300 ml",
    price: 550,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.13998940319484232.jpg",
  },
  {
    id: "61f74869-4dbe-4213-91e4-e79d08e9f008",
    name: "Loción corporal Calm Deliplus omega 3, 6, 9 y niacinamida piel sensible y atópica 400 ml",
    price: 450,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.8733127834132417.jpg",
  },
  {
    id: "671e458a-fdcd-47b3-93d4-cd21af1005ab",
    name: "Loción corporal Repara Deliplus urea 10% y dexpantenol piel muy seca 400 ml",
    price: 450,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.6565286896440724.jpg",
  },
  {
    id: "6e5c316e-25b9-429c-ba79-c549f6d20423",
    name: "Loción corporal Hidrata Deliplus aloe vera y ácido hialurónico piel normal 600 g",
    price: 550,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.4615014729316803.jpg",
  },
  {
    id: "71dc99d1-e026-4aec-b116-e6c4e14638d5",
    name: "Crema corporal Nivea 250 ml",
    price: 600,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.8937379278968904.jpg",
  },
  {
    id: "80b3d654-8381-4bad-b29c-6bbc3043c3d6",
    name: "Gel facial limpiador Facial clean todo tipo de piel Deliplus 250 ml",
    price: 500,
    category: "Rostro",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.14096114588484898.jpg",
  },
  {
    id: "88539069-1373-48ee-a1d1-31430869815a",
    name: "Gel de baño frutal Deliplus piel normal 750 ml",
    price: 350,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.6750012951424128.jpg",
  },
  {
    id: "8b6f913b-9eff-4233-96c5-d483b70f09a4",
    name: "Crema de manos hidratante con aloe vera Deliplus 75 ml",
    price: 350,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7971261774222368.jpg",
  },
  {
    id: "8eb7cdea-a920-489a-97ad-60f3ec58497a",
    name: "Comprimidos efervescentes vitamina C y zinc Deliplus sabor limón 20und/80g",
    price: 400,
    category: "Suplementos",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7343292665638652.jpg",
  },
  {
    id: "901ffafd-9ce6-48ec-8b14-87bd993a62ef",
    name: "Gel de baño vainilla y miel Deliplus piel normal 750 ml",
    price: 350,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.9119627229156263.jpg",
  },
  {
    id: "92d65ef0-475e-4b89-ae11-639fd51fb423",
    name: "Concentrado manual Florena con manteca de karité y aceite de argán 50 ml",
    price: 250,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7890441674096778.jpg",
  },
  {
    id: "a0f25ca3-e821-4075-87db-40d97372ee67",
    name: "Serum Facial Potenciador Sisbela Reafirm Deliplus 12% silicio tipo pieles frasco",
    price: 950,
    category: "Rostro",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.8420422814402666.jpg",
  },
  {
    id: "a161e422-0196-435d-9755-0350ed8ac8c5",
    name: "Crema depilatoria mujer para el cuerpo Deliplus piel sensible bajo la ducha incluye manopla 200 ml",
    price: 500,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7471298043382055.jpg",
  },
  {
    id: "aeea794a-564d-49a9-9616-c6122315b423",
    name: "Sérum facial Ácido Hialurónico y Ceramidas Deliplus Hidrata todo tipo de piel 30 ml",
    price: 800,
    category: "Rostro",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/1767924116543-0.399580346122166.jpg",
  },
  {
    id: "b031231b-ac2f-4555-8223-10f7d0cf413c",
    name: "Gel de baño granada y frutos silvestres Deliplus piel normal 750 ml",
    price: 350,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.8889156108119076.jpg",
  },
  {
    id: "c0373445-7be4-49b1-bd3e-d20095d8a264",
    name: "Gel corporal aloe vera Deliplus 400 ml",
    price: 600,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.07272257840533858.jpg",
  },
  {
    id: "c1dfe6da-edca-49ec-88d3-48247ca8f7d8",
    name: "Deliplus Gel de higiene íntimo líquido con dosificador 500 ml",
    price: 500,
    category: "Higiene íntima",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.7470060378444082.jpg",
  },
  {
    id: "c37f4b97-2ab7-45db-b79c-6fd7db2afd02",
    name: "Crema de manos nutritiva Karité Deliplus 75 ml",
    price: 350,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.013811606548578825.jpg",
  },
  {
    id: "c3c918b1-e179-4123-9dd1-e1597c447bab",
    name: "Loción corporal Nutre Deliplus almendras y cica piel seca 600 g",
    price: 550,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.1886844553433108.jpg",
  },
  {
    id: "c6e534e2-b54b-4d08-93f9-9d82569f297a",
    name: "Crema protección solar Deliplus FPS 50+ Resistente al agua 100 ml",
    price: 600,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.6036945328427022.jpg",
  },
  {
    id: "d56a63e7-687a-4282-8464-1e6f43e45283",
    name: "Gel de baño avena Deliplus piel sensible 750 ml",
    price: 350,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.10264727845100174.jpg",
  },
  {
    id: "d6791f25-c4ac-4669-8234-ffd0fc3b2f81",
    name: "Gel de baño frescor azul Deliplus piel normal 750 ml",
    price: 350,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.44323230998298535.jpg",
  },
  {
    id: "d695db2e-e466-4ce8-8778-38625b8ae129",
    name: "Gel de baño marino y cedro Deliplus piel normal 750 ml",
    price: 350,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.38823628813402555.jpg",
  },
  {
    id: "dbb208a2-31e2-4a58-9f09-04bb4dba8d18",
    name: "Crema facial noche Deliplus aclarante anti-manchas todo tipo de piel 50 ml",
    price: 900,
    category: "Rostro",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.1687269797256935.jpg",
  },
  {
    id: "e04590e5-aa64-49c2-8346-2ad8c712915b",
    name: "Protector Labial Deliplus FPS 15 1und",
    price: 350,
    category: "Rostro",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.26585338094003164.jpg",
  },
  {
    id: "e150c27a-c825-4390-b2b2-3c539c4ba4c7",
    name: "Crema depilatoria hombre Deliplus piel normal bajo la ducha incluye manopla 200 ml",
    price: 500,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.8309128377524708.jpg",
  },
  {
    id: "e498fd92-e734-4227-9340-7ed097fd79d1",
    name: "Gel de baño 10% urea Deliplus piel áspera y deshidratada 500 ml",
    price: 400,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.47965691702378466.jpg",
  },
  {
    id: "e5504c4e-83f9-4937-b819-9419292da3c8",
    name: "Manteca corporal Murumuru Deliplus 300 ml",
    price: 550,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.17408592890249042.jpg",
  },
  {
    id: "e69f2c20-3841-4af7-9a2e-cbbfec30bb80",
    name: "Leche facial limpiadora Facial Clean todo tipo de piel Deliplus 250 ml",
    price: 450,
    category: "Rostro",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.6289164249460402.jpg",
  },
  {
    id: "e72e17d0-38b8-4aa2-b66f-bd47fd807cb1",
    name: "Crema solar SPF 50+ en formato spray",
    price: 900,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.890999533523696.jpg",
  },
  {
    id: "e7589330-248e-4fd7-a645-3d27e924ad5a",
    name: "Deliplus Crema corporal aceite argan 250 ml",
    price: 450,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.05540865085271529.jpg",
  },
  {
    id: "e88b9703-973e-4b56-901f-0ef39c2e4fca",
    name: "Desodorante piedra de alumbre mineral Deonat para todo tipo de piel 60 g",
    price: 400,
    category: "Otros",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.9331449890013408.jpg",
  },
  {
    id: "ea3e8d68-fd4b-486b-98ac-2408fc05f855",
    name: "Deliplus Crema corporal aceite oliva 250 ml",
    price: 450,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.792738396021052.jpg",
  },
  {
    id: "f1ef9bad-471c-4edc-8436-5b0625f1eaba",
    name: "Gel de baño ambar y vetiver Deliplus piel normal 750 ml",
    price: 350,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.29018513988843364.jpg",
  },
  {
    id: "f7a9aed0-a940-4584-aaf5-807e24c34bd4",
    name: "Deliplus Exfoliante corporal con coco 250 ml",
    price: 650,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.6693914752431569.jpg",
  },
  {
    id: "fa1ac7aa-48e4-4c4b-97f2-0c7ce3f812a9",
    name: "Gel de baño argán Deliplus piel muy seca 500 ml",
    price: 400,
    category: "Cuerpo",
    image: "https://okfohritwwslnsjzkwwr.supabase.co/storage/v1/object/public/images/0.3166909672180076.jpg",
  },
];

// ======================================================
// ✅ Helpers
// ======================================================
function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectQty(text) {
  const q = normalizeText(text);
  const m = q.match(/\b(\d{1,2})\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n) && n >= 1 && n <= 20) return n;
  }
  return 1;
}

function isAskingForImage(text) {
  const q = normalizeText(text);
  return (
    q.includes("foto") ||
    q.includes("imagen") ||
    q.includes("ver") ||
    q.includes("muestrame") ||
    q.includes("muéstrame") ||
    q.includes("ensename") ||
    q.includes("enseñame")
  );
}

function isAffirmative(text) {
  const q = normalizeText(text);
  return (
    q === "si" ||
    q === "sí" ||
    q.includes("si ") ||
    q.includes("sí ") ||
    q.includes("dale") ||
    q.includes("ok") ||
    q.includes("okay") ||
    q.includes("de acuerdo") ||
    q.includes("confirmo") ||
    q.includes("confirmar") ||
    q.includes("lo quiero") ||
    q.includes("quiero ese") ||
    q.includes("reservame") ||
    q.includes("resérvame")
  );
}

function isNegative(text) {
  const q = normalizeText(text);
  return (
    q === "no" ||
    q.includes("no gracias") ||
    q.includes("ya no") ||
    q.includes("despues") ||
    q.includes("después")
  );
}

// ✅ matcher fuerte (colágeno no se confunde con magnesio)
function findBestProduct(text) {
  const q = normalizeText(text);
  if (!q) return null;

  const STOP = new Set([
    "necesito","quiero","dame","tienes","hay","busco","un","una","el","la","los","las",
    "por","para","favor","porfa","precio","cuanto","cuánto","info","informacion","información",
    "me","lo","de","del","esta","ese","esa","esto","uno","una","1","2","3"
  ]);

  const qWords = q.split(" ").filter(w => w && !STOP.has(w) && w.length > 2);
  if (qWords.length === 0) return null;

  let best = null;
  let bestScore = 0;

  for (const p of PRODUCTS) {
    const name = normalizeText(p.name);
    let score = 0;

    for (const w of qWords) {
      if (name.includes(w)) score += 5;
    }

    if (q.includes("colageno") && name.includes("colageno")) score += 40;
    if (q.includes("mosqueta") && name.includes("mosqueta")) score += 40;
    if (q.includes("solar") && name.includes("solar")) score += 25;
    if (q.includes("urea") && name.includes("urea")) score += 25;
    if (q.includes("hialuronico") && name.includes("hialuronico")) score += 25;

    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  return bestScore >= 5 ? best : null;
}

// ======================================================
// ✅ Upstash Redis (REST) helpers
// ======================================================
async function redisCommand(command) {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) return null;

  const res = await fetch(UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ command }),
  });

  const data = await res.json();
  return data?.result ?? null;
}

async function redisGetJson(key) {
  const val = await redisCommand(["GET", key]);
  if (!val) return null;
  try { return JSON.parse(val); } catch { return null; }
}

async function redisSetJson(key, obj, ttlSeconds = 86400) {
  const value = JSON.stringify(obj);
  await redisCommand(["SET", key, value, "EX", String(ttlSeconds)]);
}

async function redisGetStr(key) {
  const val = await redisCommand(["GET", key]);
  return val || null;
}

async function redisSetStr(key, value, ttlSeconds = 300) {
  await redisCommand(["SET", key, value, "EX", String(ttlSeconds)]);
}

// ======================================================
// ✅ WhatsApp Senders
// ======================================================
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
  console.log("WhatsApp:", JSON.stringify(data, null, 2));
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
  console.log("WhatsApp IMG:", JSON.stringify(data, null, 2));
}

// ======================================================
// ✅ OpenAI (solo cuando NO se detecta producto)
// TIP: Si quieres bajarlo más, cambia model a "gpt-4.1-nano"
// ======================================================
function getSystemPrompt() {
  return `
Eres una asistente de ventas de "Glowny Essentials" (RD).
Responde corto (1-3 líneas).
No inventes precios.
Si no entiendes el producto, pide palabra clave o foto.
Evita repetir la misma pregunta si el cliente ya respondió.
`;
}

async function callOpenAI(history, userText) {
  const messages = [
    { role: "system", content: getSystemPrompt() },
    ...(history || []),
    { role: "user", content: userText },
  ];

  const payload = {
    model: "gpt-4.1-mini", // ✅ Puedes cambiar a: "gpt-4.1-nano"
    messages,
    temperature: 0.2,
    max_tokens: 200,
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
    console.log("OpenAI ERROR:", JSON.stringify(data, null, 2));
    return "Estoy procesando varios mensajes 🙏 Escríbeme de nuevo en 10 segunditos porfa.";
  }

  return data.choices?.[0]?.message?.content || "Disculpa 😥 ¿Me lo repites?";
}

// ======================================================
// ✅ Webhook Verify (GET)
// ======================================================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado ✅");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// ======================================================
// ✅ Webhook Receive (POST)
// ======================================================
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const from = message.from;
    const msgId = message.id || "";

    // ✅ Anti-duplicado (Meta reintenta)
    if (msgId) {
      const exists = await redisGetStr(`msg:${msgId}`);
      if (exists) return res.sendStatus(200);
      await redisSetStr(`msg:${msgId}`, "1", 600);
    }

    // ✅ Estado + Historia
    const userStateKey = `state:${from}`;
    const histKey = `hist:${from}`;

    let state = (await redisGetJson(userStateKey)) || {
      lastProductId: null,
      lastReply: null,
      lastUserText: null,
      lastReplyAt: 0,
      pendingReserve: null, // { productId, qty }
      orderStep: null,      // "awaiting_details"
      orderDetails: null,   // texto del cliente
      lastLocation: null,
    };

    let history = (await redisGetJson(histKey)) || [];

    // ✅ userText
    let userText = "";
    if (message.type === "location" && message.location) {
      const loc = message.location;
      userText = "Te envié mi ubicación por WhatsApp.";

      state.lastLocation = {
        latitude: loc.latitude,
        longitude: loc.longitude,
        name: loc.name || "",
        address: loc.address || "",
      };
    } else {
      userText = message.text?.body || "";
    }

    const cleanText = normalizeText(userText);

    // ✅ Si está esperando datos de entrega
    if (state.orderStep === "awaiting_details" && state.pendingReserve) {
      // Si el cliente dice NO, cancelamos
      if (isNegative(userText)) {
        state.orderStep = null;
        state.pendingReserve = null;

        await redisSetJson(userStateKey, state, 60 * 60 * 24 * 7);
        await sendWhatsAppMessage(from, "Perfecto 😊 cuando quieras me dices y te ayudo 💗");
        return res.sendStatus(200);
      }

      // Guardamos detalles (texto)
      state.orderDetails = userText;

      const prod = PRODUCTS.find((p) => p.id === state.pendingReserve.productId);
      const qty = state.pendingReserve.qty || 1;

      const subtotal = (prod?.price || 0) * qty;
      const total = subtotal + SHIPPING_FEE;

      // ✅ Confirmación al cliente
      let confirmMsg = `Listo 💗 Pedido confirmado:\n${qty}x ${prod?.name}\nTotal: RD$${total}`;
      if (SHIPPING_FEE > 0) confirmMsg += ` (Incluye envío RD$${SHIPPING_FEE})`;
      confirmMsg += `\nEn breve te escribimos para coordinar 🙏`;

      // anti repetición
      if (!(state.lastReply === confirmMsg && Date.now() - state.lastReplyAt < 15000)) {
        await sendWhatsAppMessage(from, confirmMsg);
      }

      // ✅ Enviar al ADMIN
      let adminText = `📦 NUEVO PEDIDO - Glowny Essentials\n\n`;
      adminText += `👤 Cliente: ${from}\n`;
      adminText += `Abrir chat: https://wa.me/${from}\n\n`;
      adminText += `🛒 Productos:\n- ${qty}x ${prod?.name} — RD$${prod?.price}\n`;
      adminText += `\n💰 Subtotal: RD$${subtotal}\n`;
      if (SHIPPING_FEE > 0) adminText += `🚚 Envío: RD$${SHIPPING_FEE}\n`;
      adminText += `✅ Total: RD$${total}\n\n`;

      adminText += `📝 Datos de entrega:\n${userText}\n`;

      if (state.lastLocation) {
        adminText += `\n📍 Ubicación:\nLat: ${state.lastLocation.latitude}, Lon: ${state.lastLocation.longitude}\n`;
        adminText += `Google Maps: https://www.google.com/maps?q=${state.lastLocation.latitude},${state.lastLocation.longitude}\n`;
        if (state.lastLocation.address) adminText += `Dirección: ${state.lastLocation.address}\n`;
        if (state.lastLocation.name) adminText += `Nombre: ${state.lastLocation.name}\n`;
      }

      // Tag interno
      adminText += `\n${ORDER_TAG}\n`;
      adminText += JSON.stringify(
        {
          cliente: from,
          items: [{ name: prod?.name, qty }],
          envio: SHIPPING_FEE,
          total,
          nota: userText,
        },
        null,
        0
      );

      await sendWhatsAppMessage(ADMIN_PHONE, adminText);

      // limpiar estado
      state.orderStep = null;
      state.pendingReserve = null;
      state.lastReply = confirmMsg;
      state.lastReplyAt = Date.now();
      state.lastUserText = cleanText;

      await redisSetJson(userStateKey, state, 60 * 60 * 24 * 7);

      // historia
      history = [
        ...history,
        { role: "user", content: userText },
        { role: "assistant", content: confirmMsg },
      ].slice(-6);
      await redisSetJson(histKey, history, 60 * 60 * 24 * 7);

      return res.sendStatus(200);
    }

    // ✅ Si el cliente responde "sí" a la reserva (sin volver a pedir producto)
    if (isAffirmative(userText) && state.pendingReserve) {
      state.orderStep = "awaiting_details";

      await redisSetJson(userStateKey, state, 60 * 60 * 24 * 7);

      const askDetails =
        "Perfecto 💗 Para enviártelo solo dime:\n" +
        "1) Nombre y apellido\n" +
        "2) Dirección exacta + referencia\n" +
        "3) Sector / ciudad\n" +
        "📎 También puedes enviarme tu ubicación por el clip > Ubicación 😊";

      await sendWhatsAppMessage(from, askDetails);

      state.lastReply = askDetails;
      state.lastReplyAt = Date.now();
      state.lastUserText = cleanText;
      await redisSetJson(userStateKey, state, 60 * 60 * 24 * 7);

      return res.sendStatus(200);
    }

    // ✅ Detectar producto SIN IA
    const prodMatch = findBestProduct(userText);
    if (prodMatch) {
      state.lastProductId = prodMatch.id;

      // ✅ Si piden imagen
      if (isAskingForImage(userText) && prodMatch.image) {
        const caption = `${prodMatch.name}\nPrecio: RD$${prodMatch.price}\n¿Lo quieres para pedirlo? 💗`;

        if (!(state.lastReply === caption && Date.now() - state.lastReplyAt < 15000)) {
          await sendWhatsAppImage(from, prodMatch.image, caption);
        }

        state.lastReply = caption;
        state.lastReplyAt = Date.now();
        state.lastUserText = cleanText;

        await redisSetJson(userStateKey, state, 60 * 60 * 24 * 7);
        return res.sendStatus(200);
      }

      // ✅ Reserva (y guardamos pendingReserve)
      const qty = detectQty(userText);
      state.pendingReserve = { productId: prodMatch.id, qty };

      const reply =
        `Tengo este 💗\n${prodMatch.name}\nPrecio: RD$${prodMatch.price} c/u\n¿Te reservo ${qty > 1 ? `${qty} unidades` : "1 unidad"}? 😊`;

      if (!(state.lastReply === reply && Date.now() - state.lastReplyAt < 15000)) {
        await sendWhatsAppMessage(from, reply);
      }

      state.lastReply = reply;
      state.lastReplyAt = Date.now();
      state.lastUserText = cleanText;

      await redisSetJson(userStateKey, state, 60 * 60 * 24 * 7);

      history = [
        ...history,
        { role: "user", content: userText },
        { role: "assistant", content: reply },
      ].slice(-6);
      await redisSetJson(histKey, history, 60 * 60 * 24 * 7);

      return res.sendStatus(200);
    }

    // ✅ Si pide imagen pero tenemos último producto
    if (isAskingForImage(userText) && state.lastProductId) {
      const prod = PRODUCTS.find((p) => p.id === state.lastProductId);
      if (prod?.image) {
        const caption = `${prod.name}\nPrecio: RD$${prod.price}\n¿Lo quieres para pedirlo? 💗`;

        if (!(state.lastReply === caption && Date.now() - state.lastReplyAt < 15000)) {
          await sendWhatsAppImage(from, prod.image, caption);
        }

        state.lastReply = caption;
        state.lastReplyAt = Date.now();
        state.lastUserText = cleanText;
        await redisSetJson(userStateKey, state, 60 * 60 * 24 * 7);

        return res.sendStatus(200);
      }
    }

    // ✅ si repite texto rápido, ignora
    if (state.lastUserText === cleanText && Date.now() - state.lastReplyAt < 8000) {
      return res.sendStatus(200);
    }

    // ✅ IA solo si no entendimos el producto
    const rawReply = await callOpenAI(history, userText);
    const reply = (rawReply || "").trim();

    if (!(state.lastReply === reply && Date.now() - state.lastReplyAt < 15000)) {
      await sendWhatsAppMessage(from, reply);
    }

    state.lastReply = reply;
    state.lastReplyAt = Date.now();
    state.lastUserText = cleanText;
    await redisSetJson(userStateKey, state, 60 * 60 * 24 * 7);

    history = [
      ...history,
      { role: "user", content: userText },
      { role: "assistant", content: reply },
    ].slice(-6);
    await redisSetJson(histKey, history, 60 * 60 * 24 * 7);

    return res.sendStatus(200);
  } catch (err) {
    console.error("Error en /webhook:", err);
    return res.sendStatus(200);
  }
});

// ======================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Bot corriendo en el puerto ${PORT}`));
