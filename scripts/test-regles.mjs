// Tests des règles Firestore sur les courses (firestore.rules), contre les ÉMULATEURS :
//   firebase emulators:start --config firebase.sim.json --only auth,firestore --project demo-roulepartner
//   node scripts/test-regles.mjs
// Chaque cas vérifie qu'un geste prévu par l'appli passe et qu'une triche est refusée.

import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, updateProfile } from "firebase/auth";
import {
  getFirestore, connectFirestoreEmulator, doc, setDoc, updateDoc, getDoc, deleteDoc, serverTimestamp, Timestamp,
  writeBatch, deleteField, arrayUnion,
} from "firebase/firestore";

const PROJECT_ID = "demo-roulepartner";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reset() {
  await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${PROJECT_ID}/accounts`, { method: "DELETE" });
}

async function makeUser(name, { verified = true, email = null } = {}) {
  const app = initializeApp({ apiKey: "demo-key", projectId: PROJECT_ID }, name);
  const auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  const cred = await createUserWithEmailAndPassword(auth, email || `${name.replace(/\s/g, "")}@test.fr`, "motdepasse123");
  await updateProfile(cred.user, { displayName: name });
  if (verified) await fetch(`http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:update`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
    body: JSON.stringify({ localId: cred.user.uid, emailVerified: true }),
  });
  await cred.user.getIdToken(true);
  return { name, db, email: cred.user.email };
}

// Écrit directement en contournant les règles (préparation des cas de test).
async function adminSet(id, data) {
  const fields = {};
  const enc = (v) => v === null ? { nullValue: null }
    : typeof v === "string" ? { stringValue: v }
    : typeof v === "number" ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
    : typeof v === "boolean" ? { booleanValue: v }
    : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } }
    : v instanceof Date ? { timestampValue: v.toISOString() }
    : { nullValue: null };
  for (const [k, v] of Object.entries(data)) fields[k] = enc(v);
  const res = await fetch(`http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/(default)/documents/rides/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`adminSet ${id}: ${await res.text()}`);
}

const baseRide = (over) => ({
  depart: "Gare", arrivee: "CHU", heure: "14:30", date: "2026-10-01", tarif: "40", type: "taxi",
  postedBy: "Poster", status: "disponible", takenBy: null, createdAt: Date.now() - 60000,
  priorityDrivers: [], priorityUntil: Date.now() - 30000, ...over,
});

let pass = 0, fail = 0;
async function expect(label, shouldPass, fn) {
  let ok;
  try { await fn(); ok = true; } catch (e) { ok = false; if (shouldPass) console.log("   ↳", e.code || e.message); }
  const good = ok === shouldPass;
  good ? pass++ : fail++;
  console.log(`${good ? "OK " : "KO "} ${shouldPass ? "autorisé" : "refusé  "} — ${label}`);
}

await reset();
const poster = await makeUser("Poster");
const req = await makeUser("Demandeur");
const other = await makeUser("Autre");

// --- Demande de prise ---
await adminSet("c1", baseRide({}));
await expect("demande de prise normale (heure serveur)", true, () =>
  updateDoc(doc(req.db, "rides/c1"), { status: "en_attente", pendingBy: "Demandeur", pendingSince: Date.now(), pendingAt: serverTimestamp() }));

await adminSet("c2", baseRide({}));
await expect("demande de prise avec heure antidatée par le téléphone", false, () =>
  updateDoc(doc(req.db, "rides/c2"), { status: "en_attente", pendingBy: "Demandeur", pendingSince: Date.now(), pendingAt: Timestamp.fromMillis(Date.now() - 120000) }));
await expect("demande de prise qui modifie aussi le tarif", false, () =>
  updateDoc(doc(req.db, "rides/c2"), { status: "en_attente", pendingBy: "Demandeur", pendingSince: Date.now(), pendingAt: serverTimestamp(), tarif: "999" }));
await expect("demande de prise au nom d'un autre chauffeur", false, () =>
  updateDoc(doc(req.db, "rides/c2"), { status: "en_attente", pendingBy: "Autre", pendingSince: Date.now(), pendingAt: serverTimestamp() }));

// --- Le demandeur tente de se valider tout seul ---
await expect("demandeur se confirme lui-même tout de suite (avant 30 s)", false, () =>
  updateDoc(doc(req.db, "rides/c1"), { status: "prise", takenBy: "Demandeur", pendingBy: null, pendingSince: null, pendingAt: null }));
await expect("un autre chauffeur confirme la demande", false, () =>
  updateDoc(doc(other.db, "rides/c1"), { status: "prise", takenBy: "Demandeur", pendingBy: null, pendingSince: null, pendingAt: null }));

// Demande vieille de 40 s (heure serveur) : le demandeur peut alors se confirmer.
await adminSet("c3", baseRide({ status: "en_attente", pendingBy: "Demandeur", pendingSince: Date.now() - 40000, pendingAt: new Date(Date.now() - 40000) }));
await expect("demandeur se confirme après 30 s sans réponse du posteur", true, () =>
  updateDoc(doc(req.db, "rides/c3"), { status: "prise", takenBy: "Demandeur", pendingBy: null, pendingSince: null, pendingAt: null }));
await adminSet("c4", baseRide({ status: "en_attente", pendingBy: "Demandeur", pendingSince: Date.now() - 40000, pendingAt: new Date(Date.now() - 40000) }));
await expect("…mais en se donnant la course avec un autre tarif", false, () =>
  updateDoc(doc(req.db, "rides/c4"), { status: "prise", takenBy: "Demandeur", pendingBy: null, pendingSince: null, pendingAt: null, tarif: "999" }));

// --- Le posteur garde le choix ---
await expect("posteur confirme la demande (avant 30 s)", true, () =>
  updateDoc(doc(poster.db, "rides/c1"), { status: "prise", takenBy: "Demandeur", pendingBy: null, pendingSince: null, pendingAt: null }));
await adminSet("c5", baseRide({ status: "en_attente", pendingBy: "Demandeur", pendingSince: Date.now(), pendingAt: new Date() }));
await expect("posteur refuse la demande", true, () =>
  updateDoc(doc(poster.db, "rides/c5"), { status: "disponible", pendingBy: null, pendingSince: null, pendingAt: null }));
await adminSet("c6", baseRide({ status: "en_attente", pendingBy: "Demandeur", pendingSince: Date.now(), pendingAt: new Date() }));
await expect("demandeur annule sa demande", true, () =>
  updateDoc(doc(req.db, "rides/c6"), { status: "disponible", pendingBy: null, pendingSince: null, pendingAt: null }));

// --- Celui qui a la course ---
await expect("preneur démarre la course", true, () =>
  updateDoc(doc(req.db, "rides/c1"), { status: "en_cours", startedAt: Date.now() }));
await expect("preneur modifie le tarif", false, () =>
  updateDoc(doc(req.db, "rides/c1"), { tarif: "999" }));
await expect("preneur termine la course", true, () =>
  updateDoc(doc(req.db, "rides/c1"), { status: "terminee" }));
await adminSet("c7", baseRide({ status: "prise", takenBy: "Demandeur" }));
await expect("preneur relâche la course avant de la commencer", true, () =>
  updateDoc(doc(req.db, "rides/c7"), { status: "disponible", takenBy: null }));
await adminSet("c8", baseRide({ status: "prise", takenBy: "Demandeur" }));
await expect("preneur donne la course à un autre", false, () =>
  updateDoc(doc(req.db, "rides/c8"), { takenBy: "Autre" }));
await expect("autre chauffeur démarre une course qui n'est pas à lui", false, () =>
  updateDoc(doc(other.db, "rides/c8"), { status: "en_cours", startedAt: Date.now() }));
await expect("posteur modifie sa course (tarif)", true, () =>
  updateDoc(doc(poster.db, "rides/c8"), { tarif: "45" }));

// --- Photo / PDF du bon (rides/{id}/prive/bon) ---
// Course telle que l'appli la crée (sans les champs de priorité, écrits par la Cloud Function).
const newRide = (over) => {
  const { priorityDrivers, priorityUntil, ...ride } = baseRide(over);
  return ride;
};
await adminSet("b1", baseRide({ hasPhoto: true }));
await adminSet("b1/prive/bon", { photo: "data:image/jpeg;base64,AAAA", document: null, documentName: "" });
await expect("autre chauffeur lit la photo du bon", false, () => getDoc(doc(other.db, "rides/b1/prive/bon")));
await expect("posteur lit la photo du bon", true, () => getDoc(doc(poster.db, "rides/b1/prive/bon")));
await expect("demandeur lit la photo avant d'avoir demandé la course", false, () => getDoc(doc(req.db, "rides/b1/prive/bon")));
await updateDoc(doc(req.db, "rides/b1"), { status: "en_attente", pendingBy: "Demandeur", pendingSince: Date.now(), pendingAt: serverTimestamp() });
await expect("demandeur lit la photo une fois la course demandée", true, () => getDoc(doc(req.db, "rides/b1/prive/bon")));
await expect("autre chauffeur remplace la photo du bon", false, () =>
  setDoc(doc(other.db, "rides/b1/prive/bon"), { photo: "data:x", document: null, documentName: "" }));
await expect("autre chauffeur supprime la photo du bon", false, () => deleteDoc(doc(other.db, "rides/b1/prive/bon")));

await expect("posteur publie une course + son bon (même lot)", true, () => {
  const b = writeBatch(poster.db);
  b.set(doc(poster.db, "rides/b2"), newRide({ hasPhoto: true }));
  b.set(doc(poster.db, "rides/b2/prive/bon"), { photo: "data:x", document: null, documentName: "" });
  return b.commit();
});
await expect("autre chauffeur glisse un bon sur la course d'un autre", false, () =>
  setDoc(doc(other.db, "rides/b3/prive/bon"), { photo: "data:x" }));
await expect("posteur publie une course avec la photo dans la fiche", false, () =>
  setDoc(doc(poster.db, "rides/b4"), newRide({ photo: "data:x" })));
await expect("posteur ajoute une photo dans la fiche d'une course", false, () =>
  updateDoc(doc(poster.db, "rides/b2"), { photo: "data:x" }));

// Ancienne course avec la photo encore dans la fiche.
await adminSet("b5", baseRide({ photo: "data:ancienne" }));
await expect("demande de prise sur une ancienne course avec photo", true, () =>
  updateDoc(doc(req.db, "rides/b5"), { status: "en_attente", pendingBy: "Demandeur", pendingSince: Date.now(), pendingAt: serverTimestamp() }));
await expect("posteur retire la photo de la fiche (migration à la modification)", true, () => {
  const b = writeBatch(poster.db);
  b.update(doc(poster.db, "rides/b5"), { photo: deleteField(), hasPhoto: true });
  b.set(doc(poster.db, "rides/b5/prive/bon"), { photo: "data:ancienne", document: null, documentName: "" });
  return b.commit();
});
await expect("posteur efface réellement la course (hors corbeille)", false, () => {
  const b = writeBatch(poster.db);
  b.delete(doc(poster.db, "rides/b5/prive/bon"));
  b.delete(doc(poster.db, "rides/b5"));
  return b.commit();
});

// --- Corbeille : suppression = deleted: true, effacement réel réservé à l'admin ---
const admin = await makeUser("Admin", { email: "taxi-vsl67@hotmail.com" });
const archive = (u) => ({ deleted: true, deletedBy: u.name, deletedAt: Date.now() });
await adminSet("d1", baseRide({}));
await expect("posteur met à la corbeille sa course encore libre", true, () =>
  updateDoc(doc(poster.db, "rides/d1"), archive(poster)));
await expect("…puis la modifie alors qu'elle est à la corbeille", false, () =>
  updateDoc(doc(poster.db, "rides/d1"), { tarif: "50" }));
await expect("…ou la restaure lui-même", false, () =>
  updateDoc(doc(poster.db, "rides/d1"), { deleted: deleteField(), deletedBy: deleteField(), deletedAt: deleteField() }));
await expect("un chauffeur demande une course à la corbeille", false, () =>
  updateDoc(doc(req.db, "rides/d1"), { status: "en_attente", pendingBy: "Demandeur", pendingSince: Date.now(), pendingAt: serverTimestamp() }));
await expect("admin restaure la course", true, () =>
  updateDoc(doc(admin.db, "rides/d1"), { deleted: deleteField(), deletedBy: deleteField(), deletedAt: deleteField() }));
await expect("posteur efface réellement sa course libre", false, () => deleteDoc(doc(poster.db, "rides/d1")));
await expect("autre chauffeur met à la corbeille la course d'un autre", false, () =>
  updateDoc(doc(other.db, "rides/d1"), archive(other)));
await expect("posteur met à la corbeille au nom de quelqu'un d'autre", false, () =>
  updateDoc(doc(poster.db, "rides/d1"), archive(other)));
await expect("posteur met à la corbeille en modifiant aussi le tarif", false, () =>
  updateDoc(doc(poster.db, "rides/d1"), { ...archive(poster), tarif: "1" }));

for (const [id, over, label] of [
  ["d2", { status: "en_attente", pendingBy: "Demandeur", pendingSince: Date.now(), pendingAt: new Date() }, "demandée"],
  ["d3", { status: "prise", takenBy: "Demandeur" }, "prise"],
  ["d4", { status: "en_cours", takenBy: "Demandeur" }, "en cours"],
  ["d5", { status: "terminee", takenBy: "Demandeur" }, "terminée"],
]) {
  await adminSet(id, baseRide(over));
  await expect(`posteur met à la corbeille sa course ${label}`, false, () =>
    updateDoc(doc(poster.db, `rides/${id}`), archive(poster)));
}
await expect("posteur « reprend » une course prise (pour la supprimer ensuite)", false, () =>
  updateDoc(doc(poster.db, "rides/d3"), { status: "disponible", takenBy: null }));
await expect("posteur passe une course prise en terminée", false, () =>
  updateDoc(doc(poster.db, "rides/d3"), { status: "terminee" }));
await expect("posteur modifie le tarif d'une course prise", true, () =>
  updateDoc(doc(poster.db, "rides/d3"), { tarif: "42" }));
await expect("preneur met à la corbeille la course prise", false, () =>
  updateDoc(doc(req.db, "rides/d3"), archive(req)));
await expect("admin met à la corbeille une course terminée", true, () =>
  updateDoc(doc(admin.db, "rides/d5"), archive(admin)));
await expect("admin efface définitivement une course", true, () => deleteDoc(doc(admin.db, "rides/d5")));

// --- Course envoyée à des chauffeurs choisis (assignees) ---
const third = await makeUser("Troisieme");
const sent = (names, over) => baseRide({ assignees: names, assignRefused: [], priorityDrivers: [], priorityUntil: 0, ...over });
await expect("posteur publie une course envoyée à deux chauffeurs", true, () =>
  setDoc(doc(poster.db, "rides/a0"), newRide({ assignees: ["Demandeur", "Autre"], assignRefused: [] })));
await adminSet("a1", sent(["Demandeur", "Autre"]));
await expect("un chauffeur non choisi demande la course", false, () =>
  updateDoc(doc(third.db, "rides/a1"), { status: "en_attente", pendingBy: "Troisieme", pendingSince: Date.now(), pendingAt: serverTimestamp() }));
await expect("un chauffeur non choisi l'accepte", false, () =>
  updateDoc(doc(third.db, "rides/a1"), { status: "prise", takenBy: "Troisieme" }));
await expect("un choisi l'accepte au nom d'un autre", false, () =>
  updateDoc(doc(req.db, "rides/a1"), { status: "prise", takenBy: "Autre" }));
await expect("un choisi l'accepte en changeant le tarif", false, () =>
  updateDoc(doc(req.db, "rides/a1"), { status: "prise", takenBy: "Demandeur", tarif: "999" }));
await expect("le premier choisi l'accepte", true, () =>
  updateDoc(doc(req.db, "rides/a1"), { status: "prise", takenBy: "Demandeur" }));
await expect("le second choisi l'accepte juste après (trop tard)", false, () =>
  updateDoc(doc(other.db, "rides/a1"), { status: "prise", takenBy: "Autre" }));
await expect("…le premier la relâche (il passe dans les refus)", true, () =>
  updateDoc(doc(req.db, "rides/a1"), { status: "disponible", takenBy: null, assignRefused: arrayUnion("Demandeur"), assignRespondedAt: Date.now() }));
await expect("…il la reprend après l'avoir relâchée", false, () =>
  updateDoc(doc(req.db, "rides/a1"), { status: "prise", takenBy: "Demandeur" }));
await expect("…le second choisi peut alors l'accepter", true, () =>
  updateDoc(doc(other.db, "rides/a1"), { status: "prise", takenBy: "Autre" }));

await adminSet("a2", sent(["Demandeur", "Autre"]));
await expect("un non choisi la refuse à leur place", false, () =>
  updateDoc(doc(third.db, "rides/a2"), { assignRefused: arrayUnion("Troisieme"), assignRespondedAt: Date.now() }));
await expect("un choisi refuse au nom d'un autre", false, () =>
  updateDoc(doc(req.db, "rides/a2"), { assignRefused: arrayUnion("Autre"), assignRespondedAt: Date.now() }));
await expect("un choisi la refuse", true, () =>
  updateDoc(doc(req.db, "rides/a2"), { assignRefused: arrayUnion("Demandeur"), assignRespondedAt: Date.now() }));
await expect("…puis l'accepte quand même", false, () =>
  updateDoc(doc(req.db, "rides/a2"), { status: "prise", takenBy: "Demandeur" }));
await expect("…ou efface son refus", false, () =>
  updateDoc(doc(req.db, "rides/a2"), { assignRefused: [] }));
await expect("l'autre choisi refuse aussi (elle revient au posteur)", true, () =>
  updateDoc(doc(other.db, "rides/a2"), { assignRefused: arrayUnion("Autre"), assignRespondedAt: Date.now() }));
await expect("posteur la renvoie à un troisième chauffeur", true, () =>
  updateDoc(doc(poster.db, "rides/a2"), { assignees: ["Troisieme"], assignRefused: [], assignRespondedAt: null }));
await expect("l'ancien choisi l'accepte encore", false, () =>
  updateDoc(doc(other.db, "rides/a2"), { status: "prise", takenBy: "Autre" }));
await expect("posteur la publie à tous", true, () =>
  updateDoc(doc(poster.db, "rides/a2"), { assignees: deleteField(), assignRefused: deleteField(), assignRespondedAt: deleteField() }));
await expect("…et n'importe qui peut alors la demander", true, () =>
  updateDoc(doc(req.db, "rides/a2"), { status: "en_attente", pendingBy: "Demandeur", pendingSince: Date.now(), pendingAt: serverTimestamp() }));

// Ancien format (un seul chauffeur dans assignedTo), course prise : elle doit rester protégée.
await adminSet("a3", baseRide({ assignedTo: "Demandeur", assignStatus: "envoyee", status: "prise", takenBy: "Demandeur" }));
await expect("ancien format : le preneur relâche (refusée)", true, () =>
  updateDoc(doc(req.db, "rides/a3"), { status: "disponible", takenBy: null, assignStatus: "refusee", assignRespondedAt: Date.now() }));
await expect("ancien format : un autre la demande ensuite", false, () =>
  updateDoc(doc(other.db, "rides/a3"), { status: "en_attente", pendingBy: "Autre", pendingSince: Date.now(), pendingAt: serverTimestamp() }));
await adminSet("a4", sent(["Demandeur"]));
await expect("posteur met à la corbeille une course envoyée sans réponse", true, () =>
  updateDoc(doc(poster.db, "rides/a4"), { deleted: true, deletedBy: "Poster", deletedAt: Date.now() }));

// --- Fiche profil à l'inscription (email pas encore confirmé) ---
const nouveau = await makeUser("Nouveau", { verified: false });
const fiche = (over) => ({ email: nouveau.email, licenseNumber: "LIC1", commune: "Strasbourg", banned: false, createdAt: Date.now(), ...over });
await expect("inscrit non confirmé crée la fiche d'un autre nom", false, () =>
  setDoc(doc(nouveau.db, "profiles/Autre2"), fiche()));
await expect("inscrit non confirmé crée sa fiche avec banned: true", false, () =>
  setDoc(doc(nouveau.db, "profiles/Nouveau"), fiche({ banned: true })));
await expect("inscrit non confirmé ajoute un champ non prévu", false, () =>
  setDoc(doc(nouveau.db, "profiles/Nouveau"), fiche({ phone: "0600000000" })));
await expect("inscrit non confirmé crée sa fiche", true, () =>
  setDoc(doc(nouveau.db, "profiles/Nouveau"), fiche()));
await expect("inscrit non confirmé écrase ensuite sa fiche", false, () =>
  setDoc(doc(nouveau.db, "profiles/Nouveau"), fiche({ commune: "Paris" })));

console.log(`\n${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
