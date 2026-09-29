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

// Adresses récemment sélectionnées (hôpitaux, cliniques habituels...) — stockées en local
// pour être proposées instantanément dès le focus du champ, avant même de taper.
export const RECENT_ADDRESSES_KEY = "rp-recent-addresses";
export const MAX_RECENT_ADDRESSES = 6;

export function loadRecentAddresses() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_ADDRESSES_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    return [];
  }
}

export function saveRecentAddress(entry) {
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
