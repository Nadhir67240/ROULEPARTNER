const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Europe/Paris : garde les fonctions près des chauffeurs, ça réduit la latence.
setGlobalOptions({ region: "europe-west1", maxInstances: 10 });

// Doit correspondre exactement à l'email admin utilisé dans firestore.rules et App.jsx.
const ADMIN_EMAIL = "taxi-vsl67@hotmail.com";

// --- Ces valeurs doivent rester alignées avec celles de src/App.jsx ---
const PRIORITY_WINDOW_MS = 15 * 1000;
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
        badge: "/icon-192.png",
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
  { document: "rides/{rideId}", timeoutSeconds: 60 },
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

// Prévient l'admin à chaque nouvelle inscription de chauffeur. Reprend ce que faisait
// l'ancien onNewProfile (index.js.js, racine, jamais nettoyé de la prod) — portée ici pour
// pouvoir enfin supprimer ce doublon.
exports.notifyNewProfile = onDocumentCreated(
  { document: "profiles/{name}", timeoutSeconds: 30 },
  async (event) => {
    const newDriverName = event.params.name;
    const adminSnap = await db.collection("profiles").where("email", "==", ADMIN_EMAIL).limit(1).get();
    if (adminSnap.empty) return;
    const adminName = adminSnap.docs[0].id;
    if (adminName === newDriverName) return;

    const entries = await tokensFor([adminName]);
    await sendTo(entries, {
      notification: {
        title: "🆕 Nouveau chauffeur inscrit",
        body: `${newDriverName} vient de créer un compte sur RoulePartner.`,
      },
      data: { rideId: `nouveau-chauffeur-${newDriverName}` },
    });
  }
);

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
  const normalize = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    for (const u of page.users) {
      if (!u.displayName || !u.email) continue;
      authEmailByName.set(u.displayName, u.email);
      authEmailByNormalizedName.set(normalize(u.displayName), u.email);
    }
    pageToken = page.pageToken;
  } while (pageToken);

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

  return { updated, checked: profilesSnap.size, missing };
});
