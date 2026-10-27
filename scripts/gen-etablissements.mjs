// Génère src/lib/etablissements.js : le catalogue local des hôpitaux, cliniques et centres de
// soins d'Alsace (Bas-Rhin + Haut-Rhin), proposé instantanément dans la saisie d'adresse, sans
// attendre le réseau. Données OpenStreetMap (Overpass), commune/code postal vérifiés via la Base
// Adresse Nationale (reverse geocoding) quand OSM ne les donne pas.
//
//   node scripts/gen-etablissements.mjs
//
// À relancer de temps en temps (nouveaux établissements, déménagements), puis vérifier le diff.

import { writeFileSync } from "node:fs";

const OVERPASS = "https://overpass-api.de/api/interpreter";
const QUERY = `[out:json][timeout:120];
area["ISO3166-2"~"^FR-(67|68)$"]->.a;
(
  nwr["amenity"~"^(hospital|clinic)$"](area.a);
  nwr["healthcare"~"^(hospital|centre|rehabilitation|dialysis)$"](area.a);
);
out center tags;`;

// Hors hôpitaux, OSM classe aussi en "clinic"/"centre" une foule de cabinets médicaux : on ne
// garde que les noms qui ressemblent à une destination de transport sanitaire.
const KEEP_NAME = /clinique|h[oô]pital|hospitali|r[ée]adaptation|r[ée][ée]ducation|dialyse|n[ée]phro|cancer|icans|ugecam|aural|soins de suite|ssr|psychiatr|ehpad|maison de sant[ée]|centre m[ée]dical|imagerie|radiolog|irm|scanner|centre de sant[ée]|diaconat|diaconesses|rh[ée]na|cmco|institut|pole m[ée]dical|p[ôo]le de sant[ée]/i;
const DROP_NAME = /v[ée]t[ée]rinaire|animal|dentaire|dentiste|orthodont|kin[ée]|ost[ée]opa|podolog|optique|pharmacie|laboratoire/i;

// Raccourcis que les chauffeurs tapent réellement (sigles, surnoms), appliqués seulement aux
// établissements trouvés dans OSM dont le nom correspond — jamais d'entrée inventée.
const ALIASES = [
  [/hautepierre/i, ["HTP", "CHU Hautepierre", "HUS Hautepierre"]],
  [/nouvel h[oô]pital civil/i, ["NHC", "Hopital civil", "HUS civil"]],
  [/h[oô]pital civil/i, ["Hopital civil", "HUS civil"]],
  [/rh[ée]na/i, ["Rhena", "Clinique Rhena"]],
  [/icans|paul strauss|cancérologie strasbourg europe/i, ["ICANS", "Paul Strauss", "Centre anticancer"]],
  [/m[ée]dico-chirurgical et obst[ée]trical|cmco/i, ["CMCO"]],
  [/sainte[- ]anne/i, ["Ste Anne"]],
  [/sainte[- ]odile/i, ["Ste Odile"]],
  [/sainte[- ]barbe/i, ["Ste Barbe"]],
  [/diaconesses/i, ["Diacos"]],
  [/[ée]mile muller|moenchsberg/i, ["GHRMSA", "Hopital Mulhouse", "Emile Muller"]],
  [/pasteur/i, ["Hopital Pasteur"]],
  [/elsau/i, ["Hopital Elsau"]],
  [/ugecam/i, ["UGECAM"]],
  [/clemenceau/i, ["Clemenceau"]],
];

function kind(tags) {
  if (tags.amenity === "hospital" || tags.healthcare === "hospital") return "hospital";
  return "clinic";
}

function aliasesFor(name, city) {
  const out = new Set();
  for (const [re, list] of ALIASES) if (re.test(name)) list.forEach((a) => out.add(a));
  if (/centre hospitalier/i.test(name) && city) {
    out.add(`CH ${city}`);
    out.add(`Hopital ${city}`);
  }
  if (/clinique/i.test(name) && city) out.add(`Clinique ${city}`);
  return [...out];
}

async function reverse(lat, lng) {
  const res = await fetch(`https://api-adresse.data.gouv.fr/reverse/?lon=${lng}&lat=${lat}&limit=1`);
  if (!res.ok) return null;
  const p = (await res.json()).features?.[0]?.properties;
  return p ? { city: p.city, postcode: p.postcode, street: p.name } : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const res = await fetch(OVERPASS, {
  method: "POST",
  // Overpass refuse (406) les requêtes sans User-Agent identifiable.
  headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "RoulePartner-gen-etablissements/1.0", Accept: "application/json" },
  body: new URLSearchParams({ data: QUERY }),
});
if (!res.ok) throw new Error(`Overpass ${res.status}`);
const elements = (await res.json()).elements || [];

const byKey = new Map();
for (const el of elements) {
  const t = el.tags || {};
  const name = (t.name || "").trim();
  if (!name) continue;
  const k = kind(t);
  if (k !== "hospital" && (!KEEP_NAME.test(name) || DROP_NAME.test(name))) continue;
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat == null || lng == null) continue;
  const entry = {
    name,
    type: k,
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    city: t["addr:city"] || "",
    postcode: t["addr:postcode"] || "",
    street: [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" "),
  };
  // Un même établissement est souvent cartographié plusieurs fois (bâtiment + site + entrée) :
  // on garde une seule entrée par nom, en préférant la fiche "hôpital" et celle qui a une adresse.
  // Nom normalisé : "clinique Ste Barbe" et "Clinique Sainte-Barbe" sont le même lieu.
  const key = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ")
    .replace(/\bst\b/g, "saint").replace(/\bste\b/g, "sainte").trim();
  const prev = byKey.get(key);
  if (prev && Math.abs(prev.lat - entry.lat) + Math.abs(prev.lng - entry.lng) < 0.02) {
    if ((prev.type !== "hospital" && entry.type === "hospital") || (!prev.city && entry.city)) byKey.set(key, entry);
    continue;
  }
  byKey.set(prev ? `${key}@${entry.lat},${entry.lng}` : key, entry);
}

const list = [...byKey.values()];
for (const e of list) {
  if (e.city && e.postcode) continue;
  const r = await reverse(e.lat, e.lng).catch(() => null);
  if (r) {
    e.city ||= r.city || "";
    e.postcode ||= r.postcode || "";
    e.street ||= r.street || "";
  }
  await sleep(60); // l'API BAN tolère ~50 requêtes/s, on reste très en dessous
}

const out = list
  .filter((e) => e.city)
  .map((e) => {
    const dept = /^\d{2}/.test(e.postcode) ? e.postcode.slice(0, 2) : "";
    const aliases = aliasesFor(e.name, e.city);
    return {
      name: e.name,
      type: e.type,
      city: e.city,
      dept,
      street: e.street || undefined,
      lat: e.lat,
      lng: e.lng,
      ...(aliases.length ? { aliases } : {}),
    };
  })
  .sort((a, b) => a.city.localeCompare(b.city, "fr") || a.name.localeCompare(b.name, "fr"));

const header = `// FICHIER GÉNÉRÉ par scripts/gen-etablissements.mjs (${new Date().toISOString().slice(0, 10)}) — ne pas éditer à la main.
// Hôpitaux, cliniques et centres de soins d'Alsace (OpenStreetMap, © contributeurs OSM, ODbL),
// proposés instantanément dans la saisie d'adresse des courses.
`;
writeFileSync(
  new URL("../src/lib/etablissements.js", import.meta.url),
  `${header}export const ETABLISSEMENTS = ${JSON.stringify(out, null, 0).replace(/\},\{/g, "},\n  {").replace(/^\[\{/, "[\n  {").replace(/\}\]$/, "},\n]")};\n`
);
console.log(`${out.length} établissements écrits (${elements.length} éléments OSM bruts).`);
