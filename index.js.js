const { onDocumentWritten, onDocumentCreated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();

// Doit correspondre exactement à l'email admin utilisé dans les règles Firestore et App.jsx.
const ADMIN_EMAIL = "taxi-vsl67@hotmail.com";

async function getTokensExcept(namesToExclude) {
  const snap = await db.collection("fcmTokens").get();
  const tokens = [];
  snap.forEach((d) => {
    if (!namesToExclude.includes(d.id) && d.data().token) tokens.push(d.data().token);
  });
  return tokens;
}

async function getTokenForName(name) {
  if (!name) return null;
  const doc = await db.collection("fcmTokens").doc(name).get();
  return doc.exists && doc.data().token ? doc.data().token : null;
}

async function sendToTokens(tokens, title, body) {
  if (!tokens.length) return;
  try {
    await getMessaging().sendEachForMulticast({
      notification: { title, body },
      webpush: { notification: { icon: "/icon-192.png" } },
      tokens,
    });
  } catch (e) {
    console.error("Échec d'envoi de notification push :", e);
  }
}

exports.onRideWrite = onDocumentWritten("rides/{rideId}", async (event) => {
  const after = event.data.after.exists ? event.data.after.data() : null;
  const before = event.data.before.exists ? event.data.before.data() : null;
  if (!after) return;

  if (!before && after.status === "disponible") {
    const tokens = await getTokensExcept([after.postedBy]);
    const title = after.urgent ? "🚨 Course urgente disponible" : "Nouvelle course disponible";
    const body = `${after.depart} → ${after.arrivee} — ${after.heure}`;
    await sendToTokens(tokens, title, body);
    return;
  }

  if (before && before.status !== after.status && ["en_cours", "terminee"].includes(after.status)) {
    const token = await getTokenForName(after.postedBy);
    if (token) {
      const title = after.status === "en_cours" ? "🚗 Ta course a démarré" : "✅ Ta course est terminée";
      const body = `${after.depart} → ${after.arrivee} — prise par ${after.takenBy || "?"}`;
      await sendToTokens([token], title, body);
    }
  }
});

exports.onNewProfile = onDocumentCreated("profiles/{name}", async (event) => {
  const newDriverName = event.params.name;
  const adminSnap = await db.collection("profiles").where("email", "==", ADMIN_EMAIL).limit(1).get();
  if (adminSnap.empty) return;
  const adminName = adminSnap.docs[0].id;
  if (adminName === newDriverName) return;
  const token = await getTokenForName(adminName);
  if (token) {
    await sendToTokens([token], "🆕 Nouveau chauffeur inscrit", `${newDriverName} vient de créer un compte sur RoulePartner.`);
  }
});

// Se déclenche à chaque nouveau message de chat -> notifie l'autre chauffeur de la course.
exports.onNewMessage = onDocumentCreated("messages/{messageId}", async (event) => {
  const msg = event.data.data();
  if (!msg?.rideId) return;
  const rideSnap = await db.collection("rides").doc(msg.rideId).get();
  if (!rideSnap.exists) return;
  const ride = rideSnap.data();
  const participants = [ride.postedBy, ride.takenBy, ride.pendingBy].filter(Boolean);
  const recipients = [...new Set(participants)].filter((name) => name !== msg.senderName);
  for (const name of recipients) {
    const token = await getTokenForName(name);
    if (token) {
      await sendToTokens([token], `💬 Message de ${msg.senderName}`, msg.text || "");
    }
  }
});

