import { ETABLISSEMENTS as GENERATED } from "./etablissements";
import { EXTRA_ETABLISSEMENTS, EXTRA_OVERRIDES } from "./etablissementsExtra";
import { distanceKm, shortAddress } from "./geo";

// Catalogue généré depuis OSM + compléments manuels (corrections et établissements manquants).
const ETABLISSEMENTS = [
  ...GENERATED.map((e) => {
    const o = EXTRA_OVERRIDES[e.name];
    if (!o) return e;
    // L'ancien nom OSM reste cherchable en alias quand l'entrée est renommée.
    const aliases = [...(e.aliases || []), ...(o.name ? [e.name] : []), ...(o.aliases || [])];
    return { ...e, name: o.name || e.name, aliases };
  }),
  ...EXTRA_ETABLISSEMENTS,
];

// Raccourcis d'adresse instantanés, sans réseau : les adresses déjà utilisées par le chauffeur
// (favoris + fréquentes, voir storage.js) et le catalogue local des hôpitaux/cliniques d'Alsace
// (etablissements.js). Ils s'affichent dès la 1re lettre tapée, avant les résultats en ligne
// (BAN + Nominatim), qui arrivent ensuite en dessous.

// Minuscules, sans accents ni ponctuation, "st"/"ste" → "saint"/"sainte" : "ste anne",
// "Sainte-Anne" et "sainte anne" se retrouvent ainsi tous.
export function normalizeSearch(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bst\b/g, "saint")
    .replace(/\bste\b/g, "sainte")
    .trim();
}

// Mots qu'on peut omettre dans la saisie sans que ça bloque la correspondance.
const STOP_WORDS = new Set(["de", "du", "des", "la", "le", "les", "l", "d", "a", "et"]);

function queryTokens(query) {
  const tokens = normalizeSearch(query).split(" ").filter(Boolean);
  const meaningful = tokens.filter((t) => !STOP_WORDS.has(t));
  return meaningful.length ? meaningful : tokens;
}

// Score de correspondance (0 = aucune) : chaque mot tapé doit être le début d'un mot du nom,
// d'un alias ou de la commune — "hop hag" trouve "Centre hospitalier de Haguenau" via l'alias
// "Hopital Haguenau", "htp" trouve Hautepierre. Un alias/nom qui commence par la saisie compte
// davantage qu'une correspondance éparpillée.
function matchScore(tokens, query, texts) {
  if (!tokens.length) return 0;
  const words = new Set();
  texts.forEach((t) => normalizeSearch(t).split(" ").forEach((w) => w && words.add(w)));
  const all = [...words];
  if (!tokens.every((tok) => all.some((w) => w.startsWith(tok)))) return 0;
  const q = normalizeSearch(query);
  const [main, ...rest] = texts.map(normalizeSearch);
  if (rest.some((t) => t === q)) return 4; // sigle/alias exact (HTP, NHC, CMCO...)
  if (main.startsWith(q) || rest.some((t) => t.startsWith(q))) return 3;
  if (tokens.every((tok) => main.split(" ").some((w) => w.startsWith(tok)))) return 2;
  return 1;
}

export function etablissementLabel(e) {
  return `${e.name}, ${e.city}`;
}

// Forme commune aux raccourcis (même forme que les adresses récentes : `recent`-like, adresse
// prête à l'emploi), pour que pickAddressSuggestion les traite sans appel réseau.
function etablissementItem(e) {
  return {
    local: true,
    etab: true,
    medical: true,
    address: etablissementLabel(e),
    detail: e.street ? `${e.street}, ${e.city}` : e.city,
    lat: e.lat,
    lng: e.lng,
    city: e.city,
    dept: e.dept,
  };
}

const MAX_RECENT_MATCHES = 4;
const MAX_ETAB_MATCHES = 6;

export function localAddressMatches(query, recentAddresses, here) {
  const tokens = queryTokens(query);
  if (!tokens.length) return [];
  const dist = (x) => distanceKm(here, x) ?? Infinity;
  const recents = recentAddresses
    .map((r) => ({ r, score: matchScore(tokens, query, [r.address, r.city || ""]) }))
    .filter((x) => x.score > 0)
    // Favoris puis adresses habituelles d'abord : l'ordre de recentAddresses est déjà le bon.
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RECENT_MATCHES)
    .map((x) => x.r);
  const taken = new Set(recents.map((r) => r.address));
  const etabs = ETABLISSEMENTS
    .map((e) => ({ e, score: matchScore(tokens, query, [e.name, ...(e.aliases || []), e.city]) }))
    .filter((x) => x.score > 0 && !taken.has(etablissementLabel(x.e)))
    .sort((a, b) => b.score - a.score || dist(a.e) - dist(b.e))
    .slice(0, MAX_ETAB_MATCHES)
    .map((x) => etablissementItem(x.e));
  return [...recents, ...etabs];
}

// Retire des résultats en ligne ceux déjà proposés en raccourci (même libellé, ou même lieu à
// moins de ~150 m pour un lieu nommé — typiquement la fiche Nominatim de l'hôpital du catalogue ;
// une simple adresse de rue voisine reste proposée).
export function dropDuplicateResults(results, shortcuts) {
  if (!shortcuts.length) return results;
  const labels = new Set(shortcuts.map((s) => s.address));
  return results.filter((s) => {
    if (labels.has(shortAddress(s))) return false;
    if (!s.namedetails?.name) return true;
    const p = { lat: parseFloat(s.lat), lng: parseFloat(s.lon) };
    return !shortcuts.some((x) => x.etab && (distanceKm(p, x) ?? Infinity) < 0.15);
  });
}
