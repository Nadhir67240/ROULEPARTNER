const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Europe/Paris : garde les fonctions près des chauffeurs, ça réduit la latence.
setGlobalOptions({ region: "europe-west1", maxInstances: 10 });

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
  if (entries.length === 0) return;
  const res = await admin.messaging().sendEachForMulticast({
    tokens: entries.map((e) => e.token),
    notification: payload.notification,
    data: payload.data,
    webpush: {
      notification: {
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        requireInteraction: payload.requireInteraction === true,
        tag: payload.data.rideId,
      },
      fcmOptions: { link: "/" },
    },
  });

  const stale = [];
  res.responses.forEach((r, i) => {
    const code = r.error && r.error.code;
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
