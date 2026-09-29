// Tests des règles Firestore sur les courses (firestore.rules), contre les ÉMULATEURS :
//   firebase emulators:start --config firebase.sim.json --only auth,firestore --project demo-roulepartner
//   node scripts/test-regles.mjs
// Chaque cas vérifie qu'un geste prévu par l'appli passe et qu'une triche est refusée.

import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, updateProfile } from "firebase/auth";
import {
  getFirestore, connectFirestoreEmulator, doc, setDoc, updateDoc, getDoc, serverTimestamp, Timestamp,
} from "firebase/firestore";

const PROJECT_ID = "demo-roulepartner";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reset() {
  await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${PROJECT_ID}/accounts`, { method: "DELETE" });
}

async function makeUser(name) {
  const app = initializeApp({ apiKey: "demo-key", projectId: PROJECT_ID }, name);
  const auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  const cred = await createUserWithEmailAndPassword(auth, `${name.replace(/\s/g, "")}@test.fr`, "motdepasse123");
  await updateProfile(cred.user, { displayName: name });
  await fetch(`http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:update`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
    body: JSON.stringify({ localId: cred.user.uid, emailVerified: true }),
  });
  await cred.user.getIdToken(true);
  return { name, db };
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

console.log(`\n${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
