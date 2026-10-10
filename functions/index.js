const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
// Les événements Firebase Auth (création / suppression de compte) n'existent qu'en v1.
const functionsV1 = require("firebase-functions/v1");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Europe/Paris : garde les fonctions près des chauffeurs, ça réduit la latence.
setGlobalOptions({ region: "europe-west1", maxInstances: 10 });

// Doit correspondre exactement à l'email admin utilisé dans firestore.rules et App.jsx.
const ADMIN_EMAIL = "taxi-vsl67@hotmail.com";

// --- Ces valeurs doivent rester alignées avec celles de src/App.jsx ---
const PRIORITY_WINDOW_MS = 30 * 1000;
const PRIORITY_RADIUS_KM = 1.0;
const PRIORITY_MAX_DRIVERS = 3;

// Une position n'est prise en compte que si elle est récente : un chauffeur
// dont le téléphone n'a rien envoyé depuis 15 min n'est probablement plus
// en service, inutile de lui réserver une course en priorité.
const POSITION_FRESH_MS = 15 * 60 * 1000;

function distanceKm(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function ridePickupCoords(ride) {
  if (ride.departLat != null && ride.departLng != null) {
    return { lat: ride.departLat, lng: ride.departLng };
  }
  if (ride.lat != null && ride.lng != null) return { lat: ride.lat, lng: ride.lng };
  return null;
}

// Même règle que côté appli : les chauffeurs situés à moins de
// PRIORITY_RADIUS_KM de la prise en charge, les plus proches d'abord, plafonné
// à 3. Si personne n'est dans le rayon, la liste est vide et la course part
// tout de suite à tout le monde.
function computePriorityDrivers(ride, positions) {
  const origin = ridePickupCoords(ride);
  if (!origin) return [];
  const now = Date.now();
  const candidates = [];
  for (const [name, pos] of Object.entries(positions)) {
    if (name === ride.postedBy) continue;
    if (pos.updatedAt && now - pos.updatedAt > POSITION_FRESH_MS) continue;
    const d = distanceKm(origin, pos);
    if (d != null && d <= PRIORITY_RADIUS_KM) candidates.push({ name, dist: d });
  }
  candidates.sort((a, b) => a.dist - b.dist);
  return candidates.slice(0, PRIORITY_MAX_DRIVERS);
}

async function loadPositions() {
  const snap = await db.collection("positions").get();
  const positions = {};
  snap.forEach((d) => {
    positions[d.id] = d.data();
  });
  return positions;
}

async function tokensFor(driverNames) {
  const out = [];
  await Promise.all(
    driverNames.map(async (name) => {
      const doc = await db.collection("fcmTokens").doc(name).get();
      const token = doc.exists ? doc.data().token : null;
      // Log temporaire pour diagnostiquer les push qui n'arrivent jamais : permet de
      // voir si le token existe côté serveur avant même d'essayer l'envoi FCM.
      console.log(`tokensFor: "${name}" -> doc exists=${doc.exists}, token=${token ? "present" : "absent"}`);
      if (token) out.push({ name, token });
    })
  );
  return out;
}

// Tous les chauffeurs ayant activé les notifications, qu'ils partagent leur
// position ou non. C'est volontairement plus large que la liste des positions :
// un chauffeur qui n'a pas activé le GPS ne peut pas être prioritaire, mais il
// doit quand même être prévenu qu'une course est disponible.
async function allTokensExcept(excludedNames) {
  const snap = await db.collection("fcmTokens").get();
  const out = [];
  snap.forEach((d) => {
    if (excludedNames.includes(d.id)) return;
    const token = d.data().token;
    if (token) out.push({ name: d.id, token });
  });
  return out;
}

// Envoie le push et nettoie au passage les jetons devenus invalides
// (appli désinstallée, navigateur réinitialisé...), sinon la collection
// se remplit de jetons morts au fil des mois.
async function sendTo(entries, payload) {
  if (entries.length === 0) {
    console.log("sendTo: no token entries, nothing to send.");
    return;
  }
  const res = await admin.messaging().sendEachForMulticast({
    tokens: entries.map((e) => e.token),
    notification: payload.notification,
    data: payload.data,
    webpush: {
      // Sans l'en-tête Urgency, le service de push (celui de Chrome sur Android
      // en particulier) traite la notification comme "normal" et peut la
      // retarder de plusieurs minutes en mode Doze/économie de batterie. "high"
      // force une livraison immédiate même téléphone en veille.
      headers: { Urgency: "high" },
      notification: {
        icon: "/icon-192.png",
        // Android n'affiche que la transparence du badge (barre d'état) : il faut un
        // dessin blanc sur fond transparent, sinon on obtient un carré blanc.
        badge: "/badge-96.png",
        requireInteraction: payload.requireInteraction === true,
        tag: payload.data.rideId,
      },
      fcmOptions: { link: "/" },
    },
  });

  console.log(
    `sendTo: ${res.successCount} succeeded, ${res.failureCount} failed, for [${entries.map((e) => e.name).join(", ")}]`
  );
  const stale = [];
  res.responses.forEach((r, i) => {
    const code = r.error && r.error.code;
    if (code) {
      console.log(`sendTo: failure for "${entries[i].name}": ${code} — ${r.error.message}`);
    }
    if (
      code === "messaging/registration-token-not-registered" ||
      code === "messaging/invalid-registration-token"
    ) {
      stale.push(entries[i].name);
    }
  });
  await Promise.all(
    stale.map((name) => db.collection("fcmTokens").doc(name).delete().catch(() => {}))
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.notifyNewRide = onDocumentCreated(
  // La fonction attend toute la fenêtre de priorité (30 s) avant de prévenir les autres : marge large.
  { document: "rides/{rideId}", timeoutSeconds: 120 },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const ride = snap.data();
    if (!ride || ride.status !== "disponible") return;

    const positions = await loadPositions();
    const priority = computePriorityDrivers(ride, positions);
    const priorityNames = priority.map((p) => p.name);
    const shared = priority.length > 1;

    // Écrit la liste des chauffeurs prioritaires (et la fin de la fenêtre) directement sur le
    // document, le plus tôt possible après la création. C'est cette valeur, écrite par une
    // Cloud Function de confiance (donc jamais falsifiable par un client), que les règles de
    // sécurité Firestore utilisent pour interdire réellement à un chauffeur non prioritaire de
    // prendre la course avant tout le monde — l'app cliente ne faisait jusqu'ici que masquer le
    // bouton, sans empêcher la prise via un appel direct à Firestore.
    await snap.ref.update({
      priorityDrivers: priorityNames,
      priorityUntil: (ride.createdAt || Date.now()) + PRIORITY_WINDOW_MS,
    });

    const route = `${ride.depart} → ${ride.arrivee}`;
    const baseData = {
      rideId: event.params.rideId,
      depart: String(ride.depart || ""),
      arrivee: String(ride.arrivee || ""),
      heure: String(ride.heure || ""),
    };

    // 1) Les chauffeurs prioritaires sont prévenus tout de suite.
    if (priorityNames.length > 0) {
      const entries = await tokensFor(priorityNames);
      await sendTo(entries, {
        notification: {
          title: "⭐ Course prioritaire pour toi",
          body: shared
            ? `${route} — premier arrivé, premier servi !`
            : `${route} — tu es le plus proche.`,
        },
        data: { ...baseData, priority: "true", shared: String(shared) },
        requireInteraction: true,
      });
    }

    // 2) Après la fenêtre de priorité, la course s'ouvre à tout le monde.
    //    On attend ici plutôt que de tout envoyer d'un coup : prévenir les
    //    autres immédiatement reviendrait à leur annoncer une course qu'ils
    //    n'ont pas encore le droit de prendre.
    //    S'il n'y avait aucun chauffeur prioritaire (personne en service à
    //    proximité), inutile d'attendre : la course est ouverte tout de suite.
    if (priorityNames.length > 0) {
      await sleep(PRIORITY_WINDOW_MS);

      // La course a pu être prise pendant l'attente : dans ce cas, on n'envoie rien.
      const fresh = await snap.ref.get();
      if (!fresh.exists || fresh.data().status !== "disponible") return;
    }

    const others = await allTokensExcept([ride.postedBy, ...priorityNames]);
    if (others.length === 0) return;

    await sendTo(others, {
      notification: {
        title: ride.urgent ? "🚨 Course urgente disponible" : "Nouvelle course disponible",
        body: `${route} — ${ride.heure || ""}`.trim(),
      },
      data: { ...baseData, priority: "false", shared: "false" },
    });
  }
);

// Prévient le posteur quand sa course démarre ou se termine. Reprend ce que faisait
// l'ancien onRideWrite (index.js.js, racine, jamais nettoyé de la prod) — portée ici pour
// pouvoir enfin supprimer ce doublon.
exports.notifyRideStatusChange = onDocumentUpdated(
  { document: "rides/{rideId}", timeoutSeconds: 30 },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    if (!after || !before || before.status === after.status) return;

    // "disponible" ne doit déclencher une notif que dans le cas précis d'un relâchement
    // (prise -> disponible) : un refus de demande (en_attente -> disponible) est déjà
    // l'action du posteur lui-même, inutile de le notifier de son propre geste.
    const isRelease = before.status === "prise" && after.status === "disponible";
    if (!isRelease && !["en_attente", "en_cours", "terminee"].includes(after.status)) return;

    const titles = {
      disponible: "😬 Un chauffeur a relâché ta course",
      en_attente: "🙋 Un chauffeur veut prendre ta course",
      en_cours: "🚗 Ta course a démarré",
      terminee: "✅ Ta course est terminée",
    };
    const bodies = {
      disponible: `${before.takenBy || "?"} — ${after.depart} → ${after.arrivee}`,
      en_attente: `${after.pendingBy} — ${after.depart} → ${after.arrivee}`,
      en_cours: `${after.depart} → ${after.arrivee} — prise par ${after.takenBy || "?"}`,
      terminee: `${after.depart} → ${after.arrivee} — prise par ${after.takenBy || "?"}`,
    };

    const entries = await tokensFor([after.postedBy]);
    await sendTo(entries, {
      notification: {
        title: titles[after.status],
        body: bodies[after.status],
      },
      data: {
        rideId: event.params.rideId,
        depart: String(after.depart || ""),
        arrivee: String(after.arrivee || ""),
        heure: String(after.heure || ""),
      },
    });
  }
);

// --- Rappel avant la prise en charge ---
// Toutes les 5 min, rappelle au chauffeur qui a pris une course (statut "prise", pas encore
// démarrée) que la prise en charge approche. Un seul rappel par course (reminderSentAt).
const REMINDER_BEFORE_MS = 30 * 60 * 1000;
// Pas de rappel si la prise en charge est dans moins de 2 min : le chauffeur est déjà dessus.
const REMINDER_MIN_LEAD_MS = 2 * 60 * 1000;

// ride.date ("AAAA-MM-JJ") + ride.heure ("HH:MM") sont saisis à l'heure de Paris ; le serveur
// tourne en UTC. On calcule le décalage de Paris à cette date (heure d'été/hiver comprise).
function parisTimeToUtcMs(dateStr, timeStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const [hh, mm] = String(timeStr).split(":").map(Number);
  if ([y, m, d, hh, mm].some((n) => !Number.isFinite(n))) return null;
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(guess));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const guessAsParis = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return guess - (guessAsParis - guess);
}

async function sendPickupReminders(now = Date.now()) {
  const snap = await db.collection("rides").where("status", "==", "prise").get();
  const due = [];
  snap.forEach((doc) => {
    const r = doc.data();
    if (!r.takenBy || !r.date || !r.heure || r.reminderSentAt) return;
    const pickupAt = parisTimeToUtcMs(r.date, r.heure);
    if (pickupAt == null) return;
    const lead = pickupAt - now;
    if (lead > REMINDER_MIN_LEAD_MS && lead <= REMINDER_BEFORE_MS) due.push({ doc, r, lead });
  });

  for (const { doc, r, lead } of due) {
    // Marqué AVANT l'envoi : si l'envoi échoue, on ne spamme pas le chauffeur toutes les 5 min.
    await doc.ref.update({ reminderSentAt: now });
    const minutes = Math.max(1, Math.round(lead / 60000));
    const entries = await tokensFor([r.takenBy]);
    await sendTo(entries, {
      notification: {
        title: `⏰ Prise en charge dans ${minutes} min`,
        body: `${r.heure} — ${r.depart} → ${r.arrivee}${r.patient ? ` (${r.patient})` : ""}`,
      },
      data: {
        rideId: doc.id,
        depart: String(r.depart || ""),
        arrivee: String(r.arrivee || ""),
        heure: String(r.heure || ""),
      },
      requireInteraction: true,
    }).catch((e) => console.error(`rappel ${doc.id}:`, e.message));
  }
  return due.map((d) => d.doc.id);
}

exports.remindUpcomingRides = onSchedule(
  { schedule: "every 5 minutes", timeZone: "Europe/Paris", timeoutSeconds: 60 },
  async () => {
    const sent = await sendPickupReminders();
    if (sent.length) console.log(`remindUpcomingRides: ${sent.length} rappel(s) — ${sent.join(", ")}`);
  }
);
// Prévient l'admin à chaque nouvelle inscription de chauffeur. Déclenchée par la création
// du compte Firebase Auth et non plus par celle de la fiche "profiles" : l'écriture de la
// fiche peut échouer sans bruit (nom déjà pris…), et l'admin n'était alors jamais prévenu.
exports.notifyNewSignup = functionsV1
  .region("europe-west1")
  .runWith({ timeoutSeconds: 60 })
  .auth.user()
  .onCreate(async (user) => {
    if (user.email === ADMIN_EMAIL) return;
    // signUp() renseigne le nom juste après la création du compte, et supprime le compte
    // si la licence est déjà prise : on attend un peu puis on relit le compte.
    await sleep(10 * 1000);
    let fresh;
    try {
      fresh = await admin.auth().getUser(user.uid);
    } catch (e) {
      console.log(`notifyNewSignup: compte ${user.uid} supprimé entre-temps, pas de notification.`);
      return;
    }
    const who = fresh.displayName || fresh.email || "Un chauffeur";

    const adminSnap = await db.collection("profiles").where("email", "==", ADMIN_EMAIL).limit(1).get();
    if (adminSnap.empty) {
      console.log("notifyNewSignup: fiche admin introuvable, notification impossible.");
      return;
    }
    const entries = await tokensFor([adminSnap.docs[0].id]);
    await sendTo(entries, {
      notification: {
        title: "🆕 Nouveau chauffeur inscrit",
        body: `${who}${fresh.email && fresh.displayName ? ` (${fresh.email})` : ""} vient de créer un compte sur RoulePartner.`,
      },
      data: { rideId: `nouveau-chauffeur-${user.uid}` },
    });
  });

// Réservé à l'admin. Répare les profils dont le champ "email" est resté vide
// (comptes créés avant que signUp() ne le sauvegarde) en le recopiant depuis
// Firebase Auth, où il est toujours présent — la correspondance se fait sur
// le nom affiché, identique à l'ID du document profil et au displayName Auth.
exports.backfillProfileEmails = onCall({ timeoutSeconds: 60 }, async (request) => {
  if (request.auth?.token?.email !== ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "Réservé à l'administrateur.");
  }

  // Deux index : exact, et normalisé (espaces superflus / casse) en repli
  // pour les comptes dont le nom a été saisi avec une variation mineure.
  const authEmailByName = new Map();
  const authEmailByNormalizedName = new Map();
  const allAuthUsers = [];
  const normalize = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
  let authError = null;
  try {
    let pageToken;
    do {
      const page = await admin.auth().listUsers(1000, pageToken);
      for (const u of page.users) {
        if (!u.email) continue;
        allAuthUsers.push({ displayName: u.displayName || "", email: u.email });
        if (!u.displayName) continue;
        authEmailByName.set(u.displayName, u.email);
        authEmailByNormalizedName.set(normalize(u.displayName), u.email);
      }
      pageToken = page.pageToken;
    } while (pageToken);
  } catch (e) {
    authError = e.message || String(e);
  }

  const profilesSnap = await db.collection("profiles").get();
  const batch = db.batch();
  let updated = 0;
  const missing = [];
  for (const doc of profilesSnap.docs) {
    if (doc.data().email) continue;
    const email = authEmailByName.get(doc.id) || authEmailByNormalizedName.get(normalize(doc.id));
    if (!email) {
      missing.push(doc.id);
      continue;
    }
    batch.set(doc.ref, { email }, { merge: true });
    updated += 1;
  }
  if (updated > 0) await batch.commit();

  // Pour chaque profil non résolu, propose les comptes Auth dont le nom
  // ressemble (sous-chaîne, sans accents ni casse) ou qui n'ont pas de nom
  // affiché du tout — l'admin peut alors faire le lien manuellement.
  const strip = (s) => normalize(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
  const suggestions = {};
  for (const name of missing) {
    const target = strip(name);
    suggestions[name] = allAuthUsers
      .filter((u) => !u.displayName || strip(u.displayName).includes(target) || target.includes(strip(u.displayName)))
      .map((u) => ({ displayName: u.displayName, email: u.email }));
  }

  return { updated, checked: profilesSnap.size, missing, suggestions, authUserCount: allAuthUsers.length, authError };
});

// Réservé à l'admin. Associe manuellement un email Firebase Auth à un profil,
// pour les cas que backfillProfileEmails ne peut pas résoudre tout seul
// (compte Auth créé sans nom affiché, orthographe trop différente...).
exports.assignProfileEmail = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (request.auth?.token?.email !== ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "Réservé à l'administrateur.");
  }
  const { name, email } = request.data || {};
  if (!name || !email) throw new HttpsError("invalid-argument", "name et email requis.");

  const authUser = await admin.auth().getUserByEmail(email).catch(() => null);
  if (!authUser) throw new HttpsError("not-found", "Aucun compte Auth avec cet email.");

  await db.collection("profiles").doc(name).set({ email }, { merge: true });
  return { ok: true };
});

// --- Synchro avec Firebase Auth ---
// Supprimer un compte dans la console Firebase (Authentication) n'efface que le
// compte de connexion : sa fiche, sa position, son jeton de notification et sa
// licence restaient dans Firestore, et l'appli continuait d'afficher le chauffeur.
// Les courses et messages passés sont volontairement conservés (historique).
async function purgeDriverData(name) {
  if (!name) return;
  const batch = db.batch();
  batch.delete(db.collection("profiles").doc(name));
  batch.delete(db.collection("positions").doc(name));
  batch.delete(db.collection("fcmTokens").doc(name));
  const licenses = await db.collection("licenses").where("owner", "==", name).get();
  licenses.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

// Automatique : dès qu'un compte est supprimé dans Firebase Auth, on efface ses données.
// (Pas d'équivalent v2 pour cet événement, d'où la v1.)
exports.cleanupDeletedUser = functionsV1.region("europe-west1").auth.user().onDelete(async (user) => {
  if (user.email === ADMIN_EMAIL) return;
  const names = new Set();
  if (user.email) {
    const snap = await db.collection("profiles").where("email", "==", user.email).get();
    snap.forEach((d) => names.add(d.id));
  }
  if (user.displayName) {
    const p = await db.collection("profiles").doc(user.displayName).get();
    // Sans email sur la fiche on se fie au nom ; avec un autre email, c'est quelqu'un d'autre.
    if (!p.exists || !p.data().email || p.data().email === user.email) names.add(user.displayName);
  }
  for (const name of names) await purgeDriverData(name);
});

// Réservé à l'admin. Rattrape les comptes supprimés avant la mise en place de
// cleanupDeletedUser : efface les fiches/positions qui ne correspondent plus à aucun
// compte Auth, et renvoie la liste des chauffeurs qui existent réellement.
exports.syncDriversWithAuth = onCall({ timeoutSeconds: 60 }, async (request) => {
  if (request.auth?.token?.email !== ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "Réservé à l'administrateur.");
  }
  const normalize = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  const authEmails = new Set();
  const authNames = new Set();
  const authDisplayNames = [];
  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    for (const u of page.users) {
      if (u.email) authEmails.add(u.email.toLowerCase());
      if (u.displayName) {
        authNames.add(normalize(u.displayName));
        authDisplayNames.push(u.displayName);
      }
    }
    pageToken = page.pageToken;
  } while (pageToken);
  // Garde-fou : une liste Auth vide signifierait tout effacer — on n'y touche pas.
  if (authEmails.size === 0) throw new HttpsError("failed-precondition", "Aucun compte Auth trouvé, synchro annulée.");

  const exists = (name, email) =>
    (email && authEmails.has(String(email).toLowerCase())) || authNames.has(normalize(name));

  const removed = [];
  const kept = [];
  const profilesSnap = await db.collection("profiles").get();
  for (const d of profilesSnap.docs) {
    const email = d.data().email;
    if (email === ADMIN_EMAIL || exists(d.id, email)) {
      kept.push(d.id);
    } else {
      await purgeDriverData(d.id);
      removed.push(d.id);
    }
  }
  // Positions (et jetons) sans fiche : chauffeurs disparus dont il ne reste que ça.
  for (const col of ["positions", "fcmTokens"]) {
    const snap = await db.collection(col).get();
    for (const d of snap.docs) {
      if (kept.includes(d.id) || exists(d.id, null)) continue;
      await purgeDriverData(d.id);
      if (!removed.includes(d.id)) removed.push(d.id);
    }
  }
  // activeNames : tous les chauffeurs qui ont encore un compte (fiche ou nom Auth).
  return { removed, activeNames: [...new Set([...kept, ...authDisplayNames])], authUserCount: authEmails.size };
});

// Réservé à l'admin. Suppression complète d'un chauffeur depuis l'appli : son compte
// de connexion Firebase Auth (le navigateur ne peut pas le faire lui-même) et ses
// données (fiche, position, notifications, licence). Courses et messages conservés.
exports.deleteDriver = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (request.auth?.token?.email !== ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "Réservé à l'administrateur.");
  }
  const name = request.data?.name;
  if (!name) throw new HttpsError("invalid-argument", "name requis.");

  const profile = await db.collection("profiles").doc(name).get();
  const email = profile.exists ? profile.data().email : null;
  if (email === ADMIN_EMAIL) throw new HttpsError("failed-precondition", "Impossible de supprimer l'administrateur.");

  // On retrouve le compte Auth par l'email de la fiche, sinon par le nom affiché.
  let authUser = email ? await admin.auth().getUserByEmail(email).catch(() => null) : null;
  if (!authUser) {
    let pageToken;
    do {
      const page = await admin.auth().listUsers(1000, pageToken);
      authUser = page.users.find((u) => u.displayName === name) || null;
      pageToken = authUser ? undefined : page.pageToken;
    } while (pageToken);
  }
  if (authUser?.email === ADMIN_EMAIL) throw new HttpsError("failed-precondition", "Impossible de supprimer l'administrateur.");

  if (authUser) await admin.auth().deleteUser(authUser.uid);
  // cleanupDeletedUser le fait aussi, mais on n'attend pas le déclencheur : la liste
  // de l'admin se met à jour tout de suite.
  await purgeDriverData(name);
  return { ok: true, authDeleted: !!authUser };
});
