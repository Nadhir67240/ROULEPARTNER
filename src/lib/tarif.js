// Grille tarifaire officielle "Taxi conventionné" — Convention nationale 2025
// (source : ameli.fr, arrêté du 29 juillet 2025). Le tarif au km dépend du
// département de licence — modifie DEFAULT_KM_RATE si besoin (1,07 à 1,27 €/km).
export const TAXI_FORFAIT_PEC = 13.0; // forfait de prise en charge, 4 premiers km inclus
export const TAXI_FRANCHISE_KM = 4;
// Grille officielle "Taxi conventionné" par département — Convention nationale 2025
// (arrêté du 29 juillet 2025, en vigueur depuis le 01/11/2025), source ameli.fr.
export const DEPARTMENT_KM_RATES = [
  ["01", "Ain", 1.13], ["02", "Aisne", 1.20], ["2A", "Corse-du-Sud", 1.27], ["2B", "Haute-Corse", 1.27],
  ["03", "Allier", 1.19], ["04", "Alpes-de-Haute-Provence", 1.14], ["05", "Hautes-Alpes", 1.18],
  ["06", "Alpes-Maritimes", 1.27], ["07", "Ardèche", 1.17], ["08", "Ardennes", 1.17], ["09", "Ariège", 1.15],
  ["10", "Aube", 1.13], ["11", "Aude", 1.08], ["12", "Aveyron", 1.16], ["13", "Bouches-du-Rhône", 1.10],
  ["14", "Calvados", 1.07], ["15", "Cantal", 1.13], ["16", "Charente", 1.12], ["17", "Charente-Maritime", 1.10],
  ["18", "Cher", 1.26], ["19", "Corrèze", 1.16], ["21", "Côte-d'Or", 1.12], ["22", "Côtes-d'Armor", 1.13],
  ["23", "Creuse", 1.18], ["24", "Dordogne", 1.11], ["25", "Doubs", 1.08], ["26", "Drôme", 1.16],
  ["27", "Eure", 1.21], ["28", "Eure-et-Loir", 1.19], ["29", "Finistère", 1.07], ["30", "Gard", 1.08],
  ["31", "Haute-Garonne", 1.10], ["32", "Gers", 1.19], ["33", "Gironde", 1.07], ["34", "Hérault", 1.07],
  ["35", "Ille-et-Vilaine", 1.07], ["36", "Indre", 1.25], ["37", "Indre-et-Loire", 1.18], ["38", "Isère", 1.22],
  ["39", "Jura", 1.11], ["40", "Landes", 1.13], ["41", "Loir-et-Cher", 1.13], ["42", "Loire", 1.08],
  ["43", "Haute-Loire", 1.24], ["44", "Loire-Atlantique", 1.08], ["45", "Loiret", 1.07], ["46", "Lot", 1.13],
  ["47", "Lot-et-Garonne", 1.11], ["48", "Lozère", 1.25], ["49", "Maine-et-Loire", 1.08], ["50", "Manche", 1.16],
  ["51", "Marne", 1.12], ["52", "Haute-Marne", 1.26], ["53", "Mayenne", 1.09], ["54", "Meurthe-et-Moselle", 1.09],
  ["55", "Meuse", 1.12], ["56", "Morbihan", 1.07], ["57", "Moselle", 1.14], ["58", "Nièvre", 1.27],
  ["59", "Nord", 1.20], ["60", "Oise", 1.20], ["61", "Orne", 1.17], ["62", "Pas-de-Calais", 1.20],
  ["63", "Puy-de-Dôme", 1.08], ["64", "Pyrénées-Atlantiques", 1.14], ["65", "Hautes-Pyrénées", 1.07],
  ["66", "Pyrénées-Orientales", 1.18], ["67", "Bas-Rhin", 1.07], ["68", "Haut-Rhin", 1.07], ["69", "Rhône", 1.07],
  ["70", "Haute-Saône", 1.08], ["71", "Saône-et-Loire", 1.10], ["72", "Sarthe", 1.07], ["73", "Savoie", 1.15],
  ["74", "Haute-Savoie", 1.22], ["75", "Paris", 1.22], ["76", "Seine-Maritime", 1.18], ["77", "Seine-et-Marne", 1.07],
  ["78", "Yvelines", 1.07], ["79", "Deux-Sèvres", 1.08], ["80", "Somme", 1.15], ["81", "Tarn", 1.07],
  ["82", "Tarn-et-Garonne", 1.07], ["83", "Var", 1.16], ["84", "Vaucluse", 1.20], ["85", "Vendée", 1.07],
  ["86", "Vienne", 1.11], ["87", "Haute-Vienne", 1.10], ["88", "Vosges", 1.10], ["89", "Yonne", 1.11],
  ["90", "Territoire de Belfort", 1.08], ["91", "Essonne", 1.07], ["92", "Hauts-de-Seine", 1.07],
  ["93", "Seine-Saint-Denis", 1.07], ["94", "Val-de-Marne", 1.07], ["95", "Val-d'Oise", 1.07],
  ["971", "Guadeloupe", 1.07], ["972", "Martinique", 1.20], ["973", "Guyane", 1.10], ["974", "Réunion", 1.22],
  ["976", "Mayotte", 1.10],
];
export const DEFAULT_DEPARTMENT = "67"; // Bas-Rhin
export const DEFAULT_KM_RATE = 1.07;
export const TAXI_FORFAIT_GRANDE_VILLE = 15.0;
export const TAXI_MAJORATION_NUIT_WEEKEND = 0.5; // +50 %
export const TAXI_TPMR_SUPPLEMENT = 30.0; // supplément fixe, par trajet
export const TAXI_RETOUR_A_VIDE_SEUIL_KM = 50;
export const TAXI_RETOUR_A_VIDE_MAJORATION_COURT = 0.25; // < 50 km en charge
export const TAXI_RETOUR_A_VIDE_MAJORATION_LONG = 0.5; // >= 50 km en charge

// Calcule le tarif "Taxi conventionné" selon la convention nationale 2025
// (page tarifs officielle fournie par l'utilisateur). Approximation basée sur
// la distance à vol d'oiseau entre départ et arrivée (pas la distance
// routière réelle, généralement un peu plus longue) — à vérifier avant de facturer.
// Ordre officiel : le tarif km (majoré si retour à vide) s'ajoute au forfait PEC
// et au forfait grande ville, puis la majoration nuit/weekend/férié s'applique
// sur l'ensemble ; le supplément TPMR s'ajoute en tout dernier (hors majoration).
export function computeTaxiConventionneTarif({ distKm, allerRetour, kmRate, grandeVille, majoration, retourAVide, tpmr }) {
  if (distKm == null) return null;
  const totalKm = allerRetour ? distKm * 2 : distKm;
  const billableKm = Math.max(0, totalKm - TAXI_FRANCHISE_KM);
  let kmPortion = billableKm * kmRate;
  if (retourAVide) {
    const majo = totalKm < TAXI_RETOUR_A_VIDE_SEUIL_KM
      ? TAXI_RETOUR_A_VIDE_MAJORATION_COURT
      : TAXI_RETOUR_A_VIDE_MAJORATION_LONG;
    kmPortion *= 1 + majo;
  }
  let total = TAXI_FORFAIT_PEC + kmPortion;
  if (grandeVille) total += TAXI_FORFAIT_GRANDE_VILLE;
  if (majoration) total *= 1 + TAXI_MAJORATION_NUIT_WEEKEND;
  if (tpmr) total += TAXI_TPMR_SUPPLEMENT;
  return Math.round(total * 100) / 100;
}

// Détecte automatiquement si l'heure de prise en charge tombe dans la plage
// "nuit/dimanche" de la convention (20h-8h, ou samedi à partir de 12h, ou dimanche).
// Les jours fériés ne peuvent pas être détectés automatiquement (pas de calendrier
// intégré) — le chauffeur garde la main pour cocher/décocher manuellement ensuite.
export function autoDetectNightWeekend(heureStr) {
  if (!heureStr) return false;
  const [h] = heureStr.split(":").map(Number);
  if (Number.isNaN(h)) return false;
  const day = new Date().getDay(); // 0 = dimanche, 6 = samedi
  const isNight = h >= 20 || h < 8;
  const isWeekend = day === 0 || (day === 6 && h >= 12);
  return isNight || isWeekend;
}

// Extrait la commune et le département d'un résultat de recherche d'adresse (Nominatim ou BAN,
// mêmes clés depuis banToAddressResult) — utilisé pour détecter automatiquement le forfait
// "grande ville" de la convention taxi conventionné.
export function addressCityDept(item) {
  const a = item.address || {};
  const city = a.village || a.town || a.city || a.municipality || a.suburb || "";
  const postcode = a.postcode || "";
  return { city, dept: postcode ? postcode.slice(0, 2) : "" };
}

// Villes et départements ouvrant droit au forfait "grande ville" (+15 €) — arrêté du
// 29 juillet 2025 portant approbation de la convention-cadre nationale taxi/Assurance Maladie.
// La CPAM publie aussi une liste d'établissements "limitrophes" à ces communes qui en
// bénéficient par exception : cette détection automatique ne les couvre pas, la case reste
// donc modifiable à la main pour ces cas particuliers.
export const GRANDE_VILLE_CITIES = new Set([
  "marseille", "paris", "nice", "toulouse", "lyon", "strasbourg",
  "montpellier", "rennes", "bordeaux", "lille", "grenoble", "nantes",
]);
export const GRANDE_VILLE_DEPTS = new Set(["92", "93", "94"]);

export function normalizeCityName(s) {
  return (s || "").toLowerCase().trim();
}

export function isGrandeVilleZone(city, dept) {
  if (dept && GRANDE_VILLE_DEPTS.has(dept)) return true;
  const norm = normalizeCityName(city);
  if (!norm) return false;
  // Gère les arrondissements ("Paris 15e", "Lyon 3e"...) en plus du nom seul.
  for (const c of GRANDE_VILLE_CITIES) {
    if (norm === c || norm.startsWith(c + " ") || norm.startsWith(c + "-")) return true;
  }
  return false;
}

export function stripAccents(s) {
  return Array.from((s || "").normalize("NFD"))
    .filter((ch) => ch.codePointAt(0) < 0x0300 || ch.codePointAt(0) > 0x036f)
    .join("");
}

// Établissements limitrophes bénéficiant du forfait "grande ville" par exception malgré une
// commune hors de la liste officielle — validés par la Cnam (liste des établissements par
// extension au 01/04/2026, publiée sur ameli.fr). Le service de recherche d'adresse utilisé par
// l'appli ne référence pas correctement tous ces établissements (ex: UGECAM Illkirch n'apparaît
// que comme un arrêt de bus, Clinique du Ried pas du tout), d'où une détection sur le texte de
// l'adresse saisie plutôt que sur la commune géocodée. Chaque entrée est un groupe de mots-clés
// qui doivent TOUS apparaître, pour éviter les faux positifs (ex: "Ugecam" seul existe dans
// plusieurs villes en France qui ne bénéficient pas du forfait).
export const GRANDE_VILLE_EXTENSION_MATCHERS = [
  ["cmco"], // Centre Médico-Chirurgical et Obstétrical, Schiltigheim
  ["medico-chirurgical", "schiltigheim"], // même établissement, nom complet
  ["ugecam", "illkirch"], // UGECAM Alsace, Illkirch
  ["clinique du ried"], // Clinique du Ried, Schiltigheim
];

export function matchesGrandeVilleExtension(addressText) {
  const norm = stripAccents((addressText || "").toLowerCase());
  return GRANDE_VILLE_EXTENSION_MATCHERS.some((group) => group.every((kw) => norm.includes(kw)));
}
