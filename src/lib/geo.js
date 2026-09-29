import { PRIORITY_RADIUS_KM, POSITION_FRESH_MS, PRIORITY_MAX_DRIVERS } from "./constants";

// Version "pure" du calcul de priorité, utilisable en dehors du rendu (dans
// l'écouteur Firestore notamment, qui n'a pas accès à l'état React à jour).
export function computePriorityDrivers(ride, positions) {
  const origin = ridePickupCoords(ride);
  if (!origin) return [];
  const now = Date.now();
  const candidates = [];
  Object.entries(positions || {}).forEach(([name, pos]) => {
    if (name === ride.postedBy) return;
    if (pos.updatedAt && now - pos.updatedAt > POSITION_FRESH_MS) return;
    const d = distanceKm(origin, pos);
    if (d != null && d <= PRIORITY_RADIUS_KM) candidates.push({ name, dist: d });
  });
  candidates.sort((a, b) => a.dist - b.dist);
  return candidates.slice(0, PRIORITY_MAX_DRIVERS);
}

// Pour l'affichage compact sur la carte : ne garde que la localité (l'adresse
// complète reste visible dans la fenêtre détaillée, ouverte en cliquant sur la carte).
export function cardLocality(address) {
  if (!address) return "";
  const parts = address.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[1];
  return parts[0];
}

// Simplifie l'adresse complète renvoyée par le service (numéro + rue, ville, code postal).
// Si le résultat est un lieu nommé (hôpital, clinique, pharmacie...), son nom est utilisé
// en tête plutôt que le nom de rue — bien plus utile pour repérer la bonne adresse.
export function shortAddress(s) {
  const a = s.address || {};
  const poiName = s.namedetails?.name || a[s.class] || null;
  const street = [a.house_number, a.road || a.pedestrian || a.footway].filter(Boolean).join(" ");
  const locality = a.village || a.town || a.city || a.municipality || a.suburb || "";
  const postcode = a.postcode || "";
  if (poiName) {
    const parts = [poiName, locality].filter(Boolean);
    return parts.length ? parts.join(", ") : s.display_name;
  }
  // Sans nom de commune, "5 rue du Rhin, 67240" ou pire, juste "67240", n'aide personne à
  // identifier le lieu — mieux vaut alors le nom complet renvoyé par le service de recherche
  // (qui liste toujours au moins la commune) que ce format compact mais incomplet.
  if (!locality) return s.display_name;
  const parts = [street, locality, postcode].filter(Boolean);
  return parts.length ? parts.join(", ") : s.display_name;
}

export const MEDICAL_POI_TYPES = new Set(["hospital", "clinic", "doctors", "pharmacy", "nursing_home"]);
export function isMedicalPoi(s) {
  return s.class === "amenity" && MEDICAL_POI_TYPES.has(s.type);
}

// Résultats sans intérêt comme point de prise en charge/dépose (arrêts de bus, feux,
// limites administratives de ville/région...) — ils polluent surtout les recherches
// de lieux nommés, où le vrai lieu (ex: l'hôpital) se retrouve noyé parmi ses arrêts de bus.
export const NOISE_CLASSES = new Set(["boundary", "natural", "landuse", "waterway"]);
export const NOISE_HIGHWAY_TYPES = new Set(["bus_stop", "traffic_signals", "crossing", "give_way", "stop", "milestone", "street_lamp", "speed_camera"]);
export const NOISE_RAILWAY_TYPES = new Set(["platform", "stop", "signal", "switch"]);
export function isNoiseResult(s) {
  if (NOISE_CLASSES.has(s.class)) return true;
  if (s.class === "highway" && NOISE_HIGHWAY_TYPES.has(s.type)) return true;
  if (s.class === "railway" && NOISE_RAILWAY_TYPES.has(s.type)) return true;
  return false;
}

// Convertit un résultat de la Base Adresse Nationale (adresse.data.gouv.fr, service public
// français) vers la même forme que les résultats Nominatim, pour réutiliser telles quelles
// shortAddress/isNoiseResult/isMedicalPoi/rankAddressResults sur les deux sources combinées.
// La BAN est bien plus tolérante aux fautes de frappe sur les adresses de rue que Nominatim
// (base postale officielle avec recherche floue), mais ne connaît pas les noms de lieux
// (hôpitaux, commerces...) — d'où la combinaison des deux plutôt qu'un remplacement.
export function banToAddressResult(feature) {
  const p = feature.properties || {};
  const [lon, lat] = feature.geometry?.coordinates || [null, null];
  return {
    place_id: `ban-${p.id || `${lat},${lon}`}`,
    lat: String(lat),
    lon: String(lon),
    display_name: p.label,
    class: "ban",
    type: p.type,
    namedetails: null,
    address: {
      house_number: p.housenumber,
      road: p.street || (p.type === "street" ? p.name : undefined),
      city: p.city,
      postcode: p.postcode,
    },
  };
}

export async function fetchBanSuggestions(query, here) {
  const params = new URLSearchParams({ q: query, limit: "6" });
  if (here) {
    params.set("lat", String(here.lat));
    params.set("lon", String(here.lng));
  }
  const res = await fetch(`https://api-adresse.data.gouv.fr/search/?${params.toString()}`);
  const data = await res.json();
  return (data.features || []).map(banToAddressResult);
}

// Alterne les deux sources plutôt que de tout concaténer : sinon les meilleurs résultats
// de la seconde source (souvent le vrai lieu nommé côté Nominatim) se retrouvent noyés
// derrière les six résultats, même médiocres, de la première.
export function interleaveResults(a, b) {
  const out = [];
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i]) out.push(a[i]);
    if (b[i]) out.push(b[i]);
  }
  return out;
}

// Distance au-delà de laquelle on arrête de tenir compte de la proximité pour classer les
// résultats : une course médicale part souvent vers un hôpital spécialisé à 50-100 km, et ce
// résultat, pourtant le bon, ne doit pas être relégué derrière un résultat proche mais hors
// sujet. Sous ce seuil, on se contente de séparer "plausible" de "loin" — sans retrier par
// distance à l'intérieur du groupe, pour ne pas écraser le score de pertinence déjà calculé
// par chaque service (score de la BAN, importance/proximité déjà appliquée par Nominatim).
export const NEARBY_RANK_RADIUS_KM = 60;

// Filtre le bruit, sépare résultats plausibles/lointains, fait remonter un lieu nommé identifié
// avec certitude (ex: la fiche OSM de l'hôpital) devant une simple correspondance partielle de
// nom de rue (ex: une rue contenant "hôpital" dans son nom), puis déduplique les entrées
// identiques une fois affichées (ex: l'hôpital et son arrêt de bus homonyme).
export function rankAddressResults(data, here) {
  const filtered = data.filter((s) => !isNoiseResult(s));
  // Si le filtrage a tout supprimé (requête très spécifique ne renvoyant que du "bruit"),
  // mieux vaut afficher ces résultats que rien du tout.
  const base = filtered.length > 0 ? filtered : data;
  let ordered = base;
  if (here) {
    const withDist = base.map((s, idx) => ({
      s,
      idx,
      d: distanceKm(here, { lat: parseFloat(s.lat), lng: parseFloat(s.lon) }),
    }));
    const near = withDist.filter((x) => x.d == null || x.d <= NEARBY_RANK_RADIUS_KM).sort((a, b) => a.idx - b.idx);
    const far = withDist.filter((x) => x.d != null && x.d > NEARBY_RANK_RADIUS_KM).sort((a, b) => a.idx - b.idx);
    ordered = [...near, ...far].map((x) => x.s);
  }
  const namedPois = ordered.filter((s) => s.namedetails?.name);
  const others = ordered.filter((s) => !s.namedetails?.name);
  ordered = [...namedPois, ...others];
  const seen = new Set();
  return ordered.filter((s) => {
    const label = shortAddress(s);
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });
}

// Distance à vol d'oiseau entre la position du chauffeur et un résultat de recherche brut,
// affichée dans la liste de suggestions pour départager rapidement plusieurs résultats homonymes.
export function suggestionDistanceLabel(here, s) {
  if (!here) return null;
  const d = distanceKm(here, { lat: parseFloat(s.lat), lng: parseFloat(s.lon) });
  if (d == null) return null;
  return `${d < 10 ? d.toFixed(1) : Math.round(d)} km`;
}

export function distanceKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

// Renvoie le point le plus précis disponible pour la prise en charge d'une
// course : l'adresse de départ géocodée (précise) en priorité, sinon la
// position du chauffeur au moment du post (ancienne méthode, moins précise,
// gardée en secours pour les courses créées avant ce correctif).
// Distance routière réelle via OSRM (service public gratuit, sans clé API,
// mais non garanti à 100% en disponibilité — on retombe sur la distance à vol
// d'oiseau si ça échoue ou met trop de temps, pour ne jamais bloquer le calcul).
export async function fetchRoadDistanceKm(from, to) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes?.[0]) return null;
    return data.routes[0].distance / 1000; // mètres -> km
  } catch (e) {
    return null;
  }
}

export function ridePickupCoords(r) {
  if (r.departLat != null && r.departLng != null) return { lat: r.departLat, lng: r.departLng };
  if (r.lat != null && r.lng != null) return { lat: r.lat, lng: r.lng };
  return null;
}

// Liens d'itinéraire gratuits (aucune clé API nécessaire) — ouvrent l'appli
// installée sur le téléphone si elle existe, sinon la version web.
export function wazeUrl(lat, lng, address) {
  if (lat != null && lng != null) return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
  return `https://waze.com/ul?q=${encodeURIComponent(address || "")}&navigate=yes`;
}
export function googleMapsUrl(lat, lng, address) {
  if (lat != null && lng != null) return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address || "")}`;
}
