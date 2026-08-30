import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  Car, MapPin, Clock, User, Plus, Check, Trash2, Siren,
  Stethoscope, X, Navigation, Timer, LogOut, ChevronDown, ChevronUp, MessageCircle, Home,
  Phone, Search, Calendar, List, Inbox, Map as MapIcon, History,
  FileText, Flag, Settings, Building2, Shield, Send,
} from "lucide-react";
import {
  listenRides, addRide, updateRide, deleteRide, claimRide,
  listenPositions, setDriverPosition, clearDriverPosition,
  listenProfiles, setDriverPhone,
  listenMessages, sendMessage, listenMessagesForRides,
  requestEmailChange, updateProfileFields, changeDriverLicense,
  setDriverBanned, deleteDriverAccount, restoreDriverAccount, registerFcmToken,
  watchAuthState, signUp, logIn, logOut, resendVerificationEmail, reloadUser, requestPasswordReset,
} from "./firebase";

const TYPES = [
  { id: "taxi", label: "Taxi conventionné", color: "#FFB43A" },
  { id: "vsl", label: "VSL", color: "#3BD07A" },
  { id: "ambulance", label: "Ambulance", color: "#E86E5E" },
  { id: "taxi_payant", label: "Course payante", color: "#8FB3F5" },
];

const TRAJET_TYPES = [
  { id: "aller", label: "Aller" },
  { id: "retour", label: "Retour" },
  { id: "allerRetour", label: "Aller-retour" },
];

function trajetLabel(id) {
  return (TRAJET_TYPES.find((t) => t.id === id) || TRAJET_TYPES[0]).label;
}

// Fenêtre de priorité : à la publication, seuls les chauffeurs les plus proches
// peuvent prendre la course. Passé ce délai, elle s'ouvre à tout le monde.
const PRIORITY_WINDOW_MS = 15 * 1000;

// Si plusieurs chauffeurs sont quasiment à la même distance du départ, les
// départager au mètre près n'a aucun sens (position GPS imprécise, sens de
// circulation...). On considère donc comme "à égalité" tous ceux situés à moins
// de PRIORITY_TIE_KM du plus proche : ils reçoivent la course en même temps.
const PRIORITY_TIE_KM = 1.0;

// Nombre maximum de chauffeurs prioritaires simultanés.
const PRIORITY_MAX_DRIVERS = 3;

// Vitesse moyenne estimée pour convertir une distance à vol d'oiseau en temps de trajet.
// Approximation, pas un vrai calcul d'itinéraire routier.
const AVG_SPEED_KMH = 32;

// Délai laissé au posteur pour confirmer avant qu'une demande soit acceptée automatiquement.
const CLAIM_CONFIRM_WINDOW_MS = 30 * 1000;

// Les courses terminées depuis plus de X jours sont purgées automatiquement (y compris leur photo).
const AUTO_PURGE_DAYS = 14;

// Doit correspondre exactement à l'email utilisé dans les règles Firestore.
const ADMIN_EMAIL = "taxi-vsl67@hotmail.com";

// Grille tarifaire officielle "Taxi conventionné" — Convention nationale 2025
// (source : ameli.fr, arrêté du 29 juillet 2025). Le tarif au km dépend du
// département de licence — modifie DEFAULT_KM_RATE si besoin (1,07 à 1,27 €/km).
const TAXI_FORFAIT_PEC = 13.0; // forfait de prise en charge, 4 premiers km inclus
const TAXI_FRANCHISE_KM = 4;
// Grille officielle "Taxi conventionné" par département — Convention nationale 2025
// (arrêté du 29 juillet 2025, en vigueur depuis le 01/11/2025), source ameli.fr.
const DEPARTMENT_KM_RATES = [
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
const DEFAULT_DEPARTMENT = "67"; // Bas-Rhin
const DEFAULT_KM_RATE = 1.07;
const TAXI_FORFAIT_GRANDE_VILLE = 15.0;
const TAXI_MAJORATION_NUIT_WEEKEND = 0.5; // +50 %
const TAXI_TPMR_SUPPLEMENT = 30.0; // supplément fixe, par trajet
const TAXI_RETOUR_A_VIDE_SEUIL_KM = 50;
const TAXI_RETOUR_A_VIDE_MAJORATION_COURT = 0.25; // < 50 km en charge
const TAXI_RETOUR_A_VIDE_MAJORATION_LONG = 0.5; // >= 50 km en charge

const emptyForm = {
  type: "taxi",
  patient: "",
  patientTel: "",
  depart: "",
  arrivee: "",
  heure: "",
  date: todayKey(0),
  trajet: "aller",
  departLat: null,
  departLng: null,
  arriveeLat: null,
  arriveeLng: null,
  tarif: "",
  urgent: false,
  tpmr: false,
  grandeVille: false,
  retourAVide: false,
  calcDistanceKm: null,
  majorationNuitWeekend: false,
  notes: "",
  photo: null,
  document: null,
  documentName: "",
};

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function typeMeta(id) {
  return TYPES.find((t) => t.id === id) || TYPES[0];
}

// Fond teinté à faible opacité pour la pastille de type (texte de la même teinte que le fond) —
// une pastille sobre plutôt qu'un badge plein, l'ambre reste réservé aux actions.
function tintBg(hex, alpha) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function formatPostedAt(ts) {
  const d = new Date(ts);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const mins = String(d.getMinutes()).padStart(2, "0");
  return `${day}/${month} à ${hours}:${mins}`;
}

function dateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todayKey(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function timePlusMinutes(mins = 0) {
  const d = new Date(Date.now() + mins * 60000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatRideDate(dateStr) {
  if (!dateStr) return "";
  if (dateStr === todayKey(0)) return "aujourd'hui";
  if (dateStr === todayKey(1)) return "demain";
  return dateStr.split("-").reverse().join("/");
}

const FRENCH_MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
function formatDayMonth(dateStr) {
  const [, m, d] = dateStr.split("-").map(Number);
  return `${d} ${FRENCH_MONTHS[m - 1]}`;
}

// Plage lundi→dimanche de la semaine en cours, pour le filtre "Cette semaine".
function thisWeekRange() {
  const now = new Date();
  const day = now.getDay(); // 0 = dimanche
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { start: fmt(monday), end: fmt(sunday) };
}

let sharedAudioCtx = null;
let audioUnlocked = false;

function getAudioCtx() {
  if (!sharedAudioCtx) {
    sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return sharedAudioCtx;
}

function unlockAudio() {
  if (audioUnlocked) return;
  try {
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") ctx.resume();
    // joue un son quasi silencieux pour "débloquer" définitivement l'audio sur ce téléphone
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.05);
    audioUnlocked = true;
  } catch (e) {
    // ignore
  }
}

function playAlertSound(urgent) {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") ctx.resume();
    const notes = urgent ? [880, 660, 880] : [740];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = "sine";
      gain.gain.value = urgent ? 0.15 : 0.1;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const start = ctx.currentTime + i * 0.18;
      osc.start(start);
      osc.stop(start + 0.16);
    });
  } catch (e) {
    // navigateur sans support audio, on ignore silencieusement
  }
}

// Notification visuelle du système (bannière), en plus du son.
// Fonctionne tant que le navigateur tourne (onglet ouvert, même en arrière-plan) —
// pas si l'appli est complètement fermée ou le téléphone verrouillé longtemps.
function notifyNewRide(ride) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification(ride.urgent ? "🚨 Course urgente disponible" : "Nouvelle course disponible", {
      body: `${ride.depart} → ${ride.arrivee} — ${ride.heure}`,
      icon: "/icon-192.png",
      tag: ride.id,
    });
  } catch (e) {
    // ignore
  }
}

// Version "pure" du calcul de priorité, utilisable en dehors du rendu (dans
// l'écouteur Firestore notamment, qui n'a pas accès à l'état React à jour).
function computePriorityDrivers(ride, positions) {
  const origin = ridePickupCoords(ride);
  if (!origin) return [];
  const candidates = [];
  Object.entries(positions || {}).forEach(([name, pos]) => {
    if (name === ride.postedBy) return;
    const d = distanceKm(origin, pos);
    if (d != null) candidates.push({ name, dist: d });
  });
  if (candidates.length === 0) return [];
  candidates.sort((a, b) => a.dist - b.dist);
  const closest = candidates[0].dist;
  return candidates
    .filter((c) => c.dist - closest < PRIORITY_TIE_KM)
    .slice(0, PRIORITY_MAX_DRIVERS);
}

// Notification "course prioritaire" : plus insistante que la notification
// normale, et elle reste affichée jusqu'à ce que le chauffeur la voie
// (requireInteraction) — c'est une course qui lui est réservée quelques secondes.
function notifyPriorityRide(ride, shared) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification("⭐ Course prioritaire pour toi", {
      body: shared
        ? `${ride.depart} → ${ride.arrivee} — premier arrivé, premier servi !`
        : `${ride.depart} → ${ride.arrivee} — tu es le plus proche.`,
      icon: "/icon-192.png",
      tag: ride.id,
      requireInteraction: true,
    });
  } catch (e) {
    // ignore
  }
}

function notifyStatusChange(ride, newStatus) {
  const titles = {
    en_cours: "🚗 Ta course a démarré",
    terminee: "✅ Ta course est terminée",
  };
  const title = titles[newStatus];
  if (!title) return;
  playAlertSound(false);
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification(title, {
      body: `${ride.depart} → ${ride.arrivee} — prise par ${ride.takenBy || "?"}`,
      icon: "/icon-192.png",
      tag: `${ride.id}-${newStatus}`,
    });
  } catch (e) {
    // ignore
  }
}

function notifyNewMessage(senderName, text) {
  playAlertSound(false);
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification(`💬 Message de ${senderName}`, {
      body: text,
      icon: "/icon-192.png",
    });
  } catch (e) {
    // ignore
  }
}

// Compresse une photo côté téléphone avant stockage (pas de service payant nécessaire).
// Réduit taille + qualité jusqu'à tenir dans la limite d'un document Firestore.
function compressPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        const maxDim = 1000;
        if (width > height && width > maxDim) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else if (height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        let quality = 0.7;
        let dataUrl = canvas.toDataURL("image/jpeg", quality);
        while (dataUrl.length > 700000 && quality > 0.15) {
          quality -= 0.15;
          dataUrl = canvas.toDataURL("image/jpeg", quality);
        }
        if (dataUrl.length > 900000) {
          reject(new Error("too_big"));
        } else {
          resolve(dataUrl);
        }
      };
      img.onerror = () => reject(new Error("invalid_image"));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("read_failed"));
    reader.readAsDataURL(file);
  });
}

// Pour l'affichage compact sur la carte : ne garde que la localité (l'adresse
// complète reste visible dans la fenêtre détaillée, ouverte en cliquant sur la carte).
function cardLocality(address) {
  if (!address) return "";
  const parts = address.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[1];
  return parts[0];
}

// Simplifie l'adresse complète renvoyée par le service (numéro + rue, ville, code postal).
// Si le résultat est un lieu nommé (hôpital, clinique, pharmacie...), son nom est utilisé
// en tête plutôt que le nom de rue — bien plus utile pour repérer la bonne adresse.
function shortAddress(s) {
  const a = s.address || {};
  const poiName = s.namedetails?.name || a[s.class] || null;
  const street = [a.house_number, a.road || a.pedestrian || a.footway].filter(Boolean).join(" ");
  const locality = a.village || a.town || a.city || a.municipality || a.suburb || "";
  const postcode = a.postcode || "";
  if (poiName) {
    const parts = [poiName, locality].filter(Boolean);
    return parts.length ? parts.join(", ") : s.display_name;
  }
  const parts = [street, locality, postcode].filter(Boolean);
  return parts.length ? parts.join(", ") : s.display_name;
}

const MEDICAL_POI_TYPES = new Set(["hospital", "clinic", "doctors", "pharmacy", "nursing_home"]);
function isMedicalPoi(s) {
  return s.class === "amenity" && MEDICAL_POI_TYPES.has(s.type);
}

// Résultats sans intérêt comme point de prise en charge/dépose (arrêts de bus, feux,
// limites administratives de ville/région...) — ils polluent surtout les recherches
// de lieux nommés, où le vrai lieu (ex: l'hôpital) se retrouve noyé parmi ses arrêts de bus.
const NOISE_CLASSES = new Set(["boundary", "natural", "landuse", "waterway"]);
const NOISE_HIGHWAY_TYPES = new Set(["bus_stop", "traffic_signals", "crossing", "give_way", "stop", "milestone", "street_lamp", "speed_camera"]);
const NOISE_RAILWAY_TYPES = new Set(["platform", "stop", "signal", "switch"]);
function isNoiseResult(s) {
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
function banToAddressResult(feature) {
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

async function fetchBanSuggestions(query, here) {
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
function interleaveResults(a, b) {
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
const NEARBY_RANK_RADIUS_KM = 60;

// Filtre le bruit, sépare résultats plausibles/lointains, fait remonter un lieu nommé identifié
// avec certitude (ex: la fiche OSM de l'hôpital) devant une simple correspondance partielle de
// nom de rue (ex: une rue contenant "hôpital" dans son nom), puis déduplique les entrées
// identiques une fois affichées (ex: l'hôpital et son arrêt de bus homonyme).
function rankAddressResults(data, here) {
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
function suggestionDistanceLabel(here, s) {
  if (!here) return null;
  const d = distanceKm(here, { lat: parseFloat(s.lat), lng: parseFloat(s.lon) });
  if (d == null) return null;
  return `${d < 10 ? d.toFixed(1) : Math.round(d)} km`;
}

// Adresses récemment sélectionnées (hôpitaux, cliniques habituels...) — stockées en local
// pour être proposées instantanément dès le focus du champ, avant même de taper.
const RECENT_ADDRESSES_KEY = "rp-recent-addresses";
const MAX_RECENT_ADDRESSES = 6;

function loadRecentAddresses() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_ADDRESSES_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    return [];
  }
}

function saveRecentAddress(entry) {
  const current = loadRecentAddresses();
  const next = [
    { ...entry, recent: true },
    ...current.filter((r) => r.address !== entry.address),
  ].slice(0, MAX_RECENT_ADDRESSES);
  try {
    localStorage.setItem(RECENT_ADDRESSES_KEY, JSON.stringify(next));
  } catch (e) {
    // Stockage indisponible (navigation privée...) : tant pis, pas bloquant.
  }
  return next;
}

function distanceKm(a, b) {
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
async function fetchRoadDistanceKm(from, to) {
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

// Ouvre un PDF stocké en base64 de façon fiable sur mobile — un lien <a href
// download> sur une "data URL" est souvent ignoré silencieusement par Safari
// iOS. On passe par un Blob, que le navigateur sait afficher/télécharger
// correctement dans un nouvel onglet.
async function openPdfDocument(dataUrl, filename) {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const win = window.open(blobUrl, "_blank");
    if (!win) {
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename || "bon-transport.pdf";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  } catch (e) {
    window.open(dataUrl, "_blank");
  }
}

function ridePickupCoords(r) {
  if (r.departLat != null && r.departLng != null) return { lat: r.departLat, lng: r.departLng };
  if (r.lat != null && r.lng != null) return { lat: r.lat, lng: r.lng };
  return null;
}

// Liens d'itinéraire gratuits (aucune clé API nécessaire) — ouvrent l'appli
// installée sur le téléphone si elle existe, sinon la version web.
function wazeUrl(lat, lng, address) {
  if (lat != null && lng != null) return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
  return `https://waze.com/ul?q=${encodeURIComponent(address || "")}&navigate=yes`;
}
function googleMapsUrl(lat, lng, address) {
  if (lat != null && lng != null) return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address || "")}`;
}

// Calcule le tarif "Taxi conventionné" selon la convention nationale 2025
// (page tarifs officielle fournie par l'utilisateur). Approximation basée sur
// la distance à vol d'oiseau entre départ et arrivée (pas la distance
// routière réelle, généralement un peu plus longue) — à vérifier avant de facturer.
// Ordre officiel : le tarif km (majoré si retour à vide) s'ajoute au forfait PEC
// et au forfait grande ville, puis la majoration nuit/weekend/férié s'applique
// sur l'ensemble ; le supplément TPMR s'ajoute en tout dernier (hors majoration).
function computeTaxiConventionneTarif({ distKm, allerRetour, kmRate, grandeVille, majoration, retourAVide, tpmr }) {
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
function autoDetectNightWeekend(heureStr) {
  if (!heureStr) return false;
  const [h] = heureStr.split(":").map(Number);
  if (Number.isNaN(h)) return false;
  const day = new Date().getDay(); // 0 = dimanche, 6 = samedi
  const isNight = h >= 20 || h < 8;
  const isWeekend = day === 0 || (day === 6 && h >= 12);
  return isNight || isWeekend;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authDisplayName, setAuthDisplayName] = useState("");
  const [authLicense, setAuthLicense] = useState("");
  const [authCommune, setAuthCommune] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const driverName = user?.displayName || "";
  const [rides, setRides] = useState([]);
  const [positions, setPositions] = useState({});
  const [profiles, setProfiles] = useState({});
  const [phoneInput, setPhoneInput] = useState("");
  const [chatRideId, setChatRideId] = useState(null);
  const [allMyMessages, setAllMyMessages] = useState([]);
  const [showMessagesPanel, setShowMessagesPanel] = useState(false);
  const [lastReadByRide, setLastReadByRide] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("rp-last-read") || "{}");
    } catch (e) {
      return {};
    }
  });
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const chatEndRef = useRef(null);
  const [showAccountPanel, setShowAccountPanel] = useState(false);

  const markRideRead = (rideId) => {
    setLastReadByRide((prev) => {
      const next = { ...prev, [rideId]: Date.now() };
      localStorage.setItem("rp-last-read", JSON.stringify(next));
      return next;
    });
  };

  useEffect(() => {
    if (showAccountPanel && profiles[driverName]) {
      const p = profiles[driverName];
      setCommuneInput(p.commune || "");
      setLicenseInput(p.licenseNumber || "");
      setCompanyInput({
        companyName: p.companyName || "",
        siret: p.siret || "",
        companyAddress: p.companyAddress || "",
      });
    }
  }, [showAccountPanel, driverName, profiles]);

  useEffect(() => {
    if (!chatRideId) return;
    const unsub = listenMessages(chatRideId, setChatMessages);
    markRideRead(chatRideId);
    return () => unsub();
  }, [chatRideId]);

  // Continue à marquer comme lu tant que la conversation reste ouverte à l'écran.
  useEffect(() => {
    if (chatRideId && chatMessages.length > 0) markRideRead(chatRideId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages, chatRideId]);

  useEffect(() => {
    if (chatRideId) chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, chatRideId]);

  const handleSendMessage = async () => {
    if (!chatInput.trim() || !chatRideId) return;
    try {
      await sendMessage(chatRideId, driverName, chatInput.trim());
      setChatInput("");
    } catch (e) {
      setError("Échec de l'envoi du message.");
    }
  };
  const [myPosStatus, setMyPosStatus] = useState("idle");
  const [filter, setFilter] = useState("dispo");
  useEffect(() => {
    filterRef.current = filter;
    if (filter === "dispo") setNewRidesBadge(0);
  }, [filter]);
  const [dateFilter, setDateFilter] = useState("");
  const [radiusFilter, setRadiusFilter] = useState(() => localStorage.getItem("radius-filter") || "50");

  const updateRadiusFilter = (value) => {
    setRadiusFilter(value);
    localStorage.setItem("radius-filter", value);
  };
  const [showForm, setShowForm] = useState(false);
  const [showTarifOptions, setShowTarifOptions] = useState(false);
  const [showMoreDetails, setShowMoreDetails] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState("");
  const [, setTick] = useState(0);
  const [selectedRide, setSelectedRide] = useState(null);
  const [accountSubPanel, setAccountSubPanel] = useState(null); // null | "profile" | "settings" | "company"
  const [newEmailInput, setNewEmailInput] = useState("");
  const [emailChangeStatus, setEmailChangeStatus] = useState(null); // null | { ok, text }
  const [communeInput, setCommuneInput] = useState("");
  const [licenseInput, setLicenseInput] = useState("");
  const [licenseChangeStatus, setLicenseChangeStatus] = useState(null); // null | { ok, text }
  const [companyInput, setCompanyInput] = useState({ companyName: "", siret: "", companyAddress: "" });
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [showQuickMenu, setShowQuickMenu] = useState(false);
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [newRidesBadge, setNewRidesBadge] = useState(0);
  const filterRef = useRef("dispo");
  const [showCalendarMenu, setShowCalendarMenu] = useState(false);
  const [banTarget, setBanTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [banReason, setBanReason] = useState("");
  const [bannedNotice, setBannedNotice] = useState(false);
  const isAdmin = user?.email === ADMIN_EMAIL;
  const [pulling, setPulling] = useState(false);
  const pullStartY = useRef(null);

  useEffect(() => {
    const PULL_THRESHOLD = 70;

    const onTouchStart = (e) => {
      if (window.scrollY <= 0) {
        pullStartY.current = e.touches[0].clientY;
      } else {
        pullStartY.current = null;
      }
    };
    const onTouchMove = (e) => {
      if (pullStartY.current == null) return;
      const delta = e.touches[0].clientY - pullStartY.current;
      setPulling(delta > PULL_THRESHOLD);
    };
    const onTouchEnd = () => {
      if (pulling) {
        window.location.reload();
      }
      pullStartY.current = null;
      setPulling(false);
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [pulling]);
  const [notifPermission, setNotifPermission] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported"
  );

  useEffect(() => {
    if (driverName && notifPermission === "granted") {
      registerFcmToken(driverName);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driverName]);

  const handleEmailChange = async () => {
    if (!newEmailInput.trim()) return;
    setEmailChangeStatus(null);
    try {
      await requestEmailChange(newEmailInput.trim());
      setEmailChangeStatus({ ok: true, text: "Email de confirmation envoyé à " + newEmailInput.trim() + " — clique sur le lien reçu pour valider le changement." });
      setNewEmailInput("");
    } catch (e) {
      setEmailChangeStatus({
        ok: false,
        text: e.code === "auth/requires-recent-login"
          ? "Pour ta sécurité, reconnecte-toi (déconnexion puis reconnexion) avant de changer d'email."
          : "Échec de l'envoi — vérifie l'adresse et réessaie.",
      });
    }
  };

  const handleLicenseChange = async () => {
    if (!licenseInput.trim()) return;
    setLicenseChangeStatus(null);
    try {
      await changeDriverLicense(driverName, profiles[driverName]?.licenseNumber || "", licenseInput.trim(), communeInput.trim());
      setLicenseChangeStatus({ ok: true, text: "Numéro de licence mis à jour." });
    } catch (e) {
      setLicenseChangeStatus({
        ok: false,
        text: e.message === "license_taken"
          ? "Ce numéro de licence est déjà associé à un autre compte."
          : "Échec de la mise à jour.",
      });
    }
  };

  const requestNotifPermission = async () => {
    if (typeof Notification === "undefined") return;
    const perm = await Notification.requestPermission();
    setNotifPermission(perm);
    if (perm === "granted" && driverName) {
      registerFcmToken(driverName);
    }
  };

  const [driverDept, setDriverDept] = useState(() => {
    return localStorage.getItem("taxi-department") || DEFAULT_DEPARTMENT;
  });
  const kmRate = DEPARTMENT_KM_RATES.find(([code]) => code === driverDept)?.[2] || DEFAULT_KM_RATE;

  const updateDriverDept = (code) => {
    setDriverDept(code);
    localStorage.setItem("taxi-department", code);
  };
  const [departSuggestions, setDepartSuggestions] = useState([]);
  const [arriveeSuggestions, setArriveeSuggestions] = useState([]);
  const [searchingAddress, setSearchingAddress] = useState(false);
  const [activeField, setActiveField] = useState(null);
  const [recentAddresses, setRecentAddresses] = useState(loadRecentAddresses);
  const [suggestionActiveIndex, setSuggestionActiveIndex] = useState(-1);
  const debounceRef = useRef(null);
  const debounceRefArrivee = useRef(null);
  const photoInputRef = useRef(null);
  const documentInputRef = useRef(null);
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const mapMarkersRef = useRef({});
  const mapMarkerStatusRef = useRef({}); // name -> "busy"/"free" déjà affiché, pour éviter de recréer l'icône inutilement
  const [editingId, setEditingId] = useState(null);
  // À l'ouverture d'une course existante en modification, le formulaire se remplit avec ses
  // valeurs déjà enregistrées (adresses, majorations...) — ce remplissage déclenche les mêmes
  // effets que si le chauffeur les avait modifiées, et recalculerait donc le tarif pour rien
  // (ou pire, écraserait un tarif corrigé à la main). On saute ce tout premier recalcul, mais
  // pas les suivants : si le chauffeur change ensuite l'adresse, le trajet ou une majoration,
  // le tarif doit bien se remettre à jour.
  const skipNextTarifRecalc = useRef(false);
  const skipNextMajorationAuto = useRef(false);
  const [plannedIds, setPlannedIds] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("planned-rides") || "[]"));
    } catch (e) {
      return new Set();
    }
  });

  const togglePlanning = (id) => {
    setPlannedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem("planned-rides", JSON.stringify([...next]));
      return next;
    });
  };
  const knownRideIds = useRef(new Map()); // id -> dernier statut connu
  // L'écouteur Firestore est monté une seule fois : il ne "voit" pas les mises à
  // jour d'état React. On garde donc les positions dans un ref pour pouvoir
  // calculer la priorité au moment exact où une course arrive.
  const positionsRef = useRef(positions);
  const [priorityAlert, setPriorityAlert] = useState(null); // { ride, shared }
  const knownMessageIds = useRef(new Set());
  const firstMessagesLoad = useRef(true);
  const knownProfileNames = useRef(new Set());
  const firstProfilesLoad = useRef(true);
  const firstLoad = useRef(true);

  // Zone privilégiée pour les résultats (Alsace : Strasbourg, Haguenau, Colmar, Mulhouse…)
  // — la recherche reste possible partout en France, mais les résultats de cette zone
  // remontent en priorité, ce qui accélère et fiabilise la recherche au quotidien.
  const ALSACE_VIEWBOX = "6.8,49.1,8.3,47.4"; // gauche,haut,droite,bas

  const searchAddress = (query, setSuggestions, ref = debounceRef) => {
    clearTimeout(ref.current);
    if (query.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    // Si le chauffeur est "en service" (position connue), on cherche en priorité
    // autour de lui plutôt qu'autour d'une zone fixe — plus pertinent au quotidien.
    const here = positions[driverName] || null;
    const viewbox = here
      ? `${here.lng - 0.6},${here.lat + 0.6},${here.lng + 0.6},${here.lat - 0.6}`
      : ALSACE_VIEWBOX;
    ref.current = setTimeout(async () => {
      setSearchingAddress(true);
      try {
        // Deux sources combinées : la Base Adresse Nationale (service public français)
        // tolère bien mieux les fautes de frappe sur les adresses de rue, tandis que
        // Nominatim/OSM connaît les lieux nommés (hôpitaux, cliniques, pharmacies...)
        // que la BAN ignore. On les interroge en parallèle et on fusionne le résultat.
        // namedetails=1 fait remonter le nom des lieux en plus de l'adresse brute ;
        // dedupe=1 évite les doublons du même lieu côté Nominatim.
        const [banResults, nominatimResults] = await Promise.all([
          fetchBanSuggestions(query, here).catch(() => []),
          fetch(
            `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&namedetails=1&dedupe=1&countrycodes=fr&limit=8&viewbox=${viewbox}&bounded=0&q=${encodeURIComponent(query)}`
          )
            .then((res) => res.json())
            .catch(() => []),
        ]);
        setSuggestions(rankAddressResults(interleaveResults(banResults, nominatimResults), here));
      } catch (e) {
        setSuggestions([]);
      } finally {
        setSearchingAddress(false);
      }
    }, 200);
  };

  // Source de suggestions active pour un champ : les adresses récentes tant que la saisie
  // est trop courte pour interroger le service, sinon les résultats de recherche en direct.
  const suggestionListFor = (field) => {
    const value = field === "depart" ? form.depart : form.arrivee;
    if (value.trim().length < 3) return recentAddresses;
    return field === "depart" ? departSuggestions : arriveeSuggestions;
  };

  const pickAddressSuggestion = (field, item) => {
    const address = item.recent ? item.address : shortAddress(item);
    const lat = item.recent ? item.lat : parseFloat(item.lat);
    const lng = item.recent ? item.lng : parseFloat(item.lon);
    if (field === "depart") {
      setForm({ ...form, depart: address, departLat: lat, departLng: lng });
      setDepartSuggestions([]);
    } else {
      setForm({ ...form, arrivee: address, arriveeLat: lat, arriveeLng: lng });
      setArriveeSuggestions([]);
    }
    setActiveField(null);
    setSuggestionActiveIndex(-1);
    setRecentAddresses(saveRecentAddress({ address, lat, lng }));
  };

  // Navigation clavier (↑/↓/Entrée/Échap) dans la liste de suggestions, pour choisir
  // une adresse sans quitter le clavier — plus rapide que de viser au doigt sur mobile.
  const handleAddressKeyDown = (field, e) => {
    if (activeField !== field) return;
    const list = suggestionListFor(field);
    if (list.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSuggestionActiveIndex((i) => Math.min(i + 1, list.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSuggestionActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && suggestionActiveIndex >= 0) {
      e.preventDefault();
      pickAddressSuggestion(field, list[suggestionActiveIndex]);
    } else if (e.key === "Escape") {
      setActiveField(null);
    }
  };

  useEffect(() => {
    const unsub = watchAuthState((u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return () => unsub();
  }, []);

  const handleSignUp = async (e) => {
    e.preventDefault();
    setAuthError("");
    if (!authDisplayName.trim()) {
      setAuthError("Indique ton nom ou pseudo.");
      return;
    }
    if (!authLicense.trim()) {
      setAuthError("Le numéro de licence est obligatoire.");
      return;
    }
    if (!authCommune.trim()) {
      setAuthError("La commune de rattachement est obligatoire.");
      return;
    }
    if (authPassword.length < 6) {
      setAuthError("Le mot de passe doit faire au moins 6 caractères.");
      return;
    }
    setAuthBusy(true);
    try {
      await signUp(authEmail.trim(), authPassword, authDisplayName.trim(), authLicense.trim(), authCommune.trim());
    } catch (err) {
      setAuthError(
        err.message === "license_taken" ? "Ce numéro de licence est déjà associé à un autre compte." :
        err.code === "auth/email-already-in-use" ? "Cet email a déjà un compte — connecte-toi plutôt." :
        err.code === "auth/invalid-email" ? "Adresse email invalide." :
        "Échec de l'inscription. Vérifie tes infos et réessaie."
      );
    }
    setAuthBusy(false);
  };

  const handleLogIn = async (e) => {
    e.preventDefault();
    setAuthError("");
    setAuthBusy(true);
    try {
      await logIn(authEmail.trim(), authPassword);
    } catch (err) {
      setAuthError("Email ou mot de passe incorrect.");
    }
    setAuthBusy(false);
  };

  const handleForgotPassword = async () => {
    setAuthError("");
    setResetSent(false);
    if (!authEmail.trim()) {
      setAuthError("Indique ton email pour recevoir le lien de réinitialisation.");
      return;
    }
    setAuthBusy(true);
    try {
      await requestPasswordReset(authEmail.trim());
    } catch (err) {
      // On ne distingue pas "compte inexistant" des autres cas dans le message
      // affiché, pour ne pas révéler si un email est associé à un compte.
      if (err.code === "auth/invalid-email") {
        setAuthError("Adresse email invalide.");
        setAuthBusy(false);
        return;
      }
      if (err.code !== "auth/user-not-found") {
        setAuthError("Échec de l'envoi. Réessaie plus tard.");
        setAuthBusy(false);
        return;
      }
    }
    setResetSent(true);
    setAuthBusy(false);
  };

  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("touchstart", unlock, { once: true });
    window.addEventListener("click", unlock, { once: true });
    return () => {
      window.removeEventListener("touchstart", unlock);
      window.removeEventListener("click", unlock);
    };
  }, []);

  useEffect(() => {
    const unsubRides = listenRides((newRides) => {
      if (!firstLoad.current) {
        newRides.forEach((r) => {
          const prevStatus = knownRideIds.current.get(r.id);
          const isNew = prevStatus === undefined;
          if (isNew && r.status === "disponible" && r.postedBy !== driverName) {
            playAlertSound(r.urgent);
            // Suis-je dans le groupe prioritaire sur cette course ?
            const prio = computePriorityDrivers(r, positionsRef.current);
            const iAmPriority = prio.some((d) => d.name === driverName);
            if (iAmPriority) {
              // Alerte plein écran, où que je sois dans l'appli : je ne suis pas
              // sorti de mon écran courant, la course s'affiche par-dessus.
              notifyPriorityRide(r, prio.length > 1);
              setPriorityAlert({ ride: r, shared: prio.length > 1 });
            } else {
              notifyNewRide(r);
            }
            if (filterRef.current !== "dispo") setNewRidesBadge((n) => n + 1);
          }
          if (!isNew && prevStatus !== r.status && r.postedBy === driverName) {
            notifyStatusChange(r, r.status);
          }
        });
      }
      knownRideIds.current = new Map(newRides.map((r) => [r.id, r.status]));
      firstLoad.current = false;
      setRides(newRides);
    });
    const unsubPos = listenPositions((newPositions) => {
      positionsRef.current = newPositions;
      setPositions(newPositions);
    });
    const unsubProfiles = listenProfiles((newProfiles) => {
      if (!firstProfilesLoad.current && isAdmin) {
        Object.keys(newProfiles).forEach((name) => {
          if (!knownProfileNames.current.has(name)) {
            playAlertSound(false);
            if (typeof Notification !== "undefined" && Notification.permission === "granted") {
              try {
                new Notification("🆕 Nouveau chauffeur inscrit", {
                  body: `${name} vient de créer un compte sur RoulePartner.`,
                  icon: "/icon-192.png",
                });
              } catch (e) {
                // ignore
              }
            }
          }
        });
      }
      knownProfileNames.current = new Set(Object.keys(newProfiles));
      firstProfilesLoad.current = false;
      setProfiles(newProfiles);
    });
    return () => {
      unsubRides();
      unsubPos();
      unsubProfiles();
    };
  }, [driverName]);

  // Liste des courses où je suis impliqué (posteur, preneur, ou en attente) —
  // sert à récupérer tous les messages qui me concernent, tous fils confondus.
  const myRideIdsKey = useMemo(() => {
    const ids = rides
      .filter((r) => r.postedBy === driverName || r.takenBy === driverName || r.pendingBy === driverName)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 30)
      .map((r) => r.id);
    return ids.join(",");
  }, [rides, driverName]);

  useEffect(() => {
    if (!driverName) return;
    const ids = myRideIdsKey ? myRideIdsKey.split(",") : [];
    if (ids.length === 0) {
      // Pas encore de course connue (ex: juste après connexion, avant que /rides
      // se charge) — on ne touche pas au suivi "premier chargement" tant qu'on
      // n'a pas de vraies données, sinon les prochains vrais messages seraient
      // à tort traités comme "nouveaux" et renotifiés même s'ils sont déjà lus.
      setAllMyMessages([]);
      return;
    }
    const unsub = listenMessagesForRides(ids, (msgs) => {
      if (!firstMessagesLoad.current) {
        msgs.forEach((m) => {
          if (!knownMessageIds.current.has(m.id) && m.senderName !== driverName) {
            notifyNewMessage(m.senderName, m.text);
          }
        });
      }
      msgs.forEach((m) => knownMessageIds.current.add(m.id));
      firstMessagesLoad.current = false;
      setAllMyMessages(msgs);
    });
    return () => unsub();
  }, [myRideIdsKey, driverName]);

  // Si l'admin bannit ce chauffeur, on le déconnecte immédiatement, même en pleine session.
  useEffect(() => {
    if (driverName && !isAdmin && profiles[driverName]?.banned) {
      setBannedNotice(true);
      logOut();
    }
  }, [profiles, driverName, isAdmin]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const ridesRef = useRef(rides);
  useEffect(() => {
    ridesRef.current = rides;
  }, [rides]);

  // Mesure partielle de protection des données : purge automatiquement les courses
  // terminées depuis plus de AUTO_PURGE_DAYS (photo et notes incluses). Ce n'est pas
  // une vraie purge serveur planifiée (ça demanderait un service payant), donc ça ne
  // se déclenche que si au moins un chauffeur a l'appli ouverte.
  useEffect(() => {
    const cutoff = Date.now() - AUTO_PURGE_DAYS * 24 * 60 * 60 * 1000;
    ridesRef.current.forEach((r) => {
      if (r.status === "terminee" && r.createdAt < cutoff) {
        deleteRide(r.id).catch(() => {});
      }
    });
  }, [rides]);

  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      ridesRef.current.forEach((r) => {
        if (r.status === "en_attente" && r.pendingSince && now - r.pendingSince > CLAIM_CONFIRM_WINDOW_MS) {
          confirmClaim(r);
        }
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Ferme l'alerte prioritaire quand la fenêtre de 15 s est écoulée, ou dès
  // qu'un autre chauffeur a pris la course entre-temps.
  useEffect(() => {
    if (!priorityAlert) return;
    const check = () => {
      const current = ridesRef.current.find((x) => x.id === priorityAlert.ride.id);
      const expired = Date.now() - priorityAlert.ride.createdAt >= PRIORITY_WINDOW_MS;
      if (expired || !current || current.status !== "disponible") {
        setPriorityAlert(null);
      }
    };
    check();
    const id = setInterval(check, 500);
    return () => clearInterval(id);
  }, [priorityAlert, rides]);

  const watchIdRef = useRef(null);

  const sharePosition = () => {
    // Si le suivi est déjà actif, ce clic l'arrête (et retire le point de la carte).
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
      setMyPosStatus("idle");
      localStorage.setItem("rp-sharing-enabled", "0");
      clearDriverPosition(driverName).catch(() => {});
      return;
    }
    if (!navigator.geolocation) {
      setMyPosStatus("denied");
      return;
    }
    setMyPosStatus("locating");
    watchIdRef.current = navigator.geolocation.watchPosition(
      async (pos) => {
        const coords = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          updatedAt: Date.now(),
        };
        setMyPosStatus("ok");
        localStorage.setItem("rp-sharing-enabled", "1");
        try {
          await setDriverPosition(driverName, coords);
        } catch (e) {
          setError("Position récupérée mais non partagée (vérifie ta config Firebase).");
        }
      },
      () => setMyPosStatus("denied"),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
  };

  // Si le chauffeur était "en service" avant de fermer complètement l'appli
  // (balayage pour quitter), on réactive automatiquement le partage au
  // prochain lancement — plus besoin de retaper le bouton à chaque fois.
  const autoResumedSharingRef = useRef(false);
  useEffect(() => {
    if (!driverName || autoResumedSharingRef.current) return;
    if (localStorage.getItem("rp-sharing-enabled") === "1") {
      autoResumedSharingRef.current = true;
      sharePosition();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driverName]);

  // Coupe le suivi GPS si la page se ferme, pour ne pas laisser le capteur tourner inutilement.
  useEffect(() => {
    return () => {
      if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current);
    };
  }, []);

  const handlePost = async (e) => {
    e.preventDefault();
    if (!form.depart || !form.arrivee || !form.heure) return;
    const myPos = positions[driverName] || null;
    try {
      if (editingId) {
        await updateRide(editingId, { ...form });
      } else {
        const newRide = {
          id: uid(),
          ...form,
          postedBy: driverName,
          status: "disponible",
          takenBy: null,
          createdAt: Date.now(),
          lat: myPos ? myPos.lat : null,
          lng: myPos ? myPos.lng : null,
        };
        await addRide(newRide);
      }
      setForm(emptyForm);
      setEditingId(null);
      setShowForm(false);
    } catch (e) {
      setError("Échec de l'enregistrement (vérifie ta config Firebase).");
    }
  };

  const swapDepartArrivee = () => {
    setForm((f) => ({
      ...f,
      depart: f.arrivee,
      arrivee: f.depart,
      departLat: f.arriveeLat,
      departLng: f.arriveeLng,
      arriveeLat: f.departLat,
      arriveeLng: f.departLng,
    }));
  };

  // Coche/décoche automatiquement "Nuit/dimanche/férié" dès que l'heure change,
  // selon la règle de la convention. Le chauffeur peut toujours corriger à la main
  // ensuite (par exemple pour un jour férié, qu'on ne peut pas détecter tout seul).
  useEffect(() => {
    if (form.type !== "taxi") return;
    if (skipNextMajorationAuto.current) {
      skipNextMajorationAuto.current = false;
      return;
    }
    const auto = autoDetectNightWeekend(form.heure);
    setForm((f) => (f.majorationNuitWeekend === auto ? f : { ...f, majorationNuitWeekend: auto }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.heure, form.type]);

  // Recalcule automatiquement le tarif "Taxi conventionné" dès que la distance,
  // le trajet ou les majorations changent — plus besoin de cliquer sur un bouton.
  // Essaie d'abord la vraie distance routière (OSRM), retombe sur le vol d'oiseau
  // si le service externe ne répond pas.
  const [calculatingTarif, setCalculatingTarif] = useState(false);
  useEffect(() => {
    if (form.type !== "taxi") return;
    if (skipNextTarifRecalc.current) {
      skipNextTarifRecalc.current = false;
      return;
    }
    const depart = { lat: form.departLat, lng: form.departLng };
    const arrivee = { lat: form.arriveeLat, lng: form.arriveeLng };
    if (depart.lat == null || arrivee.lat == null) return;
    let cancelled = false;
    setCalculatingTarif(true);
    (async () => {
      let distKm = await fetchRoadDistanceKm(depart, arrivee);
      let isRoadDistance = true;
      if (distKm == null) {
        distKm = distanceKm(depart, arrivee);
        isRoadDistance = false;
      }
      if (cancelled || distKm == null) {
        setCalculatingTarif(false);
        return;
      }
      const computed = computeTaxiConventionneTarif({
        distKm,
        allerRetour: form.trajet === "allerRetour",
        kmRate,
        grandeVille: form.grandeVille,
        majoration: form.majorationNuitWeekend,
        retourAVide: form.retourAVide,
        tpmr: form.tpmr,
      });
      setForm((f) => ({
        ...f,
        tarif: String(computed),
        calcDistanceKm: Math.round(distKm * 10) / 10,
        calcIsRoadDistance: isRoadDistance,
      }));
      setCalculatingTarif(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    form.type, form.trajet, form.departLat, form.departLng,
    form.arriveeLat, form.arriveeLng, form.grandeVille, form.majorationNuitWeekend,
    form.retourAVide, form.tpmr, kmRate,
  ]);

  const handlePhotoChange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await compressPhoto(file);
      setForm((f) => ({ ...f, photo: dataUrl }));
      setError("");
    } catch (err) {
      setError("Photo trop lourde ou illisible, essaie une autre image.");
    }
  };

  const MAX_PDF_SIZE = 600 * 1024; // 600 Ko — au-delà, ça ne tient plus dans un document Firestore
  const handleDocumentChange = (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (file.type !== "application/pdf") {
      setError("Seuls les fichiers PDF sont acceptés pour le bon de transport.");
      return;
    }
    if (file.size > MAX_PDF_SIZE) {
      setError("PDF trop volumineux (max ~600 Ko) — essaie de le compresser ou de le rescanner en plus léger.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setForm((f) => ({ ...f, document: reader.result, documentName: file.name }));
      setError("");
    };
    reader.onerror = () => setError("Échec de la lecture du PDF, réessaie.");
    reader.readAsDataURL(file);
  };

  const startEdit = (r) => {
    skipNextTarifRecalc.current = true;
    skipNextMajorationAuto.current = true;
    setForm({
      type: r.type, patient: r.patient, patientTel: r.patientTel || "", depart: r.depart, arrivee: r.arrivee,
      heure: r.heure, date: r.date || todayKey(0), trajet: r.trajet, tarif: r.tarif, urgent: r.urgent, tpmr: r.tpmr || false, notes: r.notes,
      departLat: r.departLat, departLng: r.departLng, arriveeLat: r.arriveeLat, arriveeLng: r.arriveeLng,
      grandeVille: r.grandeVille || false, majorationNuitWeekend: r.majorationNuitWeekend || false,
      retourAVide: r.retourAVide || false, calcDistanceKm: r.calcDistanceKm ?? null, calcIsRoadDistance: r.calcIsRoadDistance ?? false,
      photo: r.photo || null, document: r.document || null, documentName: r.documentName || "",
    });
    setEditingId(r.id);
    setShowForm(true);
    setSelectedRide(null);
  };

  const duplicateRide = (r) => {
    setForm({
      type: r.type, patient: r.patient, patientTel: r.patientTel || "", depart: r.depart, arrivee: r.arrivee,
      heure: "", date: todayKey(0), trajet: r.trajet, tarif: r.tarif, urgent: false, tpmr: r.tpmr || false, notes: r.notes,
      departLat: r.departLat, departLng: r.departLng, arriveeLat: r.arriveeLat, arriveeLng: r.arriveeLng,
      grandeVille: r.grandeVille || false, majorationNuitWeekend: r.majorationNuitWeekend || false,
      retourAVide: r.retourAVide || false, calcDistanceKm: r.calcDistanceKm ?? null, calcIsRoadDistance: r.calcIsRoadDistance ?? false,
      photo: r.photo || null, document: r.document || null, documentName: r.documentName || "",
    });
    setEditingId(null);
    setShowForm(true);
    setSelectedRide(null);
  };

  // "Je la prends" ne prend plus la course directement : ça envoie une demande.
  // Le posteur a un délai pour confirmer, sinon c'est validé automatiquement.
  // Plusieurs chauffeurs prioritaires peuvent taper en même temps : la
  // transaction côté Firestore n'en laisse passer qu'un seul, les autres
  // reçoivent "already_taken" et sont prévenus proprement.
  const claim = async (id) => {
    try {
      await claimRide(id, driverName);
    } catch (e) {
      if (e.message === "already_taken") {
        setError("Trop tard — un autre chauffeur vient de prendre cette course.");
        setSelectedRide(null);
      } else if (e.message === "ride_gone") {
        setError("Cette course n'existe plus.");
        setSelectedRide(null);
      } else {
        setError("Échec de l'action.");
      }
    }
  };

  const confirmClaim = async (ride) => {
    try {
      await updateRide(ride.id, { status: "prise", takenBy: ride.pendingBy, pendingBy: null, pendingSince: null });
    } catch (e) {
      setError("Échec de l'action.");
    }
  };

  const refuseClaim = async (id) => {
    try {
      await updateRide(id, { status: "disponible", pendingBy: null, pendingSince: null });
    } catch (e) {
      setError("Échec de l'action.");
    }
  };

  const cancelMyClaim = async (id) => {
    try {
      await updateRide(id, { status: "disponible", pendingBy: null, pendingSince: null });
    } catch (e) {
      setError("Échec de l'action.");
    }
  };

  const startRide = async (id) => {
    try {
      await updateRide(id, { status: "en_cours", startedAt: Date.now() });
    } catch (e) {
      setError("Échec de l'action.");
    }
  };

  const markDone = async (id) => {
    try {
      await updateRide(id, { status: "terminee" });
    } catch (e) {
      setError("Échec de l'action.");
    }
  };

  // Ne garde que les chauffeurs ayant partagé leur position récemment (15 min) —
  // si un chauffeur arrête de partager ou ferme l'appli, il disparaît de la carte.
  const MAP_STALE_MS = 15 * 60 * 1000;
  const myPosForMap = positions[driverName] || null;
  const busyDriverNames = new Set(
    rides.filter((r) => r.status === "en_cours" && r.takenBy).map((r) => r.takenBy)
  );
  const mapDrivers = Object.entries(positions).filter(([name, pos]) => {
    if (!pos.updatedAt || Date.now() - pos.updatedAt >= MAP_STALE_MS) return false;
    if (radiusFilter === "all" || !myPosForMap || name === driverName) return true;
    const d = distanceKm(myPosForMap, pos);
    return d == null || d <= parseFloat(radiusFilter);
  });

  useEffect(() => {
    if (filter !== "carte" || !mapContainerRef.current) return;

    if (!mapInstanceRef.current) {
      const center = mapDrivers.length > 0
        ? [mapDrivers[0][1].lat, mapDrivers[0][1].lng]
        : [48.5734, 7.7521]; // Strasbourg par défaut
      const map = L.map(mapContainerRef.current, { zoomControl: false }).setView(center, 11);
      L.control.zoom({ position: "bottomright" }).addTo(map);
      // Style "Voyager" (CARTO) — clé gratuite (jusqu'à 5 millions de requêtes/mois),
      // plus détaillé et lisible que le rendu OpenStreetMap classique.
      L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=cb1_28sf_1_983cff967a2309e37d83fc04", {
        attribution: "© OpenStreetMap contributors © CARTO",
        maxZoom: 19,
      }).addTo(map);
      mapInstanceRef.current = map;
      // Leaflet a besoin d'un recalcul de taille une fois le conteneur bien affiché.
      setTimeout(() => map.invalidateSize(), 200);
    }

    const map = mapInstanceRef.current;
    const currentNames = new Set(mapDrivers.map(([name]) => name));

    // Retire les marqueurs des chauffeurs qui ne sont plus visibles
    Object.keys(mapMarkersRef.current).forEach((name) => {
      if (!currentNames.has(name)) {
        map.removeLayer(mapMarkersRef.current[name]);
        delete mapMarkersRef.current[name];
        delete mapMarkerStatusRef.current[name];
      }
    });

    // Ajoute ou déplace les marqueurs des chauffeurs visibles
    mapDrivers.forEach(([name, pos]) => {
      const isMe = name === driverName;
      const isBusy = busyDriverNames.has(name);
      const statusKey = `${isMe ? "me" : "other"}-${isBusy ? "busy" : "free"}`;
      if (mapMarkersRef.current[name]) {
        mapMarkersRef.current[name].setLatLng([pos.lat, pos.lng]);
        // On ne touche à l'icône que si le statut a vraiment changé — la
        // recréer à chaque mise à jour de position perturbait le zoom sur la carte.
        if (mapMarkerStatusRef.current[name] !== statusKey) {
          const carBg = isMe ? "#FFB43A" : "#23272E";
          const statusColor = isBusy ? "#E5484D" : "#3BD07A";
          mapMarkersRef.current[name].setIcon(L.divIcon({
            className: "",
            html: `
              <div style="position:relative;width:34px;height:34px;">
                <div style="background:${carBg};width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;border:2px solid #0F1114;box-shadow:0 2px 6px rgba(0,0,0,0.4);">🚗</div>
                <span style="position:absolute;top:-2px;right:-2px;width:13px;height:13px;border-radius:50%;background:${statusColor};border:2px solid #0F1114;"></span>
              </div>
            `,
            iconSize: [34, 34],
            iconAnchor: [17, 17],
          }));
          mapMarkerStatusRef.current[name] = statusKey;
        }
      } else {
        const carBg = isMe ? "#FFB43A" : "#23272E";
        const statusColor = isBusy ? "#E5484D" : "#3BD07A";
        const icon = L.divIcon({
          className: "",
          html: `
            <div style="position:relative;width:34px;height:34px;">
              <div style="background:${carBg};width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;border:2px solid #0F1114;box-shadow:0 2px 6px rgba(0,0,0,0.4);">🚗</div>
              <span style="position:absolute;top:-2px;right:-2px;width:13px;height:13px;border-radius:50%;background:${statusColor};border:2px solid #0F1114;"></span>
            </div>
          `,
          iconSize: [34, 34],
          iconAnchor: [17, 17],
        });
        const marker = L.marker([pos.lat, pos.lng], { icon }).addTo(map);
        marker.bindPopup(`<strong>${name}${isMe ? " (toi)" : ""}</strong>${isBusy ? " — 🔴 en course" : " — 🟢 libre"}`);
        mapMarkersRef.current[name] = marker;
        mapMarkerStatusRef.current[name] = statusKey;
      }
    });
  }, [filter, positions, driverName, rides]);

  // Nettoie la carte quand on quitte l'onglet, pour éviter les doublons au retour.
  useEffect(() => {
    if (filter !== "carte" && mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
      mapMarkersRef.current = {};
    }
  }, [filter]);

  const release = async (id) => {
    try {
      await updateRide(id, { status: "disponible", takenBy: null });
    } catch (e) {
      setError("Échec de l'action.");
    }
  };

  const remove = async (id) => {
    try {
      await deleteRide(id);
    } catch (e) {
      setError("Échec de la suppression.");
    }
  };

  // Renvoie la liste des chauffeurs prioritaires sur une course, triés du plus
  // proche au plus loin. En général c'est un seul chauffeur (le plus proche),
  // mais si d'autres sont pratiquement à la même distance (< PRIORITY_TIE_KM
  // d'écart), ils sont tous prioritaires en même temps et c'est le premier qui
  // accepte qui l'emporte — la transaction Firestore garantit qu'un seul gagne.
  const priorityDriversFor = (ride) => computePriorityDrivers(ride, positions);

  const myPos = positions[driverName] || null;

  // Regroupe tous les messages par course pour construire la liste des
  // conversations (dernier message, interlocuteur, nombre de non-lus).
  const conversations = useMemo(() => {
    const byRide = {};
    allMyMessages.forEach((m) => {
      if (!byRide[m.rideId]) byRide[m.rideId] = [];
      byRide[m.rideId].push(m);
    });
    return Object.entries(byRide)
      .map(([rideId, msgs]) => {
        const ride = rides.find((r) => r.id === rideId);
        const last = msgs[msgs.length - 1];
        const lastRead = lastReadByRide[rideId] || 0;
        const unread = msgs.filter((m) => m.senderName !== driverName && m.createdAt > lastRead).length;
        const otherParty = ride
          ? (ride.postedBy === driverName ? ride.takenBy || ride.pendingBy : ride.postedBy)
          : "?";
        return { rideId, ride, last, unread, otherParty };
      })
      .filter((c) => c.last)
      .sort((a, b) => b.last.createdAt - a.last.createdAt);
  }, [allMyMessages, rides, lastReadByRide, driverName]);

  const totalUnreadMessages = conversations.reduce((sum, c) => sum + c.unread, 0);

  // Certains comptes créés avant l'ajout de la création automatique de profil
  // n'ont pas de fiche dans /profiles — on les retrouve quand même via les
  // courses postées/prises ou une position déjà partagée, pour que
  // l'administration les voie tous, même les plus anciens.
  const allKnownDriverNames = Array.from(new Set([
    ...Object.keys(profiles),
    ...Object.keys(positions),
    ...rides.map((r) => r.postedBy).filter(Boolean),
    ...rides.map((r) => r.takenBy).filter(Boolean),
  ]));

  const myTakenRides = rides
    .filter((r) => r.takenBy === driverName)
    .filter((r) => !dateFilter || dateKey(r.createdAt) === dateFilter);
  const myEarnings = myTakenRides.reduce((sum, r) => sum + (parseFloat(String(r.tarif).replace(",", ".")) || 0), 0);

  const earningsLabel =
    dateFilter === todayKey(0) ? "aujourd'hui" :
    dateFilter === todayKey(-1) ? "hier" :
    dateFilter ? `le ${dateFilter.split("-").reverse().join("/")}` :
    "au total";

  // Vitesse moyenne estimée pour convertir une distance à vol d'oiseau en temps de trajet.
  // C'est une approximation (pas un vrai calcul d'itinéraire routier) — prévoir une marge.

  // Seules les courses ajoutées manuellement au planning apparaissent ici (aucun ajout automatique).
  const planningRides = rides
    .filter((r) => plannedIds.has(r.id))
    .slice()
    .sort((a, b) => a.heure.localeCompare(b.heure));

  const planningSteps = planningRides.map((r, i) => {
    const prev = planningRides[i - 1];
    let gapInfo = null;
    if (prev) {
      const [ph, pm] = prev.heure.split(":").map(Number);
      const [ch, cm] = r.heure.split(":").map(Number);
      const gapMin = (ch * 60 + cm) - (ph * 60 + pm);
      const hasCoords = prev.arriveeLat != null && r.departLat != null;
      const distKm = hasCoords
        ? distanceKm({ lat: prev.arriveeLat, lng: prev.arriveeLng }, { lat: r.departLat, lng: r.departLng })
        : null;
      const travelMin = distKm != null ? (distKm / AVG_SPEED_KMH) * 60 : null;
      gapInfo = {
        gapMin,
        distKm,
        travelMin,
        tight: travelMin != null ? travelMin > gapMin - 5 : null,
      };
    }
    return { ride: r, gapInfo };
  });

  const visibleRides = rides
    .filter((r) => {
      if (dateFilter === "week") {
        const { start, end } = thisWeekRange();
        const d = r.date || dateKey(r.createdAt);
        if (d < start || d > end) return false;
      } else if (dateFilter && (r.date || dateKey(r.createdAt)) !== dateFilter) {
        return false;
      }
      if (filter === "dispo") return r.status === "disponible";
      if (filter === "mine") return r.postedBy === driverName || r.takenBy === driverName || r.pendingBy === driverName;
      if (filter === "recues") return r.takenBy === driverName && r.postedBy !== driverName;
      if (filter === "historique") return r.status === "terminee";
      return true;
    })
    .map((r) => ({ ...r, _dist: myPos ? distanceKm(myPos, ridePickupCoords(r)) : null }))
    .filter((r) => {
      // Le rayon ne s'applique qu'aux vues "Disponibles"/"Toutes" — tes propres
      // courses (Mes courses/Historique) restent visibles quelle que soit la distance.
      if ((filter !== "dispo" && filter !== "toutes") || radiusFilter === "all") return true;
      if (!myPos || r._dist == null) return true; // pas de position = pas filtré, pour ne rien cacher par erreur
      return r._dist <= parseFloat(radiusFilter);
    })
    .sort((a, b) => {
      if (a._dist != null && b._dist != null) return a._dist - b._dist;
      if (a._dist != null) return -1;
      if (b._dist != null) return 1;
      return b.createdAt - a.createdAt;
    });

  if (authLoading) {
    return (
      <div style={styles.page}>
        <div style={styles.gateCard}>
          <div style={styles.logoBadgeLarge}>
            <Car size={30} color="#1A1206" />
            <span style={styles.logoBeaconLarge} />
          </div>
          <h1 style={styles.gateTitle}>RoulePartner</h1>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div style={styles.page}>
        <div style={styles.gateCard}>
          <div style={styles.logoBadgeLarge}>
            <Car size={30} color="#1A1206" />
            <span style={styles.logoBeaconLarge} />
          </div>
          <h1 style={styles.gateTitle}>RoulePartner</h1>
          {bannedNotice ? (
            <p style={{ ...styles.gateSub, color: "#E5484D" }}>
              Ton compte a été suspendu par l'administrateur. Contacte-le si tu penses que c'est une erreur.
            </p>
          ) : (
          <p style={styles.gateSub}>
            Le tableau de bord partagé entre chauffeurs pour redistribuer les
            courses — fini les groupes WhatsApp.
          </p>
          )}

          <div style={{ display: "flex", gap: 8, margin: "20px 0 4px" }}>
            <button
              type="button"
              onClick={() => { setAuthMode("login"); setAuthError(""); setResetSent(false); }}
              style={{ ...styles.tab, flex: 1, ...(authMode === "login" ? styles.tabActive : {}) }}
            >
              Connexion
            </button>
            <button
              type="button"
              onClick={() => { setAuthMode("signup"); setAuthError(""); setResetSent(false); }}
              style={{ ...styles.tab, flex: 1, ...(authMode === "signup" ? styles.tabActive : {}) }}
            >
              Créer un compte
            </button>
          </div>

          <form
            onSubmit={authMode === "signup" ? handleSignUp : handleLogIn}
            style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}
          >
            {authMode === "signup" && (
              <>
                <input
                  value={authDisplayName}
                  onChange={(e) => setAuthDisplayName(e.target.value)}
                  placeholder="Ton nom ou pseudo"
                  style={styles.input}
                  required
                />
                <input
                  value={authLicense}
                  onChange={(e) => setAuthLicense(e.target.value)}
                  placeholder="Numéro de licence taxi"
                  style={styles.input}
                  required
                />
                <input
                  value={authCommune}
                  onChange={(e) => setAuthCommune(e.target.value)}
                  placeholder="Commune de rattachement"
                  style={styles.input}
                  required
                />
              </>
            )}
            <input
              type="email"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
              placeholder="Adresse email"
              style={styles.input}
              required
              autoComplete="email"
            />
            <input
              type="password"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
              placeholder="Mot de passe (6 caractères min.)"
              style={styles.input}
              required
              autoComplete={authMode === "signup" ? "new-password" : "current-password"}
            />
            {authMode === "login" && (
              <button
                type="button"
                onClick={handleForgotPassword}
                disabled={authBusy}
                style={{ background: "none", border: "none", color: "#8A9099", fontSize: 12.5, textAlign: "right", cursor: "pointer", padding: 0, textDecoration: "underline" }}
              >
                Mot de passe oublié ?
              </button>
            )}
            {resetSent && (
              <span style={{ color: "#3BD07A", fontSize: 13 }}>
                Si un compte existe avec cet email, un lien de réinitialisation vient d'être envoyé.
              </span>
            )}
            {authError && <span style={{ color: "#E5484D", fontSize: 13 }}>{authError}</span>}
            <button type="submit" style={styles.btnPrimary} disabled={authBusy}>
              {authBusy ? "…" : authMode === "signup" ? "Créer mon compte" : "Se connecter"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (!user.emailVerified) {
    return (
      <div style={styles.page}>
        <div style={styles.gateCard}>
          <div style={styles.logoBadgeLarge}>
            <Car size={30} color="#1A1206" />
            <span style={styles.logoBeaconLarge} />
          </div>
          <h1 style={styles.gateTitle}>RoulePartner</h1>
          <p style={styles.gateSub}>
            Un email de confirmation a été envoyé à <strong>{user.email}</strong>. Clique sur le lien qu'il
            contient, puis reviens ici.
          </p>
          {authError && <p style={{ color: "#E5484D", fontSize: 13 }}>{authError}</p>}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 20 }}>
            <button
              type="button"
              style={styles.btnPrimary}
              onClick={async () => {
                setAuthError("");
                const refreshed = await reloadUser();
                if (refreshed && !refreshed.emailVerified) {
                  setAuthError("Toujours pas confirmé — vérifie ta boîte mail (et les spams).");
                }
                setUser(refreshed);
              }}
            >
              J'ai confirmé, actualiser
            </button>
            <button
              type="button"
              style={styles.btnGhost}
              onClick={async () => {
                setAuthError("");
                try {
                  await resendVerificationEmail();
                  setAuthError("Email renvoyé.");
                } catch (e) {
                  setAuthError("Échec de l'envoi, réessaie dans un instant.");
                }
              }}
            >
              Renvoyer l'email
            </button>
            <button type="button" style={styles.btnGhost} onClick={() => logOut()}>
              Se déconnecter
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <style>{`
        .rp-desktop-tabs { display: flex; }
        .rp-bottom-nav { display: none; }
        .rp-bottom-spacer { height: 0; }
        .rp-fab-floating { display: none !important; }
        @media (max-width: 720px) {
          .rp-desktop-tabs { display: none; }
          .rp-bottom-nav { display: flex; }
          .rp-bottom-spacer { height: 78px; }
          .rp-fab-floating { display: flex !important; }
        }
      `}</style>

      {/* Alerte course prioritaire — s'affiche par-dessus n'importe quel écran
          de l'appli (accueil, carte, messages, compte...) sans faire sortir le
          chauffeur de ce qu'il était en train de faire. */}
      {priorityAlert && (() => {
        const r = priorityAlert.ride;
        const meta = typeMeta(r.type);
        const secondsLeft = Math.max(
          0,
          Math.ceil((PRIORITY_WINDOW_MS - (Date.now() - r.createdAt)) / 1000)
        );
        const dist = myPos ? distanceKm(myPos, ridePickupCoords(r)) : null;
        return (
          <div style={styles.priorityAlertOverlay}>
            <div style={styles.priorityAlertCard}>
              <div style={styles.priorityAlertTop}>
                <span className="rp-beacon-pulse" style={styles.priorityAlertPill}>
                  COURSE PRIORITAIRE
                </span>
                <span className="rp-meter" style={{ fontSize: 26 }}>{secondsLeft}s</span>
              </div>

              <p style={styles.priorityAlertSub}>
                {priorityAlert.shared
                  ? "Tu fais partie des chauffeurs les plus proches — le premier qui accepte l'obtient."
                  : "Tu es le chauffeur le plus proche."}
              </p>

              <div style={styles.priorityAlertBody}>
                <span style={{ ...styles.typeTag, background: tintBg(meta.color, 0.12), color: meta.color, marginBottom: 10, display: "inline-flex" }}>
                  {meta.label}
                </span>
                {r.urgent && (
                  <div className="rp-beacon-pulse" style={{ ...styles.urgentBadge, position: "static", marginBottom: 10, display: "inline-flex" }}>
                    <Siren size={12} style={{ marginRight: 4 }} /> URGENT
                  </div>
                )}
                <div style={styles.priorityAlertRoute}>
                  <div><strong>Départ</strong> · {r.depart}</div>
                  <div><strong>Arrivée</strong> · {r.arrivee}</div>
                </div>
                <div style={styles.priorityAlertMeta}>
                  <span><Clock size={12} /> {r.heure}</span>
                  {r.date && <span>{formatRideDate(r.date)}</span>}
                  {dist != null && <span><Navigation size={12} /> à {dist.toFixed(1)} km de toi</span>}
                  {r.tarif && <span className="rp-meter">{Number(r.tarif).toFixed(2)} €</span>}
                </div>
                {r.notes && <p style={styles.notes}>{r.notes}</p>}
              </div>

              <div style={styles.priorityAlertActions}>
                <button
                  style={{ ...styles.btnGhost, flex: 1, minHeight: 52, fontSize: 15 }}
                  onClick={() => setPriorityAlert(null)}
                >
                  Je la laisse
                </button>
                <button
                  style={{ ...styles.btnPrimary, flex: 1, minHeight: 52, fontSize: 15, justifyContent: "center" }}
                  onClick={async () => {
                    await claim(r.id);
                    setPriorityAlert(null);
                  }}
                >
                  Je la prends
                </button>
              </div>
            </div>
          </div>
        );
      })()}
      {pulling && (
        <div style={styles.pullBanner}>
          ↓ Relâche pour actualiser
        </div>
      )}
      <header style={styles.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={styles.logoBadge}>
            <Car size={18} color="#1A1206" />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <h1 style={styles.title}>RoulePartner</h1>
            <span style={styles.headerSubtitle}>
              {driverName}{profiles[driverName]?.commune ? ` · ${profiles[driverName].commune}` : ""}
            </span>
          </div>
        </div>
        <button
          onClick={sharePosition}
          aria-label="Basculer en service / hors service"
          style={{ ...styles.statusPill, ...(myPosStatus === "ok" ? styles.statusPillOn : styles.statusPillOff) }}
        >
          <span style={{ ...styles.statusDot, background: myPosStatus === "ok" ? "#3BD07A" : "#6E757E" }} />
          {myPosStatus === "ok" ? "En service" : myPosStatus === "locating" ? "Localisation…" : "Hors service"}
        </button>
      </header>
      {myPosStatus === "denied" && (
        <div style={styles.hintBanner}>Position refusée — vérifie les réglages du navigateur pour recevoir les courses proches de toi.</div>
      )}

      <div className="rp-desktop-tabs" style={{ ...styles.tabs, gap: 8 }}>
        <button
          onClick={() => setShowFilterMenu(true)}
          style={{ ...styles.tab, display: "flex", alignItems: "center", gap: 6 }}
        >
          <Search size={13} /> Filtre {radiusFilter !== "all" && `(${radiusFilter} km)`}
        </button>
        <button
          onClick={() => setShowCalendarMenu(true)}
          style={{ ...styles.tab, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1, padding: "6px 12px" }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Calendar size={13} /> {!dateFilter ? "Toutes les dates"
              : dateFilter === "week" ? "Cette semaine"
              : dateFilter === todayKey(0) ? "Aujourd'hui"
              : dateFilter === todayKey(1) ? "Demain"
              : formatDayMonth(dateFilter)}
          </span>
          {dateFilter && dateFilter !== "week" && (
            <span style={{ fontSize: 11, color: "#8A9099", fontWeight: 400 }}>{formatDayMonth(dateFilter)} ▾</span>
          )}
        </button>
        <div style={{ flex: 1 }} />
      </div>

      {showFilterMenu && (
        <div style={styles.modalOverlay} onClick={() => setShowFilterMenu(false)}>
          <div style={{ ...styles.modalCard, maxWidth: 320 }} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>Filtrer par rayon</h2>
              <button onClick={() => setShowFilterMenu(false)} style={styles.iconBtn}><X size={16} /></button>
            </div>
            <p style={{ color: "#8A9099", fontSize: 13, marginBottom: 12 }}>
              Ne montrer que les courses dans ce rayon autour de toi (nécessite d'être "en service").
            </p>
            {["15", "30", "50", "100", "all"].map((v) => (
              <button
                key={v}
                onClick={() => { updateRadiusFilter(v); setShowFilterMenu(false); }}
                style={{
                  ...styles.togglePill, width: "100%", marginBottom: 8, justifyContent: "flex-start",
                  borderColor: radiusFilter === v ? "#FFB43A" : "#3A4048",
                  color: radiusFilter === v ? "#1A1206" : "#B8BEC6",
                  background: radiusFilter === v ? "#FFB43A" : "transparent",
                }}
              >
                {v === "all" ? "Toute distance" : `Rayon de ${v} km`}
              </button>
            ))}
          </div>
        </div>
      )}

      {showCalendarMenu && (
        <div style={styles.modalOverlay} onClick={() => setShowCalendarMenu(false)}>
          <div style={{ ...styles.modalCard, maxWidth: 320 }} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>Voir par date</h2>
              <button onClick={() => setShowCalendarMenu(false)} style={styles.iconBtn}><X size={16} /></button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button
                onClick={() => { setDateFilter(dateFilter === todayKey(0) ? "" : todayKey(0)); setShowCalendarMenu(false); }}
                style={{ ...styles.togglePill, borderColor: dateFilter === todayKey(0) ? "#FFB43A" : "#3A4048", background: dateFilter === todayKey(0) ? "#FFB43A" : "transparent", color: dateFilter === todayKey(0) ? "#1A1206" : "#B8BEC6" }}
              >
                Aujourd'hui
              </button>
              <button
                onClick={() => { setDateFilter(dateFilter === todayKey(1) ? "" : todayKey(1)); setShowCalendarMenu(false); }}
                style={{ ...styles.togglePill, borderColor: dateFilter === todayKey(1) ? "#FFB43A" : "#3A4048", background: dateFilter === todayKey(1) ? "#FFB43A" : "transparent", color: dateFilter === todayKey(1) ? "#1A1206" : "#B8BEC6" }}
              >
                Demain
              </button>
              <button
                onClick={() => { setDateFilter(dateFilter === "week" ? "" : "week"); setShowCalendarMenu(false); }}
                style={{ ...styles.togglePill, borderColor: dateFilter === "week" ? "#FFB43A" : "#3A4048", background: dateFilter === "week" ? "#FFB43A" : "transparent", color: dateFilter === "week" ? "#1A1206" : "#B8BEC6" }}
              >
                Cette semaine
              </button>
              <label style={styles.fieldLabel}>
                Autre date (courses futures ou passées)
                <input
                  type="date"
                  lang="fr-FR"
                  value={dateFilter}
                  onChange={(e) => { setDateFilter(e.target.value); }}
                  style={styles.input}
                />
              </label>
              {dateFilter && (
                <button onClick={() => { setDateFilter(""); setShowCalendarMenu(false); }} style={styles.btnGhost}>
                  Effacer le filtre de date
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div style={{ margin: "0 24px 18px" }}>
        <div style={styles.gainsCard}>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={styles.gainsLabel}>Gains {earningsLabel}</span>
            <span style={styles.gainsAmount}>{myEarnings.toFixed(2)} €</span>
          </div>
          <span style={styles.gainsCount}>
            {myTakenRides.length} course{myTakenRides.length > 1 ? "s" : ""}<br />reprise{myTakenRides.length > 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {!myPos && (
        <div style={styles.hintBanner}>
          Mets-toi en service pour trier les courses par proximité et profiter
          de la priorité "plus proche".
        </div>
      )}

      {error && (
        <div style={styles.errorBanner}>
          {error}
          <button onClick={() => setError("")} style={{ background: "none", border: "none", cursor: "pointer" }}>
            <X size={14} color="#F2F4F7" />
          </button>
        </div>
      )}

      {showForm && (
        <form onSubmit={handlePost} style={styles.formCard}>
          <div style={styles.formRow}>
            {TYPES.map((t) => (
              <button
                type="button"
                key={t.id}
                onClick={() => setForm({ ...form, type: t.id })}
                style={{
                  ...styles.typeChip,
                  color: form.type === t.id ? "#1A1206" : "#B8BEC6",
                  background: form.type === t.id ? "#FFB43A" : "#22262C",
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="button" onClick={swapDepartArrivee} style={styles.btnGhost}>
              ↓↑ Inverser départ / arrivée
            </button>
          </div>
          <div style={styles.formGrid}>
            <label style={styles.fieldLabel}>
              Adresse de départ
              <div style={{ position: "relative" }}>
                <input
                  style={styles.input}
                  placeholder="Ex: 5 rue du Rhin, Bischwiller — ou un nom de lieu"
                  value={form.depart}
                  onChange={(e) => {
                    setForm({ ...form, depart: e.target.value });
                    setActiveField("depart");
                    setSuggestionActiveIndex(-1);
                    searchAddress(e.target.value, setDepartSuggestions);
                  }}
                  onFocus={() => { setActiveField("depart"); setSuggestionActiveIndex(-1); }}
                  onBlur={() => setTimeout(() => setActiveField((f) => (f === "depart" ? null : f)), 120)}
                  onKeyDown={(e) => handleAddressKeyDown("depart", e)}
                  required
                />
                {activeField === "depart" && searchingAddress && form.depart.trim().length >= 3 && (
                  <div style={styles.suggestionBox}>
                    <div style={{ ...styles.suggestionItem, color: "#6E757E", cursor: "default" }}>Recherche…</div>
                  </div>
                )}
                {activeField === "depart" && !searchingAddress && suggestionListFor("depart").length > 0 && (
                  <div style={styles.suggestionBox}>
                    {form.depart.trim().length < 3 && (
                      <div style={{ ...styles.suggestionItem, color: "#6E757E", cursor: "default", minHeight: "auto", padding: "8px 14px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: "1px solid #23272E" }}>
                        Adresses récentes
                      </div>
                    )}
                    {suggestionListFor("depart").map((s, i) => {
                      const isRecent = !!s.recent;
                      const label = isRecent ? s.address : shortAddress(s);
                      const dist = isRecent ? null : suggestionDistanceLabel(positions[driverName], s);
                      const Icon = isRecent ? Clock : isMedicalPoi(s) ? Stethoscope : MapPin;
                      return (
                        <div
                          key={isRecent ? `recent-${s.address}` : s.place_id}
                          style={{ ...styles.suggestionItem, background: i === suggestionActiveIndex ? "#23272E" : undefined }}
                          onMouseDown={(e) => { e.preventDefault(); pickAddressSuggestion("depart", s); }}
                          onMouseEnter={() => setSuggestionActiveIndex(i)}
                        >
                          <Icon size={13} style={{ marginRight: 6, flexShrink: 0 }} />
                          <span style={{ flex: 1 }}>{label}</span>
                          {dist && <span style={{ fontSize: 12, color: "#8b909c", marginLeft: 8, flexShrink: 0 }}>{dist}</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </label>
            <label style={styles.fieldLabel}>
              Adresse d'arrivée
              <div style={{ position: "relative" }}>
                <input
                  style={styles.input}
                  placeholder="Ex: Hôpital Civil, Strasbourg"
                  value={form.arrivee}
                  onChange={(e) => {
                    setForm({ ...form, arrivee: e.target.value });
                    setActiveField("arrivee");
                    setSuggestionActiveIndex(-1);
                    searchAddress(e.target.value, setArriveeSuggestions, debounceRefArrivee);
                  }}
                  onFocus={() => { setActiveField("arrivee"); setSuggestionActiveIndex(-1); }}
                  onBlur={() => setTimeout(() => setActiveField((f) => (f === "arrivee" ? null : f)), 120)}
                  onKeyDown={(e) => handleAddressKeyDown("arrivee", e)}
                  required
                />
                {activeField === "arrivee" && searchingAddress && form.arrivee.trim().length >= 3 && (
                  <div style={styles.suggestionBox}>
                    <div style={{ ...styles.suggestionItem, color: "#6E757E", cursor: "default" }}>Recherche…</div>
                  </div>
                )}
                {activeField === "arrivee" && !searchingAddress && suggestionListFor("arrivee").length > 0 && (
                  <div style={styles.suggestionBox}>
                    {form.arrivee.trim().length < 3 && (
                      <div style={{ ...styles.suggestionItem, color: "#6E757E", cursor: "default", minHeight: "auto", padding: "8px 14px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: "1px solid #23272E" }}>
                        Adresses récentes
                      </div>
                    )}
                    {suggestionListFor("arrivee").map((s, i) => {
                      const isRecent = !!s.recent;
                      const label = isRecent ? s.address : shortAddress(s);
                      const dist = isRecent ? null : suggestionDistanceLabel(positions[driverName], s);
                      const Icon = isRecent ? Clock : isMedicalPoi(s) ? Stethoscope : MapPin;
                      return (
                        <div
                          key={isRecent ? `recent-${s.address}` : s.place_id}
                          style={{ ...styles.suggestionItem, background: i === suggestionActiveIndex ? "#23272E" : undefined }}
                          onMouseDown={(e) => { e.preventDefault(); pickAddressSuggestion("arrivee", s); }}
                          onMouseEnter={() => setSuggestionActiveIndex(i)}
                        >
                          <Icon size={13} style={{ marginRight: 6, flexShrink: 0 }} />
                          <span style={{ flex: 1 }}>{label}</span>
                          {dist && <span style={{ fontSize: 12, color: "#8b909c", marginLeft: 8, flexShrink: 0 }}>{dist}</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </label>
            <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => setForm({ ...form, date: todayKey(0), heure: timePlusMinutes(0) })}
                style={{ ...styles.togglePill, flex: 1 }}
              >
                Maintenant
              </button>
              <button
                type="button"
                onClick={() => setForm({ ...form, date: todayKey(0), heure: timePlusMinutes(15) })}
                style={{ ...styles.togglePill, flex: 1 }}
              >
                Dans 15 min
              </button>
            </div>
            <label style={styles.fieldLabel}>
              Date de la course
              <input style={styles.input} type="date" lang="fr-FR" value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })} required />
            </label>
            <label style={styles.fieldLabel}>
              Heure de prise en charge
              <input style={styles.input} type="time" value={form.heure}
                onChange={(e) => setForm({ ...form, heure: e.target.value })} required />
            </label>
            <label style={styles.fieldLabel}>
              Tarif estimé (€) {form.type === "taxi" && (
                calculatingTarif
                  ? <span style={{ color: "#FFB43A", fontWeight: 400 }}>— calcul en cours…</span>
                  : <span style={{ color: "#3BD07A", fontWeight: 400 }}>— calculé automatiquement</span>
              )}
              <input style={{ ...styles.input, width: "100%" }} placeholder="Ex: 65" value={form.tarif}
                onChange={(e) => setForm({ ...form, tarif: e.target.value })} />
            </label>
            {form.type === "taxi" && (
              <>
                <label style={styles.checkboxRow}>
                  <input type="checkbox" checked={form.majorationNuitWeekend}
                    onChange={(e) => setForm({ ...form, majorationNuitWeekend: e.target.checked })} />
                  Nuit/dimanche/férié (+50 %) — détecté automatiquement
                </label>
                <button
                  type="button"
                  onClick={() => setShowTarifOptions(!showTarifOptions)}
                  style={styles.collapsibleHeader}
                >
                  Plus d'options de tarif
                  {showTarifOptions ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
                {showTarifOptions && (
                  <>
                    <label style={styles.checkboxRow} title="Marseille, Paris, Nice, Toulouse, Lyon, Strasbourg, Montpellier, Rennes, Bordeaux, Lille, Grenoble, Nantes, ou départements 92/93/94">
                      <input type="checkbox" checked={form.grandeVille}
                        onChange={(e) => setForm({ ...form, grandeVille: e.target.checked })} />
                      Forfait grande ville (+15 €)
                    </label>
                    <label style={styles.checkboxRow} title="Hospitalisation, chimio, radiothérapie, dialyse... dont l'aller ou le retour se fait à vide">
                      <input type="checkbox" checked={form.retourAVide}
                        onChange={(e) => setForm({ ...form, retourAVide: e.target.checked })} />
                      Retour à vide (hospitalisation/dialyse)
                    </label>
                  </>
                )}
              </>
            )}
            <div style={styles.fieldLabel}>
              Trajet
              <div style={styles.formRow}>
                {TRAJET_TYPES.map((t) => (
                  <button
                    type="button"
                    key={t.id}
                    onClick={() => setForm({ ...form, trajet: t.id })}
                    style={{
                      ...styles.typeChip,
                      color: form.trajet === t.id ? "#1A1206" : "#B8BEC6",
                      background: form.trajet === t.id ? "#FFB43A" : "#22262C",
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <div style={styles.formRow}>
              <button
                type="button"
                onClick={() => setForm({ ...form, urgent: !form.urgent })}
                style={{
                  ...styles.togglePill,
                  borderColor: form.urgent ? "#E5484D" : "#3A4048",
                  color: form.urgent ? "#fff" : "#B8BEC6",
                  background: form.urgent ? "#E5484D" : "transparent",
                }}
              >
                <Siren size={17} /> Urgent
              </button>
              <button
                type="button"
                onClick={() => setForm({ ...form, tpmr: !form.tpmr })}
                style={{
                  ...styles.togglePill,
                  borderColor: form.tpmr ? "#8FB3F5" : "#3A4048",
                  color: form.tpmr ? "#fff" : "#B8BEC6",
                  background: form.tpmr ? "#8FB3F5" : "transparent",
                }}
              >
                TPMR
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowMoreDetails(!showMoreDetails)}
            style={styles.collapsibleHeader}
          >
            Détails complémentaires (patient, notes, photo — optionnel)
            {showMoreDetails ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
          {showMoreDetails && (
            <>
              <label style={styles.fieldLabel}>
                Initiales patient (optionnel)
                <input style={styles.input} placeholder="Ex: J.D." value={form.patient}
                  onChange={(e) => setForm({ ...form, patient: e.target.value })} />
              </label>
              <label style={styles.fieldLabel}>
                Téléphone patient (optionnel)
                <input style={styles.input} placeholder="Ex: 06 12 34 56 78" value={form.patientTel}
                  onChange={(e) => setForm({ ...form, patientTel: e.target.value })} />
              </label>
              <label style={styles.fieldLabel}>
                Notes
                <textarea style={{ ...styles.input, width: "100%", minHeight: 60 }}
                  placeholder="Brancard, fauteuil roulant, code d'accès..." value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </label>
              <label style={styles.fieldLabel}>
                Photo du bon de transport (optionnel)
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handlePhotoChange}
                  style={{ display: "none" }}
                />
                <button type="button" onClick={() => photoInputRef.current?.click()} style={styles.btnGhost}>
                  {form.photo ? "Changer la photo" : "Choisir une photo"}
                </button>
              </label>
              {form.photo && (
                <div style={{ position: "relative", display: "inline-block" }}>
                  <img src={form.photo} alt="Bon de transport" style={styles.photoPreview} />
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, photo: null })}
                    style={styles.photoRemoveBtn}
                    title="Retirer la photo"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
              <label style={styles.fieldLabel}>
                Bon de transport en PDF (optionnel — visible seulement une fois la course prise)
                <input
                  ref={documentInputRef}
                  type="file"
                  accept="application/pdf"
                  onChange={handleDocumentChange}
                  style={{ display: "none" }}
                />
                <button type="button" onClick={() => documentInputRef.current?.click()} style={styles.btnGhost}>
                  {form.document ? "Changer le PDF" : "Joindre un PDF"}
                </button>
              </label>
              {form.document && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#8A9099" }}>
                  <FileText size={14} /> {form.documentName || "bon-de-transport.pdf"}
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, document: null, documentName: "" })}
                    style={styles.iconBtn}
                    title="Retirer le PDF"
                  >
                    <X size={13} />
                  </button>
                </div>
              )}
            </>
          )}

          <div style={{
            display: "flex", gap: 10, position: "sticky", bottom: 0,
            background: "#191C21", padding: "12px 0 2px", marginTop: 4,
          }}>
            <button type="button" onClick={() => { setShowForm(false); setEditingId(null); setForm(emptyForm); }} style={{ ...styles.btnGhost, minHeight: 52, fontSize: 15 }}>
              Annuler
            </button>
            <button type="submit" style={{ ...styles.btnPrimary, flex: 1, minHeight: 52, fontSize: 16, justifyContent: "center" }}>
              {editingId ? "Enregistrer les modifications" : "Publier"}
            </button>
          </div>
        </form>
      )}

      {filter === "carte" ? (
        <main style={{ padding: "0 24px" }}>
          <p style={{ color: "#8A9099", fontSize: 13, marginBottom: 6 }}>
            {mapDrivers.length === 0
              ? "Aucun chauffeur ne partage sa position pour l'instant."
              : `${mapDrivers.length} chauffeur${mapDrivers.length > 1 ? "s" : ""} visible${mapDrivers.length > 1 ? "s" : ""} (position partagée il y a moins de 15 min)${radiusFilter !== "all" && myPosForMap ? `, dans un rayon de ${radiusFilter} km` : ""}.`}
          </p>
          <p style={{ color: "#6E757E", fontSize: 12, marginBottom: 12, display: "flex", gap: 14, alignItems: "center" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "#3BD07A", display: "inline-block" }} /> Libre</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "#E5484D", display: "inline-block" }} /> En course</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "#FFB43A", display: "inline-block" }} /> Toi</span>
          </p>
          <div ref={mapContainerRef} style={styles.mapContainer} />
        </main>
      ) : filter === "planning" ? (
        <main style={{ padding: "0 24px" }}>
          <p style={{ color: "#8A9099", fontSize: 13, marginBottom: 16 }}>
            Les courses que tu as ajoutées toi-même à ton planning (bouton "Ajouter au planning" sur chaque
            course), classées par heure. Les temps de trajet sont estimés à vol d'oiseau (~{AVG_SPEED_KMH} km/h
            en moyenne) : prévois une marge, ce n'est pas un vrai calcul d'itinéraire routier.
          </p>
          {planningSteps.length === 0 ? (
            <p style={styles.empty}>Aucune course dans ton planning pour l'instant. Ajoutes-en depuis les onglets Disponibles / Toutes / Mes courses.</p>
          ) : (
            planningSteps.map(({ ride: r, gapInfo }, i) => (
              <div key={r.id}>
                {gapInfo && (
                  <div
                    style={{
                      ...styles.planningGap,
                      borderColor: gapInfo.tight ? "#E5484D" : "#3A4048",
                      color: gapInfo.tight ? "#E5484D" : "#6E757E",
                    }}
                  >
                    {gapInfo.distKm != null ? (
                      <>
                        <Navigation size={12} style={{ marginRight: 6 }} />
                        ~{gapInfo.distKm.toFixed(1)} km · ~{Math.round(gapInfo.travelMin)} min de route pour{" "}
                        {gapInfo.gapMin} min disponibles
                        {gapInfo.tight && " — risque de retard"}
                      </>
                    ) : (
                      "Distance inconnue (adresse non géolocalisée précisément)"
                    )}
                  </div>
                )}
                <div
                  style={{ ...styles.card, cursor: "pointer", marginBottom: 0 }}
                  onClick={() => setSelectedRide(r)}
                >
                  <div style={styles.cardHeader}>
                    <span style={{ ...styles.typeTag, background: tintBg(typeMeta(r.type).color, 0.12), color: typeMeta(r.type).color }}>
                      {typeMeta(r.type).label}
                    </span>
                    <span style={{ fontWeight: 700, color: "#FFB43A" }}>{r.heure}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#FFB43A", flexShrink: 0 }} />
                        <span style={{ fontWeight: 700, fontSize: 15, color: "#F2F4F7" }}>{r.depart}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: "#7C838C", flexShrink: 0 }} />
                        <span style={{ fontWeight: 600, fontSize: 15, color: "#B8BEC6" }}>{r.arrivee}</span>
                      </div>
                    </div>
                    {r.tarif && <span style={styles.tarifTag}>{r.tarif} €</span>}
                  </div>
                  <div style={styles.metaRow}>
                    <span style={styles.metaItem}>{trajetLabel(r.trajet)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); togglePlanning(r.id); }}
                      style={styles.btnGhost}
                    >
                      Retirer du planning
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </main>
      ) : (
      <main style={styles.board}>
        {visibleRides.length === 0 ? (
          <div style={styles.emptyState}>
            <div style={styles.emptyIcon}>
              <Car size={32} color="#3A4048" />
            </div>
            <p style={styles.emptyTitle}>
              {filter === "dispo" ? "Aucune course disponible pour l'instant" : "Rien à afficher ici"}
            </p>
            <p style={styles.emptySub}>
              {filter === "dispo"
                ? "Le réseau s'enrichit au fil des courses postées par les chauffeurs. Reviens bientôt, ou poste la première."
                : "Change d'onglet ou de filtre de date pour voir d'autres courses."}
              {(filter === "dispo" || filter === "toutes") && radiusFilter !== "all" && myPos && (
                <> Essaie aussi d'élargir le rayon de recherche ci-dessus.</>
              )}
            </p>
          </div>
        ) : (
          visibleRides.map((r) => {
            const meta = typeMeta(r.type);
            const mine = r.postedBy === driverName;
            const takenByMe = r.takenBy === driverName;
            const pendingByMe = r.pendingBy === driverName;
            const pendingRemainingMs = r.pendingSince ? CLAIM_CONFIRM_WINDOW_MS - (Date.now() - r.pendingSince) : 0;
            const priorityDrivers = priorityDriversFor(r);
            const withinWindow = Date.now() - r.createdAt < PRIORITY_WINDOW_MS;
            const remainingMs = PRIORITY_WINDOW_MS - (Date.now() - r.createdAt);
            const remainingLabel = remainingMs > 0 ? `${Math.ceil(remainingMs / 1000)}s` : null;
            const iAmPriority = priorityDrivers.some((d) => d.name === driverName);
            const isPriorityLocked =
              r.status === "disponible" && priorityDrivers.length > 0 && withinWindow && !iAmPriority && !mine;

            return (
              <div
                key={r.id}
                style={{ ...styles.card, cursor: "pointer" }}
                onClick={() => setSelectedRide(r)}
              >
                {r.urgent && (
                  <div className="rp-beacon-pulse" style={styles.urgentBadge}>
                    <Siren size={12} style={{ marginRight: 4 }} />
                    URGENT
                  </div>
                )}
                <div style={styles.cardHeader}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ ...styles.typeTag, background: tintBg(meta.color, 0.12), color: meta.color }}>
                      {r.type === "ambulance" ? <Stethoscope size={12} style={{ marginRight: 4 }} /> : <Car size={12} style={{ marginRight: 4 }} />}
                      {meta.label}
                    </span>
                    {r.tpmr && (
                      <span style={styles.tpmrBadge} title="Transport de personne à mobilité réduite">TPMR</span>
                    )}
                  </div>
                  <span style={{
                    ...styles.statusTag,
                    color: r.status === "disponible" ? "#3BD07A" : r.status === "en_attente" ? "#FFB43A" : r.status === "en_cours" ? "#FFB43A" : r.status === "terminee" ? "#6E757E" : "#FFB43A",
                  }}>
                    {r.status === "disponible" ? "Disponible"
                      : r.status === "en_attente" ? `En attente (${r.pendingBy})`
                      : r.status === "en_cours" ? `En cours (${r.takenBy})`
                      : r.status === "terminee" ? "Terminée"
                      : `Prise par ${r.takenBy}`}
                  </span>
                </div>

                {r.photo && <img src={r.photo} alt="Bon de transport" style={styles.cardThumb} />}

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#FFB43A", flexShrink: 0 }} />
                      <span style={{ fontWeight: 700, fontSize: 15, color: "#F2F4F7" }}>{cardLocality(r.depart)}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: "#7C838C", flexShrink: 0 }} />
                      <span style={{ fontWeight: 600, fontSize: 15, color: "#B8BEC6" }}>{cardLocality(r.arrivee)}</span>
                    </div>
                  </div>
                  {r.tarif && <span style={styles.tarifTag}>{r.tarif} €</span>}
                </div>

                <div style={styles.metaRow}>
                  <span style={styles.metaItem}><Clock size={13} /> Prise en charge : {formatRideDate(r.date)} à {r.heure} — {trajetLabel(r.trajet)}</span>
                  {r.calcDistanceKm != null && (
                    <span style={styles.metaItem}>
                      ({r.calcDistanceKm} km {r.calcIsRoadDistance ? "réels (route)" : "à vol d'oiseau"})
                    </span>
                  )}
                  {r.patient && <span style={styles.metaItem}>Patient : {r.patient}</span>}
                  {r.patientTel && (
                    <a
                      href={`tel:${r.patientTel.replace(/\s/g, "")}`}
                      onClick={(e) => e.stopPropagation()}
                      style={{ ...styles.metaItem, color: "#FFB43A", textDecoration: "underline" }}
                    >
                      <Phone size={12} /> {r.patientTel}
                    </a>
                  )}
                  {r._dist != null && (
                    <span style={{ ...styles.metaItem, color: "#FFB43A", fontWeight: 600 }}>
                      <Navigation size={12} /> À {r._dist.toFixed(1)} km de vous · ~{Math.round((r._dist / AVG_SPEED_KMH) * 60)} min
                    </span>
                  )}
                </div>

                {r.notes && <p style={styles.notes}>{r.notes}</p>}

                {isPriorityLocked && (
                  <div style={styles.priorityBanner}>
                    <Timer size={13} style={{ marginRight: 6 }} />
                    {priorityDrivers.length === 1
                      ? `Priorité à ${priorityDrivers[0].name} (${priorityDrivers[0].dist.toFixed(1)} km)`
                      : `Priorité aux ${priorityDrivers.length} chauffeurs les plus proches`}
                    {" "}— ouvert à tous dans {remainingLabel}
                  </div>
                )}

                {r.status === "disponible" && withinWindow && iAmPriority && !mine && (
                  <div style={styles.priorityBanner}>
                    <Timer size={13} style={{ marginRight: 6 }} />
                    {priorityDrivers.length === 1
                      ? `Tu es le plus proche — priorité pendant ${remainingLabel}`
                      : `Tu fais partie des ${priorityDrivers.length} plus proches — premier arrivé, premier servi (${remainingLabel})`}
                  </div>
                )}

                {r.status === "en_attente" && mine && (
                  <div style={styles.pendingBanner}>
                    <strong>{r.pendingBy}</strong> veut prendre cette course — confirmation automatique dans{" "}
                    {Math.max(0, Math.ceil(pendingRemainingMs / 1000))}s
                  </div>
                )}
                {r.status === "en_attente" && pendingByMe && (
                  <div style={styles.pendingBanner}>
                    En attente de confirmation de {r.postedBy}… ({Math.max(0, Math.ceil(pendingRemainingMs / 1000))}s)
                  </div>
                )}

                <div style={styles.cardFooter}>
                  <span style={styles.postedBy}>Posté par {r.postedBy} · {formatPostedAt(r.createdAt)}</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    {r.status === "disponible" && !mine && !isPriorityLocked && (
                      <button onClick={(e) => { e.stopPropagation(); claim(r.id); }} style={styles.btnClaim}>
                        <Check size={14} style={{ marginRight: 4 }} />
                        Je la prends
                      </button>
                    )}
                    {r.status === "en_attente" && mine && (
                      <>
                        <button onClick={(e) => { e.stopPropagation(); confirmClaim(r); }} style={styles.btnClaim}>
                          Confirmer
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); refuseClaim(r.id); }} style={styles.btnGhost}>
                          Refuser
                        </button>
                      </>
                    )}
                    {r.status === "en_attente" && pendingByMe && (
                      <button onClick={(e) => { e.stopPropagation(); cancelMyClaim(r.id); }} style={styles.btnGhost}>
                        Annuler ma demande
                      </button>
                    )}
                    {r.status === "prise" && takenByMe && (
                      <>
                        <button onClick={(e) => { e.stopPropagation(); startRide(r.id); }} style={styles.btnClaim}>
                          <Car size={14} style={{ marginRight: 4 }} /> Commencer
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); release(r.id); }} style={styles.btnGhost}>Relâcher</button>
                      </>
                    )}
                    {r.status === "en_cours" && takenByMe && (
                      <button onClick={(e) => { e.stopPropagation(); markDone(r.id); }} style={styles.btnClaim}>
                        <Check size={14} style={{ marginRight: 4 }} /> Terminer
                      </button>
                    )}
                    {(mine || isAdmin) && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm("Supprimer définitivement cette course ?")) remove(r.id);
                        }}
                        style={styles.iconBtn}
                        title="Supprimer"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </main>
      )}

      {selectedRide && (() => {
        const r = selectedRide;
        const meta = typeMeta(r.type);
        const mine = r.postedBy === driverName;
        const takenByMe = r.takenBy === driverName;
        const pendingByMe = r.pendingBy === driverName;
        const pendingRemainingMs = r.pendingSince ? CLAIM_CONFIRM_WINDOW_MS - (Date.now() - r.pendingSince) : 0;
        const priorityDrivers = priorityDriversFor(r);
        const withinWindow = Date.now() - r.createdAt < PRIORITY_WINDOW_MS;
        const iAmPriority = priorityDrivers.some((d) => d.name === driverName);
        const isPriorityLocked =
          r.status === "disponible" && priorityDrivers.length > 0 && withinWindow && !iAmPriority && !mine;
        const dist = myPos ? distanceKm(myPos, ridePickupCoords(r)) : null;
        return (
          <div style={styles.modalOverlay} onClick={() => setSelectedRide(null)}>
            <div style={styles.modalCard} onClick={(e) => e.stopPropagation()}>
              <div style={styles.modalHeader}>
                <span style={{ ...styles.typeTag, background: tintBg(meta.color, 0.12), color: meta.color }}>
                  {r.type === "ambulance" ? <Stethoscope size={12} style={{ marginRight: 4 }} /> : <Car size={12} style={{ marginRight: 4 }} />}
                  {meta.label}
                </span>
                <button onClick={() => setSelectedRide(null)} style={styles.iconBtn}>
                  <X size={16} />
                </button>
              </div>

              {r.urgent && (
                <div className="rp-beacon-pulse" style={{ ...styles.urgentBadge, position: "static", display: "inline-flex", marginBottom: 12 }}>
                  <Siren size={12} style={{ marginRight: 4 }} />
                  URGENT
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span style={{ width: 9, height: 9, borderRadius: "50%", background: "#FFB43A", flexShrink: 0 }} />
                  <span style={{ fontWeight: 700, fontSize: 17, color: "#F2F4F7" }}>{r.depart}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: "#7C838C", flexShrink: 0 }} />
                  <span style={{ fontWeight: 600, fontSize: 17, color: "#B8BEC6" }}>{r.arrivee}</span>
                </div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <span style={{ fontSize: 12, color: "#8A9099", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5 }}><Navigation size={12} /> Se guider vers le départ</span>
                <div style={styles.navRow}>
                  <a href={wazeUrl(r.departLat, r.departLng, r.depart)} target="_blank" rel="noopener noreferrer" style={{ ...styles.navBtn, ...styles.navBtnWaze }}>
                    <span style={{ ...styles.navBtnDot, background: "#05C8F7" }}>W</span> Waze
                  </a>
                  <a href={googleMapsUrl(r.departLat, r.departLng, r.depart)} target="_blank" rel="noopener noreferrer" style={{ ...styles.navBtn, ...styles.navBtnMaps }}>
                    <span style={{ ...styles.navBtnDot, background: "#4285F4" }}>M</span> Maps
                  </a>
                </div>
              </div>
              <div style={{ marginBottom: 14 }}>
                <span style={{ fontSize: 12, color: "#8A9099", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5 }}><Flag size={12} /> Se guider vers l'arrivée</span>
                <div style={styles.navRow}>
                  <a href={wazeUrl(r.arriveeLat, r.arriveeLng, r.arrivee)} target="_blank" rel="noopener noreferrer" style={{ ...styles.navBtn, ...styles.navBtnWaze }}>
                    <span style={{ ...styles.navBtnDot, background: "#05C8F7" }}>W</span> Waze
                  </a>
                  <a href={googleMapsUrl(r.arriveeLat, r.arriveeLng, r.arrivee)} target="_blank" rel="noopener noreferrer" style={{ ...styles.navBtn, ...styles.navBtnMaps }}>
                    <span style={{ ...styles.navBtnDot, background: "#4285F4" }}>M</span> Maps
                  </a>
                </div>
              </div>

              <div style={styles.modalGrid}>
                <div style={styles.modalRow}>
                  <Clock size={16} color="#FFB43A" />
                  <span>Prise en charge {formatRideDate(r.date)} à {r.heure} — {trajetLabel(r.trajet)}</span>
                </div>
                {r.tarif && (
                  <div style={styles.modalRow}>
                    <span className="rp-meter" style={{ fontSize: 28 }}>{r.tarif} €</span>
                  </div>
                )}
                {r.calcDistanceKm != null && (
                  <div style={styles.modalRow}>
                    <span style={{ color: "#8A9099", fontSize: 13 }}>
                      Distance {r.calcIsRoadDistance ? "routière réelle" : "estimée (à vol d'oiseau)"} : {r.calcDistanceKm} km
                    </span>
                  </div>
                )}
                {r.patient && (
                  <div style={styles.modalRow}>
                    <User size={16} color="#8A9099" />
                    <span>Patient : {r.patient}</span>
                  </div>
                )}
                {r.patientTel && (
                  <div style={styles.modalRow}>
                    <a href={`tel:${r.patientTel.replace(/\s/g, "")}`} style={styles.contactBtn}>
                      <Phone size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> Appeler le patient — {r.patientTel}
                    </a>
                  </div>
                )}
                {r.tpmr && (
                  <div style={styles.modalRow}>
                    <span style={styles.tpmrBadge}>TPMR</span>
                    <span>Mobilité réduite</span>
                  </div>
                )}
                {dist != null && (
                  <div style={styles.modalRow}>
                    <Navigation size={16} color="#FFB43A" />
                    <span>{dist.toFixed(1)} km de toi</span>
                  </div>
                )}
                <div style={styles.modalRow}>
                  <span style={{
                    color: r.status === "disponible" ? "#3BD07A" : r.status === "en_attente" ? "#FFB43A" : r.status === "en_cours" ? "#FFB43A" : r.status === "terminee" ? "#6E757E" : "#FFB43A",
                    fontWeight: 600,
                  }}>
                    {r.status === "disponible" ? "Disponible"
                      : r.status === "en_attente" ? `En attente de confirmation (${r.pendingBy})`
                      : r.status === "en_cours" ? `En cours (${r.takenBy})`
                      : r.status === "terminee" ? "Terminée"
                      : `Prise par ${r.takenBy}`}
                  </span>
                </div>
                <div style={styles.modalRow}>
                  <span style={{ color: "#6E757E", fontSize: 13 }}>Posté par {r.postedBy} · publiée le {formatPostedAt(r.createdAt)}</span>
                </div>
                {!mine && profiles[r.postedBy]?.phone && (
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <a href={`tel:${profiles[r.postedBy].phone.replace(/\s/g, "")}`} style={styles.contactBtn}>
                      <Phone size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> Appeler {r.postedBy}
                    </a>
                    <a href={`sms:${profiles[r.postedBy].phone.replace(/\s/g, "")}`} style={styles.contactBtn}>
                      <MessageCircle size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> SMS
                    </a>
                  </div>
                )}
                {(mine || takenByMe || pendingByMe) && (
                  <button
                    onClick={() => setChatRideId(r.id)}
                    style={{ ...styles.contactBtn, width: "100%", marginTop: 8, background: "#FFB43A", color: "#1A1206", border: "none", fontWeight: 700 }}
                  >
                    <MessageCircle size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> Discuter dans l'appli
                  </button>
                )}
              </div>

              {r.notes && (
                <div style={{ ...styles.notes, marginTop: 12 }}>
                  <strong>Notes :</strong> {r.notes}
                </div>
              )}

              {r.photo && (
                <a href={r.photo} download={`bon-transport-${r.id}.jpg`}>
                  <img src={r.photo} alt="Bon de transport" style={styles.modalPhoto} />
                </a>
              )}

              {r.document && (mine || takenByMe || pendingByMe) && (
                <button
                  type="button"
                  onClick={() => openPdfDocument(r.document, r.documentName || `bon-transport-${r.id}.pdf`)}
                  style={{
                    ...styles.contactBtn, display: "block", width: "100%", marginTop: 10,
                    textAlign: "center", border: "none", cursor: "pointer",
                  }}
                >
                  <FileText size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> Ouvrir le bon de transport (PDF)
                </button>
              )}
              {r.document && !mine && !takenByMe && !pendingByMe && (
                <p style={{ color: "#6E757E", fontSize: 12, marginTop: 10, display: "flex", alignItems: "center", gap: 5 }}>
                  <FileText size={12} /> Un bon de transport est joint — accessible une fois la course prise.
                </p>
              )}

              {isPriorityLocked && (
                <div style={styles.priorityBanner}>
                  <Timer size={13} style={{ marginRight: 6 }} />
                  {priorityDrivers.length === 1
                    ? `Priorité à ${priorityDrivers[0].name} (${priorityDrivers[0].dist.toFixed(1)} km)`
                    : `Priorité aux ${priorityDrivers.length} chauffeurs les plus proches`}
                </div>
              )}

              {r.status === "disponible" && withinWindow && iAmPriority && !mine && (
                <div style={styles.priorityBanner}>
                  <Timer size={13} style={{ marginRight: 6 }} />
                  {priorityDrivers.length === 1
                    ? "Tu es le plus proche — tu es prioritaire sur cette course."
                    : `Tu fais partie des ${priorityDrivers.length} plus proches — le premier qui accepte l'obtient.`}
                </div>
              )}

              {r.status === "en_attente" && mine && (
                <div style={styles.pendingBanner}>
                  <strong>{r.pendingBy}</strong> veut prendre cette course — confirmation automatique dans{" "}
                  {Math.max(0, Math.ceil(pendingRemainingMs / 1000))}s
                </div>
              )}
              {r.status === "en_attente" && pendingByMe && (
                <div style={styles.pendingBanner}>
                  En attente de confirmation de {r.postedBy}… ({Math.max(0, Math.ceil(pendingRemainingMs / 1000))}s)
                </div>
              )}

              <div style={styles.modalActions}>
                <button onClick={() => togglePlanning(r.id)} style={plannedIds.has(r.id) ? styles.btnClaim : styles.btnGhost}>
                  {plannedIds.has(r.id) ? "Dans le planning ✓" : "Ajouter au planning"}
                </button>
                <button onClick={() => duplicateRide(r)} style={styles.btnGhost}>
                  Dupliquer
                </button>
                {mine && r.status === "disponible" && (
                  <button onClick={() => startEdit(r)} style={styles.btnGhost}>
                    Modifier
                  </button>
                )}
                {r.status === "disponible" && !mine && !isPriorityLocked && (
                  <button onClick={() => { claim(r.id); setSelectedRide(null); }} style={styles.btnClaim}>
                    <Check size={14} style={{ marginRight: 4 }} />
                    Je la prends
                  </button>
                )}
                {r.status === "en_attente" && mine && (
                  <>
                    <button onClick={() => { confirmClaim(r); setSelectedRide(null); }} style={styles.btnClaim}>
                      Confirmer
                    </button>
                    <button onClick={() => { refuseClaim(r.id); setSelectedRide(null); }} style={styles.btnGhost}>
                      Refuser
                    </button>
                  </>
                )}
                {r.status === "en_attente" && pendingByMe && (
                  <button onClick={() => { cancelMyClaim(r.id); setSelectedRide(null); }} style={styles.btnGhost}>
                    Annuler ma demande
                  </button>
                )}
                {r.status === "prise" && takenByMe && (
                  <>
                    <button onClick={() => { startRide(r.id); setSelectedRide(null); }} style={styles.btnClaim}>
                      <Car size={14} style={{ marginRight: 4 }} /> Commencer
                    </button>
                    <button onClick={() => { release(r.id); setSelectedRide(null); }} style={styles.btnGhost}>
                      Relâcher
                    </button>
                  </>
                )}
                {r.status === "en_cours" && takenByMe && (
                  <button onClick={() => { markDone(r.id); setSelectedRide(null); }} style={styles.btnClaim}>
                    <Check size={14} style={{ marginRight: 4 }} /> Terminer
                  </button>
                )}
                {(mine || isAdmin) && (
                  <button
                    onClick={() => {
                      if (window.confirm("Supprimer définitivement cette course ?")) {
                        remove(r.id);
                        setSelectedRide(null);
                      }
                    }}
                    style={styles.btnGhost}
                  >
                    <Trash2 size={14} style={{ marginRight: 4 }} />
                    Supprimer
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      <div className="rp-bottom-spacer" />

      <nav className="rp-bottom-nav" style={styles.bottomNav}>
        <button
          onClick={() => setFilter("dispo")}
          style={{ ...styles.bottomNavBtn, color: filter === "dispo" ? "#FFB43A" : "#8A9099", position: "relative" }}
        >
          <Home size={18} />
          {newRidesBadge > 0 && (
            <span style={styles.navBadge}>{newRidesBadge > 9 ? "9+" : newRidesBadge}</span>
          )}
          <span style={styles.bottomNavLabel}>Accueil</span>
        </button>
        <button
          onClick={() => setFilter("mine")}
          style={{ ...styles.bottomNavBtn, color: filter === "mine" ? "#FFB43A" : "#8A9099" }}
        >
          <Car size={18} />
          <span style={styles.bottomNavLabel}>Courses</span>
        </button>
        {/* Emplacement réservé au bouton + flottant, pour qu'il ne recouvre aucun onglet. */}
        <div style={styles.bottomNavFabSlot} aria-hidden="true" />
        <button onClick={() => setShowMessagesPanel(true)} style={{ ...styles.bottomNavBtn, position: "relative" }}>
          <MessageCircle size={18} />
          {totalUnreadMessages > 0 && (
            <span style={styles.navBadge}>{totalUnreadMessages > 9 ? "9+" : totalUnreadMessages}</span>
          )}
          <span style={styles.bottomNavLabel}>Messages</span>
        </button>
        <button onClick={() => setShowAccountPanel(true)} style={styles.bottomNavBtn}>
          <User size={18} />
          <span style={styles.bottomNavLabel}>Compte</span>
        </button>
      </nav>
      <button onClick={() => setShowQuickMenu(true)} className="rp-fab-floating" style={styles.bottomNavFabFloating}>
        <Plus size={26} color="#1A1206" />
      </button>

      {showQuickMenu && (
        <div style={styles.modalOverlay} onClick={() => setShowQuickMenu(false)}>
          <div style={{ ...styles.modalCard, maxWidth: 340 }} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>Que veux-tu faire ?</h2>
              <button onClick={() => setShowQuickMenu(false)} style={styles.iconBtn}>
                <X size={16} />
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button
                onClick={() => { setEditingId(null); setForm(emptyForm); setShowForm(true); setShowQuickMenu(false); }}
                style={{ ...styles.btnPrimary, justifyContent: "flex-start", fontSize: 15, minHeight: 50, gap: 8 }}
              >
                <Plus size={16} /> Poster une course
              </button>
              <button
                onClick={() => { setFilter("dispo"); setShowQuickMenu(false); }}
                style={{ ...styles.btnGhost, display: "flex", alignItems: "center", gap: 8, textAlign: "left", minHeight: 48, fontSize: 15 }}
              >
                <Car size={16} /> Disponibles
              </button>
              <button
                onClick={() => { setFilter("mine"); setShowQuickMenu(false); }}
                style={{ ...styles.btnGhost, display: "flex", alignItems: "center", gap: 8, textAlign: "left", minHeight: 48, fontSize: 15 }}
              >
                <List size={16} /> Mes courses
              </button>
              <button
                onClick={() => { setFilter("recues"); setShowQuickMenu(false); }}
                style={{ ...styles.btnGhost, display: "flex", alignItems: "center", gap: 8, textAlign: "left", minHeight: 48, fontSize: 15 }}
              >
                <Inbox size={16} /> Courses reçues
              </button>
              <button
                onClick={() => { setFilter("carte"); setShowQuickMenu(false); }}
                style={{ ...styles.btnGhost, display: "flex", alignItems: "center", gap: 8, textAlign: "left", minHeight: 48, fontSize: 15 }}
              >
                <MapIcon size={16} /> Carte
              </button>
              <button
                onClick={() => { setFilter("planning"); setShowQuickMenu(false); }}
                style={{ ...styles.btnGhost, display: "flex", alignItems: "center", gap: 8, textAlign: "left", minHeight: 48, fontSize: 15 }}
              >
                <Clock size={16} /> Planning du jour
              </button>
              <button
                onClick={() => { setFilter("historique"); setShowQuickMenu(false); }}
                style={{ ...styles.btnGhost, display: "flex", alignItems: "center", gap: 8, textAlign: "left", minHeight: 48, fontSize: 15 }}
              >
                <History size={16} /> Historique
              </button>
              <button
                onClick={() => { setFilter("toutes"); setShowQuickMenu(false); }}
                style={{ ...styles.btnGhost, display: "flex", alignItems: "center", gap: 8, textAlign: "left", minHeight: 48, fontSize: 15 }}
              >
                <List size={16} /> Toutes les courses
              </button>
            </div>
          </div>
        </div>
      )}

      {showAccountPanel && (
        <div style={styles.modalOverlay} onClick={() => { setShowAccountPanel(false); setAccountSubPanel(null); }}>
          <div style={styles.modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>
                {accountSubPanel && (
                  <button
                    onClick={() => setAccountSubPanel(null)}
                    style={{ ...styles.iconBtn, marginRight: 8 }}
                  >
                    ←
                  </button>
                )}
                {accountSubPanel === "profile" ? "Modifier mon profil"
                  : accountSubPanel === "settings" ? "Réglages"
                  : accountSubPanel === "company" ? "Ma société"
                  : driverName}
              </h2>
              <button onClick={() => { setShowAccountPanel(false); setAccountSubPanel(null); }} style={styles.iconBtn}>
                <X size={16} />
              </button>
            </div>

            {!accountSubPanel && (
              <>
                <p style={{ color: "#8A9099", fontSize: 13, marginBottom: 16 }}>{user?.email}</p>
                <div style={styles.gainsCard}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <span style={styles.gainsLabel}>Gains {earningsLabel}</span>
                    <span style={styles.gainsAmount}>{myEarnings.toFixed(2)} €</span>
                  </div>
                  <span style={styles.gainsCount}>
                    {myTakenRides.length} course{myTakenRides.length > 1 ? "s" : ""}<br />reprise{myTakenRides.length > 1 ? "s" : ""}
                  </span>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
                  <button onClick={() => setAccountSubPanel("profile")} style={styles.categoryBtn}>
                    <span style={styles.categoryBtnLeft}><User size={16} /> Modifier mon profil</span>
                    <span style={{ color: "#6E757E" }}>›</span>
                  </button>
                  <button onClick={() => setAccountSubPanel("settings")} style={styles.categoryBtn}>
                    <span style={styles.categoryBtnLeft}><Settings size={16} /> Réglages (service, notifications)</span>
                    <span style={{ color: "#6E757E" }}>›</span>
                  </button>
                  <button onClick={() => setAccountSubPanel("company")} style={styles.categoryBtn}>
                    <span style={styles.categoryBtnLeft}><Building2 size={16} /> Ma société</span>
                    <span style={{ color: "#6E757E" }}>›</span>
                  </button>
                  {isAdmin && (
                    <button
                      onClick={() => { setShowAdminPanel(true); setShowAccountPanel(false); }}
                      style={{ ...styles.categoryBtn, borderColor: "#FFB43A", color: "#FFB43A" }}
                    >
                      <span style={styles.categoryBtnLeft}><Shield size={16} /> Administration</span>
                      <span>›</span>
                    </button>
                  )}
                  <button
                    onClick={() => logOut()}
                    style={{ ...styles.categoryBtn, borderColor: "#E5484D", color: "#E5484D" }}
                  >
                    <span style={styles.categoryBtnLeft}><LogOut size={16} /> Se déconnecter</span>
                  </button>
                </div>
              </>
            )}

            {accountSubPanel === "profile" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <label style={styles.fieldLabel}>
                  Pseudo
                  <input style={{ ...styles.input, opacity: 0.6 }} value={driverName} disabled />
                  <span style={{ color: "#6E757E", fontSize: 12, fontWeight: 400 }}>
                    Fixe — il sert d'identifiant technique pour tes courses et messages. Contacte l'administrateur si tu as vraiment besoin d'en changer.
                  </span>
                </label>

                <label style={styles.fieldLabel}>
                  Adresse email de connexion
                  <span style={{ color: "#8A9099", fontSize: 13, fontWeight: 400 }}>Actuelle : {user?.email}</span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      type="email"
                      placeholder="Nouvelle adresse email"
                      value={newEmailInput}
                      onChange={(e) => setNewEmailInput(e.target.value)}
                      style={{ ...styles.input, flex: 1 }}
                    />
                    <button type="button" onClick={handleEmailChange} style={styles.btnGhost}>
                      Changer
                    </button>
                  </div>
                  {emailChangeStatus && (
                    <span style={{ fontSize: 12.5, color: emailChangeStatus.ok ? "#3BD07A" : "#E5484D" }}>
                      {emailChangeStatus.text}
                    </span>
                  )}
                </label>

                <label style={styles.fieldLabel}>
                  Ton numéro de téléphone (pour que les autres te contactent)
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      type="tel"
                      placeholder="Ex: 06 12 34 56 78"
                      value={phoneInput || profiles[driverName]?.phone || ""}
                      onChange={(e) => setPhoneInput(e.target.value)}
                      style={{ ...styles.input, flex: 1 }}
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        const val = phoneInput || profiles[driverName]?.phone || "";
                        try {
                          await setDriverPhone(driverName, val);
                          setError("");
                        } catch (e) {
                          setError("Échec de l'enregistrement du numéro.");
                        }
                      }}
                      style={styles.btnGhost}
                    >
                      Enregistrer
                    </button>
                  </div>
                </label>

                <label style={styles.fieldLabel}>
                  Ta commune de rattachement
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      placeholder="Ex: Haguenau"
                      value={communeInput}
                      onChange={(e) => setCommuneInput(e.target.value)}
                      style={{ ...styles.input, flex: 1 }}
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await updateProfileFields(driverName, { commune: communeInput.trim() });
                          setError("");
                        } catch (e) {
                          setError("Échec de l'enregistrement de la commune.");
                        }
                      }}
                      style={styles.btnGhost}
                    >
                      Enregistrer
                    </button>
                  </div>
                </label>

                <label style={styles.fieldLabel}>
                  Numéro de licence taxi
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      placeholder="Numéro de licence"
                      value={licenseInput}
                      onChange={(e) => setLicenseInput(e.target.value)}
                      style={{ ...styles.input, flex: 1 }}
                    />
                    <button type="button" onClick={handleLicenseChange} style={styles.btnGhost}>
                      Enregistrer
                    </button>
                  </div>
                  {licenseChangeStatus && (
                    <span style={{ fontSize: 12.5, color: licenseChangeStatus.ok ? "#3BD07A" : "#E5484D" }}>
                      {licenseChangeStatus.text}
                    </span>
                  )}
                </label>

                <label style={styles.fieldLabel}>
                  Ton département de licence (taxi conventionné)
                  <select
                    value={driverDept}
                    onChange={(e) => updateDriverDept(e.target.value)}
                    style={styles.input}
                  >
                    {DEPARTMENT_KM_RATES.map(([code, name, rate]) => (
                      <option key={code} value={code}>
                        {code} — {name} ({rate.toFixed(2)} €/km)
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            {accountSubPanel === "settings" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <button
                  onClick={() => {
                    sharePosition();
                  }}
                  style={{
                    ...styles.btnGhost,
                    borderColor: myPosStatus === "ok" ? "#3BD07A" : "#3A4048",
                    color: myPosStatus === "ok" ? "#3BD07A" : "#F2F4F7",
                    textAlign: "left",
                  }}
                >
                  <Navigation size={14} style={{ marginRight: 8 }} />
                  {myPosStatus === "ok" ? "En service — toucher pour se mettre hors service" : "Se mettre en service"}
                </button>
                {notifPermission !== "unsupported" && (
                  <button
                    onClick={requestNotifPermission}
                    disabled={notifPermission === "granted"}
                    style={{
                      ...styles.btnGhost,
                      borderColor: notifPermission === "granted" ? "#3BD07A" : "#3A4048",
                      color: notifPermission === "granted" ? "#3BD07A" : "#F2F4F7",
                      textAlign: "left",
                    }}
                  >
                    <Siren size={14} style={{ marginRight: 8 }} />
                    {notifPermission === "granted"
                      ? "Notifications activées"
                      : notifPermission === "denied"
                      ? "Notifications bloquées (à réactiver dans les réglages du navigateur)"
                      : "Activer les notifications"}
                  </button>
                )}
              </div>
            )}

            {accountSubPanel === "company" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <label style={styles.fieldLabel}>
                  Nom de la société
                  <input
                    placeholder="Ex: Taxi Dupont SARL"
                    value={companyInput.companyName}
                    onChange={(e) => setCompanyInput({ ...companyInput, companyName: e.target.value })}
                    style={styles.input}
                  />
                </label>
                <label style={styles.fieldLabel}>
                  Numéro SIRET
                  <input
                    placeholder="14 chiffres"
                    value={companyInput.siret}
                    onChange={(e) => setCompanyInput({ ...companyInput, siret: e.target.value })}
                    style={styles.input}
                  />
                </label>
                <label style={styles.fieldLabel}>
                  Adresse de la société
                  <textarea
                    placeholder="Adresse complète"
                    value={companyInput.companyAddress}
                    onChange={(e) => setCompanyInput({ ...companyInput, companyAddress: e.target.value })}
                    style={{ ...styles.input, minHeight: 60 }}
                  />
                </label>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await updateProfileFields(driverName, companyInput);
                      setError("");
                    } catch (e) {
                      setError("Échec de l'enregistrement des informations société.");
                    }
                  }}
                  style={styles.btnPrimary}
                >
                  Enregistrer
                </button>
              </div>
            )}
          </div>
        </div>
      )}


      {showAdminPanel && isAdmin && (
        <div style={styles.modalOverlay} onClick={() => setShowAdminPanel(false)}>
          <div
            style={{ ...styles.modalCard, maxWidth: 500, maxHeight: "80vh" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={styles.modalHeader}>
              <h2 style={{ ...styles.modalTitle, display: "flex", alignItems: "center", gap: 8 }}><Shield size={18} /> Administration</h2>
              <button onClick={() => setShowAdminPanel(false)} style={styles.iconBtn}>
                <X size={16} />
              </button>
            </div>
            <p style={{ color: "#8A9099", fontSize: 13, marginBottom: 16 }}>
              {allKnownDriverNames.length} chauffeur{allKnownDriverNames.length > 1 ? "s" : ""} connu{allKnownDriverNames.length > 1 ? "s" : ""}.
              Bannir un chauffeur le déconnecte immédiatement et l'empêche de se reconnecter.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {allKnownDriverNames
                .sort((a, b) => a.localeCompare(b))
                .map((name) => {
                  const p = profiles[name] || {};
                  const isOnline = positions[name]?.updatedAt && Date.now() - positions[name].updatedAt < 15 * 60 * 1000;
                  return (
                  <div
                    key={name}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      background: "#191C21", border: "1px solid #2A2F36", borderRadius: 8, padding: "10px 12px",
                      opacity: p.deleted ? 0.5 : 1,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>
                        {name} {name === driverName && "(toi)"}{" "}
                        <span style={{ fontSize: 11, fontWeight: 600, color: isOnline ? "#3BD07A" : "#6E757E", display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: isOnline ? "#3BD07A" : "#6E757E", display: "inline-block" }} />
                          {isOnline ? "en ligne" : "hors ligne"}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: "#6E757E" }}>
                        {p.email || "email inconnu"} {p.phone && `· ${p.phone}`}
                        {p.licenseNumber && ` · Licence ${p.licenseNumber}`}
                        {p.commune && ` · ${p.commune}`}
                      </div>
                      {p.deleted ? (
                        <div style={{ fontSize: 12, color: "#E5484D", marginTop: 2 }}>Compte supprimé</div>
                      ) : p.banned && (
                        <div style={{ fontSize: 12, color: "#E5484D", marginTop: 2 }}>
                          Banni {p.bannedReason && `— ${p.bannedReason}`}
                        </div>
                      )}
                    </div>
                    {name !== driverName && (
                      <div style={{ display: "flex", gap: 6 }}>
                        {p.deleted ? (
                          <button
                            onClick={() => restoreDriverAccount(name)}
                            style={{ ...styles.btnGhost, borderColor: "#3BD07A", color: "#3BD07A", fontSize: 12, padding: "6px 10px" }}
                          >
                            Restaurer
                          </button>
                        ) : (
                          <>
                            <button
                              onClick={async () => {
                                if (p.banned) {
                                  await setDriverBanned(name, false);
                                } else {
                                  setBanTarget(name);
                                  setBanReason("");
                                }
                              }}
                              style={{
                                ...styles.btnGhost,
                                borderColor: p.banned ? "#3BD07A" : "#E5484D",
                                color: p.banned ? "#3BD07A" : "#E5484D",
                                fontSize: 12, padding: "6px 10px",
                              }}
                            >
                              {p.banned ? "Réactiver" : "Bannir"}
                            </button>
                            <button
                              onClick={() => setDeleteTarget(name)}
                              style={{ ...styles.btnGhost, borderColor: "#E5484D", color: "#E5484D", fontSize: 12, padding: "6px 10px" }}
                            >
                              Supprimer
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  );
                })}
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div style={styles.modalOverlay} onClick={() => setDeleteTarget(null)}>
          <div style={{ ...styles.modalCard, maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>Supprimer {deleteTarget}</h2>
              <button onClick={() => setDeleteTarget(null)} style={styles.iconBtn}>
                <X size={16} />
              </button>
            </div>
            <p style={{ color: "#8A9099", fontSize: 13, marginBottom: 12 }}>
              Son téléphone et sa commune seront effacés, sa position retirée de la carte, et il ne pourra
              plus jamais se reconnecter tant que tu n'auras pas cliqué "Restaurer". Ses courses passées
              restent visibles dans l'historique.
            </p>
            <div style={styles.modalActions}>
              <button onClick={() => setDeleteTarget(null)} style={styles.btnGhost}>
                Annuler
              </button>
              <button
                onClick={async () => {
                  await deleteDriverAccount(deleteTarget);
                  setDeleteTarget(null);
                }}
                style={{ ...styles.btnPrimary, background: "#E5484D" }}
              >
                Supprimer définitivement
              </button>
            </div>
          </div>
        </div>
      )}

      {banTarget && (
        <div style={styles.modalOverlay} onClick={() => setBanTarget(null)}>
          <div style={{ ...styles.modalCard, maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>Bannir {banTarget}</h2>
              <button onClick={() => setBanTarget(null)} style={styles.iconBtn}>
                <X size={16} />
              </button>
            </div>
            <p style={{ color: "#8A9099", fontSize: 13, marginBottom: 12 }}>
              Ce chauffeur sera déconnecté immédiatement et ne pourra plus se reconnecter tant que tu ne le réactives pas.
            </p>
            <label style={styles.fieldLabel}>
              Raison (optionnel, visible par toi seulement)
              <textarea
                value={banReason}
                onChange={(e) => setBanReason(e.target.value)}
                placeholder="Ex : comportement inapproprié, licence invalide…"
                style={{ ...styles.input, minHeight: 70, width: "100%" }}
              />
            </label>
            <div style={styles.modalActions}>
              <button onClick={() => setBanTarget(null)} style={styles.btnGhost}>
                Annuler
              </button>
              <button
                onClick={async () => {
                  await setDriverBanned(banTarget, true, banReason);
                  setBanTarget(null);
                }}
                style={{ ...styles.btnPrimary, background: "#E5484D" }}
              >
                Confirmer le bannissement
              </button>
            </div>
          </div>
        </div>
      )}

      {showMessagesPanel && (
        <div style={styles.modalOverlay} onClick={() => setShowMessagesPanel(false)}>
          <div style={{ ...styles.modalCard, maxWidth: 420, maxHeight: "80vh" }} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={{ ...styles.modalTitle, display: "flex", alignItems: "center", gap: 8 }}><MessageCircle size={18} /> Messages</h2>
              <button onClick={() => setShowMessagesPanel(false)} style={styles.iconBtn}>
                <X size={16} />
              </button>
            </div>
            {conversations.length === 0 ? (
              <p style={{ color: "#8A9099", fontSize: 14, textAlign: "center", padding: "20px 0" }}>
                Aucune conversation pour l'instant. Elles apparaissent ici dès qu'une course que tu as postée ou prise a un message.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {conversations.map((c) => (
                  <button
                    key={c.rideId}
                    onClick={() => { setChatRideId(c.rideId); setShowMessagesPanel(false); }}
                    style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      background: "#0F1114", border: "1px solid #23272E", borderRadius: 10,
                      padding: "12px 14px", textAlign: "left", cursor: "pointer",
                    }}
                  >
                    <div style={{ overflow: "hidden" }}>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>
                        {c.otherParty || "?"}
                        {c.ride && <span style={{ color: "#8A9099", fontWeight: 400 }}> — {c.ride.depart} → {c.ride.arrivee}</span>}
                      </div>
                      <div style={{
                        color: "#8A9099", fontSize: 13, whiteSpace: "nowrap",
                        overflow: "hidden", textOverflow: "ellipsis", maxWidth: 260,
                      }}>
                        {c.last.senderName === driverName ? "Toi : " : ""}{c.last.text}
                      </div>
                    </div>
                    {c.unread > 0 && (
                      <span style={{ ...styles.navBadge, position: "static" }}>{c.unread > 9 ? "9+" : c.unread}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {chatRideId && (
        <div style={styles.modalOverlay} onClick={() => setChatRideId(null)}>
          <div
            style={{ ...styles.modalCard, display: "flex", flexDirection: "column", height: "70vh" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>Discussion</h2>
              <button onClick={() => setChatRideId(null)} style={styles.iconBtn}>
                <X size={16} />
              </button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, paddingRight: 4 }}>
              {chatMessages.length === 0 && (
                <p style={{ color: "#6E757E", fontSize: 13, textAlign: "center", marginTop: 20 }}>
                  Aucun message pour l'instant.
                </p>
              )}
              {chatMessages.map((m) => {
                const isMe = m.senderName === driverName;
                return (
                  <div
                    key={m.id}
                    style={{
                      alignSelf: isMe ? "flex-end" : "flex-start",
                      maxWidth: "76%",
                      background: isMe ? "#FFB43A" : "#22262C",
                      color: isMe ? "#1A1206" : "#E4E7EB",
                      padding: "13px 15px",
                      borderRadius: isMe ? "16px 16px 5px 16px" : "16px 16px 16px 5px",
                      fontSize: 14,
                      fontWeight: isMe ? 600 : 500,
                      lineHeight: 1.5,
                    }}
                  >
                    {!isMe && <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 2 }}>{m.senderName}</div>}
                    {m.text}
                  </div>
                );
              })}
              <div ref={chatEndRef} />
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12, paddingTop: 12, borderTop: "1px solid #3A4048" }}>
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSendMessage(); }}
                placeholder="Écrire un message…"
                style={{ ...styles.input, flex: 1, minWidth: 0, background: "#22262C", border: "none", borderRadius: 999 }}
              />
              <button
                onClick={handleSendMessage}
                aria-label="Envoyer"
                style={{
                  width: 46, height: 46, borderRadius: "50%", background: "#FFB43A", border: "none",
                  color: "#1A1206", display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0, cursor: "pointer",
                }}
              >
                <Send size={18} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#0F1114",
    color: "#F2F4F7",
    fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    padding: "0 0 40px 0",
    position: "relative",
  },
  gateCard: { maxWidth: 380, margin: "80px auto", background: "#191C21", borderRadius: 14, padding: "32px 28px", textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.5)", border: "1px solid #23272E" },
  logoBadgeLarge: {
    position: "relative", width: 64, height: 64, borderRadius: 18,
    background: "#FFB43A",
    display: "flex", alignItems: "center", justifyContent: "center",
    margin: "0 auto 16px",
  },
  logoBeaconLarge: {
    position: "absolute", top: -4, right: -4, width: 16, height: 16, borderRadius: "50%",
    background: "#3BD07A", border: "3px solid #0F1114",
  },
  logoBadge: {
    position: "relative", width: 38, height: 38, borderRadius: 12,
    background: "#FFB43A",
    display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0,
  },
  gateTitle: { fontFamily: "'Manrope', sans-serif", fontSize: 30, letterSpacing: 0.5, fontWeight: 700, margin: 0 },
  gateSub: { color: "#8A9099", fontSize: 14, marginTop: 10, lineHeight: 1.5 },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 24px", borderBottom: "1px solid #23272E", position: "sticky", top: 0, background: "#131519", zIndex: 10, flexWrap: "wrap", gap: 10 },
  title: { fontFamily: "'Manrope', sans-serif", fontSize: 18, letterSpacing: "-0.01em", fontWeight: 800, margin: 0 },
  headerSubtitle: { fontSize: 12, fontWeight: 500, color: "#8A9099" },
  statusPill: {
    display: "flex", alignItems: "center", gap: 7, padding: "7px 12px", borderRadius: 999,
    border: "1px solid", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "'Manrope', sans-serif",
  },
  statusPillOn: { background: "rgba(59,208,122,0.10)", borderColor: "rgba(59,208,122,0.28)", color: "#3BD07A" },
  statusPillOff: { background: "#22262C", borderColor: "#2A2F36", color: "#8A9099" },
  statusDot: { width: 7, height: 7, borderRadius: "50%", flexShrink: 0 },
  dateFilterRow: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  iconBtn: { background: "#23272E", border: "1px solid #3A4048", color: "#F2F4F7", borderRadius: 8, padding: "8px 10px", cursor: "pointer", display: "flex", alignItems: "center", fontSize: 12 },
  tabs: { display: "flex", gap: 8, padding: "16px 24px", alignItems: "center", flexWrap: "wrap" },
  tab: { background: "transparent", border: "1px solid #3A4048", color: "#8A9099", padding: "8px 14px", borderRadius: 20, cursor: "pointer", fontSize: 13 },
  tabActive: { background: "#FFB43A", color: "#1A1206", borderColor: "#FFB43A", fontWeight: 600 },
  btnPrimary: { background: "#FFB43A", color: "#1A1206", border: "none", padding: "10px 16px", borderRadius: 8, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", fontSize: 14 },
  btnGhost: { background: "transparent", border: "1px solid #3A4048", color: "#F2F4F7", padding: "8px 14px", borderRadius: 8, cursor: "pointer", fontSize: 13 },
  btnClaim: { background: "#3BD07A", color: "#0e2318", border: "none", padding: "8px 14px", borderRadius: 8, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", fontSize: 13 },
  formCard: { margin: "0 24px 20px", background: "#191C21", borderRadius: 14, padding: 18, display: "flex", flexDirection: "column", gap: 14 },
  formRow: { display: "flex", gap: 8, flexWrap: "wrap" },
  formGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 },
  typeChip: { border: "none", padding: "12px 16px", borderRadius: 12, cursor: "pointer", fontSize: 14.5, fontWeight: 700, minHeight: 48 },
  input: { background: "#191C21", border: "1.5px solid #23272E", color: "#F2F4F7", padding: "14px 14px", borderRadius: 10, fontSize: 16.5, outline: "none", minHeight: 50 },
  checkboxRow: { display: "flex", alignItems: "center", gap: 10, fontSize: 14.5, color: "#B8BEC6" },
  fieldLabel: { display: "flex", flexDirection: "column", gap: 7, fontSize: 13.5, color: "#E4E7EB", fontWeight: 700 },
  sectionLabel: {
    fontFamily: "'Manrope', sans-serif", fontSize: 11.5, fontWeight: 700,
    color: "#6E757E", textTransform: "uppercase", letterSpacing: 0.6,
    marginTop: 18, marginBottom: 2,
  },
  sectionDivider: { height: 1, background: "#23272E", margin: "18px 0 0" },
  categoryBtn: {
    display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
    background: "#0F1114", border: "1.5px solid #23272E", borderRadius: 12,
    padding: "16px 16px", minHeight: 56, fontSize: 15.5, fontWeight: 700, color: "#F2F4F7",
    cursor: "pointer", textAlign: "left",
  },
  categoryBtnLeft: { display: "flex", alignItems: "center", gap: 12 },
  togglePill: {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
    border: "1.5px solid #3A4048", background: "transparent", color: "#B8BEC6",
    padding: "13px 16px", borderRadius: 12, cursor: "pointer", fontSize: 14.5, fontWeight: 600,
    minHeight: 50, flex: 1,
  },
  collapsibleHeader: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    background: "transparent", border: "none", color: "#8A9099", cursor: "pointer",
    fontSize: 14, fontWeight: 600, padding: "6px 2px", width: "100%",
  },
  swapBtn: {
    position: "absolute", right: -6, top: "50%", transform: "translateY(-50%)", zIndex: 5,
    background: "#FFB43A", color: "#1A1206", border: "none", borderRadius: "50%",
    width: 32, height: 32, cursor: "pointer", fontSize: 14, fontWeight: 700,
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  tpmrBadge: {
    fontSize: 10, fontWeight: 700, color: "#1A1206", background: "#8A9099",
    padding: "2px 6px", borderRadius: 4, marginRight: 4,
  },
  suggestionBox: {
    position: "absolute",
    top: "100%",
    left: 0,
    right: 0,
    background: "#191C21",
    border: "1.5px solid #3A4048",
    borderRadius: 10,
    marginTop: 6,
    maxHeight: 260,
    overflowY: "auto",
    zIndex: 50,
    boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
  },
  suggestionItem: {
    display: "flex",
    alignItems: "center",
    padding: "14px 14px",
    fontSize: 15,
    color: "#F2F4F7",
    cursor: "pointer",
    borderBottom: "1px solid #23272E",
    minHeight: 48,
  },
  photoPreview: { maxWidth: 160, maxHeight: 160, borderRadius: 8, display: "block", border: "1px solid #3A4048" },
  photoRemoveBtn: {
    position: "absolute", top: -8, right: -8, background: "#E5484D", color: "#fff",
    border: "none", borderRadius: "50%", width: 24, height: 24, display: "flex",
    alignItems: "center", justifyContent: "center", cursor: "pointer",
  },
  cardThumb: { width: "100%", maxHeight: 140, objectFit: "cover", borderRadius: 8, marginBottom: 10, display: "block" },
  modalPhoto: { width: "100%", borderRadius: 10, marginTop: 12, display: "block" },
  board: { padding: "0 24px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 },
  mapContainer: { width: "100%", height: "45vh", minHeight: 320, maxHeight: 460, borderRadius: 12, border: "1px solid #2A2F36", overflow: "hidden", position: "relative", zIndex: 1, touchAction: "none" },
  empty: { color: "#6E757E", padding: "40px 0", textAlign: "center" },
  emptyState: { padding: "50px 24px", textAlign: "center", maxWidth: 380, margin: "0 auto" },
  emptyIcon: {
    width: 72, height: 72, borderRadius: "50%", background: "#23272E",
    display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px",
    border: "1px solid #2A2F36",
  },
  emptyTitle: { color: "#F2F4F7", fontSize: 16, fontWeight: 600, margin: "0 0 8px" },
  emptySub: { color: "#6E757E", fontSize: 13, lineHeight: 1.5, margin: 0 },
  card: { background: "#191C21", borderRadius: 18, padding: "15px 16px", position: "relative", border: "1px solid #23272E" },
  urgentBadge: { position: "absolute", top: -8, right: 12, background: "#E5484D", color: "#fff", fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 6, display: "flex", alignItems: "center" },
  cardHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  typeTag: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 700, padding: "4px 8px", borderRadius: 6, display: "flex", alignItems: "center", letterSpacing: "0.10em", textTransform: "uppercase" },
  statusTag: { fontSize: 12, fontWeight: 600 },
  metaRow: { display: "flex", gap: 14, fontSize: 12, color: "#8A9099", marginBottom: 8, flexWrap: "wrap" },
  metaItem: { display: "flex", alignItems: "center", gap: 4 },
  tarifTag: {
    display: "flex", alignItems: "center", fontSize: 20, fontWeight: 800,
    fontFamily: "'Manrope', sans-serif", letterSpacing: "-0.02em",
    fontVariantNumeric: "tabular-nums", color: "#F2F4F7",
  },
  contactBtn: {
    flex: 1, textAlign: "center", background: "#23272E", border: "1px solid #3A4048",
    color: "#F2F4F7", padding: "9px 12px", borderRadius: 8, fontSize: 13, fontWeight: 600,
    textDecoration: "none",
  },
  notes: { fontSize: 12, color: "#B8BEC6", background: "#22262C", padding: "8px 10px", borderRadius: 6, marginBottom: 10 },
  priorityBanner: { display: "flex", alignItems: "center", fontSize: 11, color: "#FFB43A", background: "rgba(255,180,58,0.1)", border: "1px solid rgba(255,180,58,0.3)", padding: "6px 10px", borderRadius: 6, marginBottom: 10 },
  pendingBanner: { fontSize: 12, color: "#FFB43A", background: "rgba(255,180,58,0.1)", border: "1px solid rgba(255,180,58,0.3)", padding: "8px 10px", borderRadius: 6, marginBottom: 10 },
  cardFooter: { display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #2A2F36", paddingTop: 10 },
  postedBy: { fontSize: 11, color: "#6E757E" },
  hintBanner: { margin: "0 24px 16px", background: "#23272E", padding: "10px 14px", borderRadius: 8, fontSize: 13, color: "#8A9099" },
  gainsCard: {
    padding: 18, borderRadius: 20, background: "#191C21", border: "1px solid #23272E",
    display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12,
  },
  gainsLabel: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, fontWeight: 600, letterSpacing: "0.12em", color: "#8A9099", textTransform: "uppercase" },
  gainsAmount: { fontSize: 32, fontWeight: 800, letterSpacing: "-0.02em", color: "#F2F4F7" },
  gainsCount: { fontSize: 13, fontWeight: 600, color: "#8A9099", textAlign: "right", lineHeight: 1.3 },
  planningGap: { display: "flex", alignItems: "center", fontSize: 12, padding: "6px 12px", margin: "8px 0", border: "1px dashed #3A4048", borderRadius: 6 },
  errorBanner: { margin: "0 24px 16px", background: "#E5484D", padding: "10px 14px", borderRadius: 8, display: "flex", justifyContent: "space-between", fontSize: 13 },
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 100 },
  modalCard: { background: "#23272E", borderRadius: 14, padding: 24, maxWidth: 440, width: "100%", maxHeight: "85vh", overflowY: "auto", overflowX: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  modalTitle: { fontSize: 18, margin: "0 0 16px", color: "#F2F4F7" },
  modalGrid: { display: "flex", flexDirection: "column", gap: 10 },
  navRow: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 },
  navBtn: {
    display: "flex", alignItems: "center", gap: 8,
    background: "#0F1114", border: "1.5px solid #3A4048", color: "#F2F4F7",
    padding: "9px 14px 9px 9px", borderRadius: 24, fontSize: 14, fontWeight: 700,
    textDecoration: "none", whiteSpace: "nowrap", flex: 1, justifyContent: "center",
  },
  navBtnDot: {
    display: "flex", alignItems: "center", justifyContent: "center",
    width: 24, height: 24, borderRadius: "50%", fontSize: 12, fontWeight: 800,
    color: "#fff", flexShrink: 0,
  },
  navBtnWaze: { borderColor: "#05C8F7" },
  navBtnMaps: { borderColor: "#4285F4" },
  modalRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 14 },
  modalActions: { display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", marginTop: 20, paddingTop: 16, borderTop: "1px solid #3A4048" },
  bottomNav: {
    position: "fixed", bottom: 0, left: 0, right: 0, height: 64,
    background: "#131519", borderTop: "1px solid #23272E",
    alignItems: "center", justifyContent: "space-around",
    zIndex: 90, paddingBottom: "env(safe-area-inset-bottom, 0px)",
  },
  bottomNavBtn: {
    background: "none", border: "none", display: "flex", flexDirection: "column",
    alignItems: "center", gap: 3, cursor: "pointer", padding: "6px 10px", minWidth: 56,
  },
  bottomNavLabel: { fontSize: 11, fontWeight: 600 },
  navBadge: {
    position: "absolute", top: 2, right: "28%",
    background: "#E5484D", color: "#fff", fontSize: 10, fontWeight: 800,
    minWidth: 16, height: 16, borderRadius: 8, display: "flex",
    alignItems: "center", justifyContent: "center", padding: "0 3px",
    border: "1.5px solid #131519",
  },
  bottomNavFabSlot: { width: 58, flexShrink: 0 },
  bottomNavFabFloating: {
    position: "fixed", bottom: 34, left: "50%", transform: "translateX(-50%)",
    background: "#FFB43A", border: "3px solid #0F1114", borderRadius: "50%",
    width: 58, height: 58, alignItems: "center", justifyContent: "center",
    cursor: "pointer", boxShadow: "0 10px 24px rgba(255,180,58,0.28)", zIndex: 91,
  },
  priorityAlertOverlay: {
    position: "fixed", inset: 0, zIndex: 300,
    background: "rgba(10,11,15,0.88)", backdropFilter: "blur(3px)",
    display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
  },
  priorityAlertCard: {
    width: "100%", maxWidth: 420, background: "#191C21",
    border: "2px solid #FFB43A", borderRadius: 18, padding: 18,
    boxShadow: "0 0 40px rgba(255,180,58,0.35)",
    maxHeight: "88vh", overflowY: "auto",
  },
  priorityAlertTop: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
  },
  priorityAlertPill: {
    background: "#FFB43A", color: "#1A1206", fontWeight: 800,
    fontSize: 12, letterSpacing: "0.04em", padding: "6px 10px", borderRadius: 999,
  },
  priorityAlertSub: {
    color: "#8A9099", fontSize: 13, margin: "10px 0 14px",
  },
  priorityAlertBody: {
    background: "#0F1114", border: "1px solid #23272E",
    borderRadius: 12, padding: 14, marginBottom: 16,
  },
  priorityAlertRoute: {
    display: "flex", flexDirection: "column", gap: 6, fontSize: 15, lineHeight: 1.4,
  },
  priorityAlertMeta: {
    display: "flex", flexWrap: "wrap", gap: 12, marginTop: 12,
    fontSize: 13, color: "#8A9099", alignItems: "center",
  },
  priorityAlertActions: { display: "flex", gap: 10 },
  pullBanner: {
    position: "fixed", top: 0, left: 0, right: 0, zIndex: 200,
    background: "#FFB43A", color: "#1A1206", textAlign: "center",
    padding: "10px 0", fontSize: 13, fontWeight: 700,
  },
};
