// Brouillon de la course en cours de saisie, gardé sur le téléphone : un rafraîchissement
// (volontaire ou "tirer vers le bas" par erreur) rouvre le formulaire là où on en était.
// Au-delà de 12 h, le brouillon est considéré comme abandonné.
export const RIDE_DRAFT_KEY = "rp-ride-draft";
export const RIDE_DRAFT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export function loadRideDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(RIDE_DRAFT_KEY));
    if (!d || !d.form || Date.now() - d.savedAt > RIDE_DRAFT_MAX_AGE_MS) return null;
    return d;
  } catch (e) {
    return null;
  }
}
export function saveRideDraft(draft) {
  try {
    localStorage.setItem(RIDE_DRAFT_KEY, JSON.stringify(draft));
  } catch (e) {
    // Stockage plein (photo/document trop lourds) : on garde au moins le reste de la saisie.
    try {
      localStorage.setItem(RIDE_DRAFT_KEY, JSON.stringify({
        ...draft, form: { ...draft.form, photo: null, document: null, documentName: "" },
      }));
    } catch (e2) {
      // ignore
    }
  }
}
export function clearRideDraft() {
  try {
    localStorage.removeItem(RIDE_DRAFT_KEY);
  } catch (e) {
    // ignore
  }
}

// Adresses déjà utilisées (hôpitaux, cliniques habituels...) — stockées en local pour être
// proposées instantanément dès le focus du champ, puis filtrées en direct pendant la saisie,
// sans attendre le réseau. Chaque entrée compte ses utilisations (`count`) pour faire remonter
// les adresses habituelles ; les favoris épinglés (`pinned`) restent en tête et ne sont jamais
// évincés par les nouvelles adresses.
export const RECENT_ADDRESSES_KEY = "rp-recent-addresses";
export const MAX_RECENT_ADDRESSES = 30;
// Nombre d'adresses proposées au focus du champ vide (favoris + plus utilisées).
export const RECENT_ADDRESSES_SHOWN = 8;

// Ordre d'affichage : favoris d'abord, puis par nombre d'utilisations, puis les plus récentes.
function sortAddresses(list) {
  return [...list].sort((a, b) =>
    (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
    || (b.count || 1) - (a.count || 1)
    || (b.usedAt || 0) - (a.usedAt || 0)
  );
}

function storeAddresses(list) {
  try {
    localStorage.setItem(RECENT_ADDRESSES_KEY, JSON.stringify(list));
  } catch (e) {
    // Stockage indisponible (navigation privée...) : tant pis, pas bloquant.
  }
  return list;
}

export function loadRecentAddresses() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_ADDRESSES_KEY) || "[]");
    return Array.isArray(raw) ? sortAddresses(raw) : [];
  } catch (e) {
    return [];
  }
}

export function saveRecentAddress(entry) {
  const current = loadRecentAddresses();
  const prev = current.find((r) => r.address === entry.address);
  const updated = {
    ...entry,
    recent: true,
    pinned: !!prev?.pinned,
    count: (prev?.count || 0) + 1,
    usedAt: Date.now(),
  };
  const others = current.filter((r) => r.address !== entry.address);
  // Au-delà de la limite, on évince d'abord les adresses non épinglées les moins utilisées.
  const pinned = others.filter((r) => r.pinned);
  const unpinned = others.filter((r) => !r.pinned);
  const room = Math.max(0, MAX_RECENT_ADDRESSES - 1 - pinned.length);
  const kept = sortAddresses(unpinned).slice(0, room);
  return storeAddresses(sortAddresses([updated, ...pinned, ...kept]));
}

// Épingle/désépingle une adresse ; une adresse jamais utilisée (ex: un hôpital du catalogue)
// est ajoutée directement en favori.
export function toggleAddressPinned(entry) {
  const current = loadRecentAddresses();
  if (!current.some((r) => r.address === entry.address)) {
    const { address, lat, lng, city, dept } = entry;
    return storeAddresses(sortAddresses([{ address, lat, lng, city, dept, recent: true, pinned: true, count: 0, usedAt: Date.now() }, ...current]));
  }
  return storeAddresses(sortAddresses(current.map((r) => (r.address === entry.address ? { ...r, pinned: !r.pinned } : r))));
}
