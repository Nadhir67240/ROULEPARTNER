import { Car, Stethoscope, Euro } from "lucide-react";
import { todayKey } from "./dates";

export const TYPES = [
  { id: "taxi", label: "Taxi conventionné", color: "#FFB43A", icon: Car },
  { id: "taxi_payant", label: "Course payante", color: "#8FB3F5", icon: Euro },
  { id: "vsl", label: "VSL", color: "#3BD07A", icon: Car },
  { id: "ambulance", label: "Ambulance", color: "#E86E5E", icon: Stethoscope },
];

export const TRAJET_TYPES = [
  { id: "aller", label: "Aller" },
  { id: "retour", label: "Retour" },
  { id: "allerRetour", label: "Aller-retour" },
];

export function trajetLabel(id) {
  return (TRAJET_TYPES.find((t) => t.id === id) || TRAJET_TYPES[0]).label;
}

// Fenêtre de priorité : à la publication, seuls les chauffeurs les plus proches
// peuvent prendre la course. Passé ce délai, elle s'ouvre à tout le monde.
export const PRIORITY_WINDOW_MS = 15 * 1000;

// Rayon autour de la prise en charge à l'intérieur duquel un chauffeur est prioritaire —
// doit rester identique à PRIORITY_RADIUS_KM dans functions/index.js, qui fait foi pour
// l'attribution réelle (règles de sécurité Firestore). Cette valeur ne sert ici qu'à
// afficher l'alerte de priorité et verrouiller "Je la prends" instantanément dès l'arrivée
// de la course, avant que le serveur n'ait eu le temps d'écrire sa propre liste sur le
// document (voir r.priorityDrivers, qui prend le relais dès qu'il existe et fait foi).
export const PRIORITY_RADIUS_KM = 1.0;

// Une position n'est prise en compte que si elle est récente — même règle que côté serveur.
export const POSITION_FRESH_MS = 15 * 60 * 1000;

// Nombre maximum de chauffeurs prioritaires simultanés.
export const PRIORITY_MAX_DRIVERS = 3;

// Vitesse moyenne estimée pour convertir une distance à vol d'oiseau en temps de trajet.
// Approximation, pas un vrai calcul d'itinéraire routier.
export const AVG_SPEED_KMH = 32;

// Délai laissé au posteur pour confirmer avant qu'une demande soit acceptée automatiquement.
export const CLAIM_CONFIRM_WINDOW_MS = 30 * 1000;

// Les courses terminées depuis plus de X jours sont purgées automatiquement (y compris leur photo).
// Conservées 1 an pour que le calendrier "Mes courses" garde l'historique.
export const AUTO_PURGE_DAYS = 365;

// Doit correspondre exactement à l'email utilisé dans les règles Firestore.
export const ADMIN_EMAIL = "taxi-vsl67@hotmail.com";

export const emptyForm = {
  type: "taxi",
  patient: "",
  patientTel: "",
  depart: "",
  arrivee: "",
  heure: "",
  heureRetour: "",
  date: todayKey(0),
  trajet: "aller",
  departLat: null,
  departLng: null,
  departCity: "",
  departDept: "",
  arriveeLat: null,
  arriveeLng: null,
  arriveeCity: "",
  arriveeDept: "",
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

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function typeMeta(id) {
  return TYPES.find((t) => t.id === id) || TYPES[0];
}

// Fond teinté à faible opacité pour la pastille de type (texte de la même teinte que le fond) —
// une pastille sobre plutôt qu'un badge plein, l'ambre reste réservé aux actions.
export function tintBg(hex, alpha) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Une couleur distincte par étape de la course, pour la lire d'un coup d'œil.
export const STATUS_COLORS = {
  disponible: "#3BD07A", // vert : à prendre
  en_attente: "#FFB43A", // orange : demande en cours de confirmation
  prise: "#4FA3FF",      // bleu : attribuée, pas encore démarrée
  en_cours: "#B18CFF",   // violet : patient à bord
  terminee: "#6E757E",   // gris : finie
};
export const statusColor = (status) => STATUS_COLORS[status] || "#FFB43A";
