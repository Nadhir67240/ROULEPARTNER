export function formatPostedAt(ts) {
  const d = new Date(ts);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const mins = String(d.getMinutes()).padStart(2, "0");
  return `${day}/${month} à ${hours}:${mins}`;
}

export function dateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function todayKey(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function timePlusMinutes(mins = 0) {
  const d = new Date(Date.now() + mins * 60000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatRideDate(dateStr) {
  if (!dateStr) return "";
  if (dateStr === todayKey(0)) return "aujourd'hui";
  if (dateStr === todayKey(1)) return "demain";
  return dateStr.split("-").reverse().join("/");
}

export const FRENCH_MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
export function formatDayMonth(dateStr) {
  const [, m, d] = dateStr.split("-").map(Number);
  return `${d} ${FRENCH_MONTHS[m - 1]}`;
}

export const FRENCH_WEEKDAYS_SHORT = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];

// Helpers du calendrier "Mes courses" — on travaille en clés "AAAA-MM-JJ" (même format
// que ride.date) en heure locale, pour éviter les décalages de fuseau de toISOString().
export function keyFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function dateFromKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}
export function addDaysKey(key, n) {
  const d = dateFromKey(key);
  d.setDate(d.getDate() + n);
  return keyFromDate(d);
}
// Semaine du lundi au dimanche, comme en France.
export function startOfWeekKey(key) {
  const d = dateFromKey(key);
  return addDaysKey(key, -((d.getDay() + 6) % 7));
}

// Badge de timing d'une course : le chauffeur doit voir d'un coup d'oeil si
// c'est pour tout de suite (rouge, pulse), pour bientôt aujourd'hui (orange),
// ou pour un autre jour (bleu, avec le jour de la semaine) — plutôt que de
// devoir lire la date/heure en petit texte dans les détails.
export function rideTimingBadge(r) {
  if (!r.date || !r.heure) return null;
  const [h, mnt] = r.heure.split(":").map(Number);
  const [y, mo, d] = r.date.split("-").map(Number);
  if ([h, mnt, y, mo, d].some((n) => Number.isNaN(n))) return null;
  const scheduled = new Date(y, mo - 1, d, h, mnt).getTime();
  const diffMin = Math.round((scheduled - Date.now()) / 60000);
  const isToday = r.date === todayKey(0);
  const isTomorrow = r.date === todayKey(1);

  if (isToday) {
    if (diffMin <= 15) {
      return { label: diffMin <= 0 ? "Tout de suite" : `Dans ${diffMin} min`, bg: "#E5484D", color: "#fff", pulse: true };
    }
    if (diffMin <= 60) {
      return { label: `Dans ${diffMin} min · ${r.heure}`, bg: "#FFB43A", color: "#1A1206", pulse: false };
    }
    return { label: `Aujourd'hui à ${r.heure}`, bg: "#2A2F36", color: "#E4E7EB", pulse: false };
  }
  if (isTomorrow) {
    return { label: `Demain à ${r.heure}`, bg: "#5B8DEF", color: "#fff", pulse: false };
  }
  const weekday = FRENCH_WEEKDAYS_SHORT[new Date(y, mo - 1, d).getDay()];
  return { label: `${weekday} ${formatDayMonth(r.date)} à ${r.heure}`, bg: "#5B8DEF", color: "#fff", pulse: false };
}

// Plage lundi→dimanche de la semaine en cours, pour le filtre "Cette semaine".
export function thisWeekRange() {
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
