// Simulation de 30 chauffeurs RoulePartner en temps réel, contre les ÉMULATEURS
// Firebase locaux (jamais la production) :
//   firebase emulators:start --only auth,firestore,functions --project demo-roulepartner
//   node scripts/simulation-chauffeurs.mjs
//
// Chaque chauffeur a son propre compte Auth, sa position GPS, écoute les courses
// comme l'appli (onSnapshot) et reproduit les mêmes appels que src/firebase.js /
// src/App.jsx (claimRide en transaction, confirmation, refus, auto-confirmation
// après 30 s, démarrage, fin). Les règles firestore.rules et la Cloud Function
// notifyNewRide (priorité) tournent réellement dans les émulateurs.

import { initializeApp } from "firebase/app";
import {
  getAuth, connectAuthEmulator, createUserWithEmailAndPassword, updateProfile,
} from "firebase/auth";
import {
  getFirestore, connectFirestoreEmulator, doc, setDoc, updateDoc, onSnapshot,
  query, collection, orderBy, limit, runTransaction, serverTimestamp,
} from "firebase/firestore";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";

const PROJECT_ID = "demo-roulepartner";
const AUTH_HOST = "127.0.0.1:9099";
const FS_HOST = "127.0.0.1";
const FS_PORT = 8080;
const OUT_FILE = process.argv[2] || "simulation-resultats.json";

// --- Mêmes constantes que src/App.jsx / functions/index.js ---
const PRIORITY_WINDOW_MS = 15 * 1000;
const PRIORITY_RADIUS_KM = 1.0;
const PRIORITY_MAX_DRIVERS = 3;
const POSITION_FRESH_MS = 15 * 60 * 1000;
const CLAIM_CONFIRM_WINDOW_MS = 30 * 1000;

const NB_DRIVERS = 30;
const CENTER = { lat: 48.5734, lng: 7.7521 }; // Strasbourg centre
const GARE = { lat: 48.5850, lng: 7.7350 };   // point dense : 4 chauffeurs autour
const HAGUENAU = { lat: 48.8156, lng: 7.7906 }; // loin de tout le monde

// Aléatoire reproductible
let seed = 20260929;
const rand = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (a, b) => a + rand() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const ts = () => `+${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s`;
const log = (...a) => console.log(ts(), ...a);

function distanceKm(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}
function pointAround(c, maxKm, minKm = 0) {
  const d = Math.sqrt(between((minKm / maxKm) ** 2, 1)) * maxKm;
  const th = between(0, 2 * Math.PI);
  return {
    lat: c.lat + (d * Math.cos(th)) / 111,
    lng: c.lng + (d * Math.sin(th)) / (111 * Math.cos((c.lat * Math.PI) / 180)),
  };
}
function ridePickupCoords(ride) {
  if (ride.departLat != null && ride.departLng != null) return { lat: ride.departLat, lng: ride.departLng };
  if (ride.lat != null && ride.lng != null) return { lat: ride.lat, lng: ride.lng };
  return null;
}
// Copie de computePriorityDrivers() (App.jsx et functions/index.js sont identiques).
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

// ---------------------------------------------------------------------------
// Journal des événements (pour le rapport final)
// ---------------------------------------------------------------------------
const rideLog = {};      // rideId -> infos + tentatives
const autoConfirm = { success: 0, denied: 0, deniedByDriver: {}, otherErr: 0 };
const errors = [];
const latencies = [];    // délai création -> vue par chaque chauffeur (ms)
const priorityWriteDelays = [];
const livePositions = {}; // copie locale des positions actuelles (vérité terrain)

function R(id) {
  return (rideLog[id] ||= { attempts: [], transitions: [], confirmActions: [] });
}

// ---------------------------------------------------------------------------
// Chauffeurs
// ---------------------------------------------------------------------------
class Driver {
  constructor(i) {
    this.i = i;
    this.name = `Chauffeur ${String(i + 1).padStart(2, "0")}`;
    this.email = `chauffeur${i + 1}@sim.test`;
    this.cheater = i === NB_DRIVERS - 1; // tente de tout prendre tout de suite, via l'API directe
    this.rides = new Map();
    this.handled = new Set();
    this.timers = [];
    this.unsubs = [];
  }

  later(ms, fn) {
    this.timers.push(setTimeout(() => fn().catch((e) => errors.push(`${this.name}: ${e.message}`)), ms));
  }

  async init() {
    const app = initializeApp({ apiKey: "demo-key", projectId: PROJECT_ID, authDomain: "localhost" }, this.name);
    this.auth = getAuth(app);
    connectAuthEmulator(this.auth, `http://${AUTH_HOST}`, { disableWarnings: true });
    this.db = getFirestore(app);
    connectFirestoreEmulator(this.db, FS_HOST, FS_PORT);

    const cred = await createUserWithEmailAndPassword(this.auth, this.email, "motdepasse123");
    await updateProfile(cred.user, { displayName: this.name });
    // Email vérifié directement dans l'émulateur (les règles exigent email_verified).
    const res = await fetch(
      `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:update`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
        body: JSON.stringify({ localId: cred.user.uid, emailVerified: true }),
      }
    );
    if (!res.ok) throw new Error(`verif email: ${res.status} ${await res.text()}`);
    await cred.user.getIdToken(true);

    await setDoc(doc(this.db, "profiles", this.name), {
      email: this.email, licenseNumber: `SIM${this.i + 1}`, commune: "Strasbourg",
      banned: false, createdAt: Date.now(),
    });
  }

  async setPosition(p) {
    this.pos = p;
    const coords = { lat: p.lat, lng: p.lng, updatedAt: Date.now() };
    livePositions[this.name] = coords;
    await setDoc(doc(this.db, "positions", this.name), coords);
  }

  // Petit déplacement (~100-300 m), comme un téléphone qui envoie son GPS.
  startMoving() {
    this.moveTimer = setInterval(() => {
      this.setPosition(pointAround(this.pos, 0.3, 0.1)).catch((e) => errors.push(`${this.name} gps: ${e.message}`));
    }, between(8000, 14000));
  }

  listen() {
    const q = query(collection(this.db, "rides"), orderBy("createdAt", "desc"), limit(200));
    this.unsubs.push(onSnapshot(q, (snap) => {
      snap.docs.forEach((d) => {
        const r = { id: d.id, ...d.data() };
        this.rides.set(r.id, r);
        this.onRide(r);
      });
    }, (e) => errors.push(`${this.name} listen: ${e.message}`)));

    // Réplique de l'effet "auto-confirmation après 30 s" d'App.jsx, qui tourne sur
    // CHAQUE téléphone ouvert pour toutes les courses en attente.
    this.autoTimer = setInterval(() => {
      const now = Date.now();
      for (const r of this.rides.values()) {
        // SIM_CORRECTIF=1 : seuls le posteur et le demandeur (les deux seuls que les
        // règles autorisent) tentent l'auto-confirmation.
        if (process.env.SIM_CORRECTIF === "1" && r.postedBy !== this.name && r.pendingBy !== this.name) continue;
        if (r.status === "en_attente" && r.pendingSince && now - r.pendingSince > CLAIM_CONFIRM_WINDOW_MS) {
          updateDoc(doc(this.db, "rides", r.id), {
            status: "prise", takenBy: r.pendingBy, pendingBy: null, pendingSince: null, pendingAt: null,
          }).then(() => {
            autoConfirm.success++;
            R(r.id).confirmActions.push({ t: Date.now(), by: this.name, kind: "auto-30s" });
          }).catch((e) => {
            if (e.code === "permission-denied") {
              autoConfirm.denied++;
              autoConfirm.deniedByDriver[this.name] = (autoConfirm.deniedByDriver[this.name] || 0) + 1;
            } else autoConfirm.otherErr++;
          });
        }
      }
    }, 1000);
  }

  onRide(r) {
    const log0 = R(r.id);
    const seenKey = `seen:${r.id}`;
    if (!this.handled.has(seenKey)) {
      this.handled.add(seenKey);
      if (r.postedBy !== this.name) latencies.push(Date.now() - r.createdAt);
    }

    // --- Je suis le posteur ---
    if (r.postedBy === this.name && r.status === "en_attente") {
      const key = `pending:${r.id}:${r.pendingSince}`;
      if (this.handled.has(key)) return;
      this.handled.add(key);
      const plan = log0.posterPlan;
      if (plan === "ignore") return; // laisse filer -> auto-confirmation à 30 s
      this.later(between(2000, 7000), async () => {
        const cur = this.rides.get(r.id);
        if (cur.status !== "en_attente" || cur.pendingBy !== r.pendingBy) return;
        // Un refus maximum par course, sinon on confirme.
        if (plan === "refuse" && !log0.refusedOnce) {
          log0.refusedOnce = true;
          await updateDoc(doc(this.db, "rides", r.id), { status: "disponible", pendingBy: null, pendingSince: null, pendingAt: null });
          log0.confirmActions.push({ t: Date.now(), by: this.name, kind: `refus de ${r.pendingBy}` });
          log(`❌ ${this.name} REFUSE ${r.pendingBy} sur ${log0.label}`);
        } else {
          await updateDoc(doc(this.db, "rides", r.id), {
            status: "prise", takenBy: r.pendingBy, pendingBy: null, pendingSince: null, pendingAt: null,
          });
          log0.confirmActions.push({ t: Date.now(), by: this.name, kind: "confirmation posteur" });
          log(`✅ ${this.name} CONFIRME ${r.pendingBy} sur ${log0.label}`);
        }
      });
      return;
    }

    // --- J'ai la course : je démarre puis je termine ---
    if (r.status === "prise" && r.takenBy === this.name) {
      const key = `run:${r.id}`;
      if (this.handled.has(key)) return;
      this.handled.add(key);
      this.later(between(3000, 6000), async () => {
        await updateDoc(doc(this.db, "rides", r.id), { status: "en_cours", startedAt: Date.now() });
        this.later(between(4000, 9000), async () => {
          await updateDoc(doc(this.db, "rides", r.id), { status: "terminee" });
        });
      });
      return;
    }

    // --- Course disponible postée par un autre ---
    const prev = this.prevStatus?.get(r.id);
    (this.prevStatus ||= new Map()).set(r.id, r.status);
    this.reopens ||= new Map();
    if (prev === "en_attente" && r.status === "disponible") this.reopens.set(r.id, (this.reopens.get(r.id) || 0) + 1);
    if (r.status !== "disponible" || r.postedBy === this.name) return;
    // Nouvelle "ouverture" (création, ou remise en disponible après un refus).
    const reopenCount = this.reopens.get(r.id) || 0;
    const openKey = `open:${r.id}:${reopenCount}`;

    if (this.cheater) {
      if (this.handled.has(openKey)) return;
      this.handled.add(openKey);
      // Appel direct à Firestore, sans attendre ni respecter la priorité.
      this.later(between(100, 600), () => this.claim(r.id, "tricheur (API directe)"));
      return;
    }

    // Comme l'appli : tant que le serveur n'a pas écrit priorityDrivers, le
    // téléphone calcule lui-même la priorité pour verrouiller/déverrouiller le bouton.
    const serverKnown = Array.isArray(r.priorityDrivers);
    // Appli corrigée : "Je la prends" reste grisé ("Attribution en cours…") tant que
    // le serveur n'a pas écrit priorityDrivers — on réévalue au prochain snapshot.
    if (process.env.SIM_CORRECTIF === "1" && !serverKnown) return;
    const prio = serverKnown
      ? r.priorityDrivers
      : computePriorityDrivers(r, Object.fromEntries(
          Object.entries(livePositions)
        )).map((p) => p.name);
    const iAmPrio = prio.includes(this.name);

    if (this.handled.has(openKey)) return;
    this.handled.add(openKey);

    const reopened = reopenCount > 0;
    if (iAmPrio && !reopened) {
      if (rand() < 0.9) {
        this.later(between(1000, 5000), () => this.claim(r.id, "prioritaire"));
      }
    } else {
      // Intéressé ou pas par cette course ?
      if (rand() > log0.interest) return;
      // Même après un refus, la fenêtre de priorité court toujours : l'appli garde le bouton masqué.
      const windowEnd = prio.length > 0 ? r.createdAt + PRIORITY_WINDOW_MS : 0;
      const wait = Math.max(0, windowEnd - Date.now()) + between(300, 3500);
      this.later(wait, () => this.claim(r.id, windowEnd ? "après fenêtre" : "ouverte à tous"));
    }
  }

  // Identique à claimRide() de src/firebase.js
  async claim(rideId, why) {
    const cur = this.rides.get(rideId);
    if (!this.cheater && cur && cur.status !== "disponible") return; // bouton déjà grisé dans l'appli
    const t = Date.now();
    const ref = doc(this.db, "rides", rideId);
    let result;
    try {
      await runTransaction(this.db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("ride_gone");
        const data = snap.data();
        if (data.status !== "disponible") throw new Error("already_taken");
        tx.update(ref, { status: "en_attente", pendingBy: this.name, pendingSince: Date.now(), pendingAt: serverTimestamp() });
      });
      result = "GAGNÉ";
    } catch (e) {
      result = e.code === "permission-denied" ? "refusé par les règles" : e.message;
    }
    const L = R(rideId);
    L.attempts.push({ t, rel: t - L.createdAt, driver: this.name, why, result });
    const icon = result === "GAGNÉ" ? "🏁" : "  ";
    log(`${icon} ${this.name} tente ${L.label} [${why}] à +${((t - L.createdAt) / 1000).toFixed(1)}s → ${result}`);
  }

  stop() {
    this.timers.forEach(clearTimeout);
    clearInterval(this.moveTimer);
    clearInterval(this.autoTimer);
    this.unsubs.forEach((u) => u());
  }
}

// ---------------------------------------------------------------------------
// Fonction serveur exécutée localement
// ---------------------------------------------------------------------------
// L'émulateur Functions exécute les déclencheurs UN PAR UN : comme notifyNewRide
// attend 15 s (fenêtre de priorité), chaque course bloque la suivante et la
// priorité est écrite de plus en plus tard — ce qui n'arrive pas en production,
// où Google lance plusieurs instances en parallèle. Avec SIM_FONCTION_LOCALE=1,
// on lance l'émulateur SANS functions et on exécute ici le VRAI code de
// functions/index.js (notifyNewRide.run), une exécution par course, en parallèle.
function startLocalFunction() {
  process.env.FIRESTORE_EMULATOR_HOST = `${FS_HOST}:${FS_PORT}`;
  process.env.GCLOUD_PROJECT = PROJECT_ID;
  process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT_ID });
  const req = createRequire(new URL("../functions/index.js", import.meta.url));
  const origLog = console.log;
  console.log = (...a) => {
    if (typeof a[0] === "string" && /^(tokensFor|sendTo)/.test(a[0])) return; // pas de jetons FCM ici
    origLog(...a);
  };
  const fns = req("./index.js");
  const admin = req("firebase-admin");
  const seen = new Set();
  return admin.firestore().collection("rides").onSnapshot((snap) => {
    snap.docChanges().forEach((ch) => {
      if (ch.type !== "added" || seen.has(ch.doc.id)) return;
      seen.add(ch.doc.id);
      // Délai de livraison d'un déclencheur Firestore en production (~0,3 à 1,5 s).
      setTimeout(() => {
        fns.notifyNewRide.run({ data: ch.doc, params: { rideId: ch.doc.id } })
          .catch((e) => errors.push(`notifyNewRide ${ch.doc.id}: ${e.message}`));
      }, between(300, 1500));
    });
  });
}

async function resetEmulators() {
  await fetch(`http://${FS_HOST}:${FS_PORT}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT_ID}/accounts`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Scénario
// ---------------------------------------------------------------------------
async function main() {
  await resetEmulators();
  const stopLocalFunction = process.env.SIM_FONCTION_LOCALE === "1" ? startLocalFunction() : null;
  if (stopLocalFunction) log("Mode fonction locale : notifyNewRide exécutée en parallèle, comme en production.");
  log(`Création de ${NB_DRIVERS} chauffeurs dans les émulateurs (${PROJECT_ID})…`);
  const drivers = Array.from({ length: NB_DRIVERS }, (_, i) => new Driver(i));
  for (let k = 0; k < drivers.length; k += 10) {
    await Promise.all(drivers.slice(k, k + 10).map((d) => d.init()));
  }

  // Positions : 4 chauffeurs autour de la gare (≤ 600 m), les autres dans 6 km.
  await Promise.all(drivers.map((d, i) =>
    d.setPosition(i < 4 ? pointAround(GARE, 0.6) : pointAround(CENTER, 6, 0.8))
  ));
  drivers.forEach((d) => { d.listen(); d.startMoving(); });
  log("30 chauffeurs connectés, en service, positions partagées. Début des courses dans 3 s.");
  await sleep(3000);

  const TYPES = ["taxi", "vsl", "taxi", "ambulance"];
  const PLACES = ["Hautepierre", "Neudorf", "Illkirch", "Schiltigheim", "Robertsau", "Cronenbourg",
    "Lingolsheim", "Bischheim", "Ostwald", "Koenigshoffen", "Esplanade", "Meinau"];
  const scenarios = [
    { label: "C01", where: "random" },
    { label: "C02", where: "random" },
    { label: "C03 (gare, 3 prioritaires)", where: GARE, posterIdx: 10 },
    { label: "C04", where: "random", plan: "refuse" },
    { label: "C05", where: "random", plan: "ignore" },
    { label: "C06 (Haguenau, personne proche)", where: HAGUENAU },
    { label: "C07", where: "random" },
    { label: "C08 (simultanée A)", where: "random", together: true },
    { label: "C09 (simultanée B)", where: "random", together: true },
    { label: "C10", where: "random", plan: "ignore" },
    { label: "C11 (gare bis)", where: GARE, posterIdx: 12 },
    { label: "C12", where: "random", interest: 0.03 },
  ];

  // Observateur : suit les transitions de statut et l'écriture de la priorité par le serveur.
  const obs = drivers[0];
  const lastStatus = {};
  const unsubObs = onSnapshot(query(collection(obs.db, "rides"), orderBy("createdAt", "desc"), limit(200)), (snap) => {
    snap.docs.forEach((d) => {
      const r = d.data();
      const L = R(d.id);
      if (Array.isArray(r.priorityDrivers) && L.serverPriority === undefined) {
        L.serverPriority = r.priorityDrivers;
        L.priorityWrittenAfterMs = Date.now() - r.createdAt;
        priorityWriteDelays.push(L.priorityWrittenAfterMs);
      }
      if (lastStatus[d.id] !== r.status) {
        lastStatus[d.id] = r.status;
        L.transitions.push({ rel: Date.now() - r.createdAt, status: r.status, who: r.pendingBy || r.takenBy || null });
      }
      L.final = r;
    });
  });

  let n = 0;
  for (let s = 0; s < scenarios.length; s++) {
    const sc = scenarios[s];
    const poster = drivers[sc.posterIdx ?? (4 + Math.floor(rand() * (NB_DRIVERS - 5)))];
    const p = sc.where === "random" ? pointAround(CENTER, 5) : pointAround(sc.where, 0.15);
    const id = `sim${String(++n).padStart(2, "0")}_${Math.floor(rand() * 1e6)}`;
    const ride = {
      id, type: TYPES[n % TYPES.length], patient: "Patient simulé", patientTel: "",
      depart: `${PLACES[n % PLACES.length]}, Strasbourg`, arrivee: "CHU Hautepierre, Strasbourg",
      heure: "14:30", heureRetour: "", date: new Date().toISOString().slice(0, 10), trajet: "aller",
      departLat: p.lat, departLng: p.lng, departCity: "Strasbourg", departDept: "67",
      arriveeLat: 48.5935, arriveeLng: 7.7071, arriveeCity: "Strasbourg", arriveeDept: "67",
      tarif: String(Math.round(between(25, 90))), urgent: false, tpmr: false, notes: "", photo: null,
      postedBy: poster.name, status: "disponible", takenBy: null, createdAt: Date.now(),
      lat: poster.pos.lat, lng: poster.pos.lng,
    };
    const expected = computePriorityDrivers(ride, livePositions);
    Object.assign(R(id), {
      label: sc.label, postedBy: poster.name, createdAt: ride.createdAt,
      posterPlan: sc.plan || (rand() < 0.15 ? "ignore" : "confirm"),
      interest: sc.interest ?? 0.3,
      expectedPriority: expected.map((e) => `${e.name} (${e.dist.toFixed(2)} km)`),
      expectedPriorityNames: expected.map((e) => e.name),
    });
    await setDoc(doc(poster.db, "rides", id), ride);
    log(`📣 ${poster.name} poste ${sc.label} — prioritaires attendus : ${expected.map((e) => e.name).join(", ") || "aucun"}`);
    if (!sc.together) await sleep(between(6000, 10000));
  }

  log("Toutes les courses sont postées. On laisse tourner 75 s (auto-confirmations, démarrages, fins)…");
  await sleep(75000);

  unsubObs();
  drivers.forEach((d) => d.stop());
  if (stopLocalFunction) stopLocalFunction();

  // -------------------------------------------------------------------------
  // Rapport
  // -------------------------------------------------------------------------
  const report = { rides: [], checks: [], autoConfirm, errors: errors.slice(0, 30), errorCount: errors.length };
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * p)] : null);
  report.latency = { vues: latencies.length, moyenneMs: avg(latencies), p95Ms: pct(latencies, 0.95), maxMs: Math.max(...latencies) };
  report.priorityWrite = { moyenneMs: avg(priorityWriteDelays), maxMs: Math.max(...priorityWriteDelays) };

  for (const [id, L] of Object.entries(rideLog)) {
    const final = obs.rides.get(id) || L.final || {};
    const wins = L.attempts.filter((a) => a.result === "GAGNÉ");
    const earlyWins = wins.filter((a) =>
      a.rel < PRIORITY_WINDOW_MS && (final.priorityDrivers || []).length > 0 && !(final.priorityDrivers || []).includes(a.driver)
    );
    const cheat = L.attempts.filter((a) => a.why.startsWith("tricheur"));
    report.rides.push({
      id, label: L.label, postePar: L.postedBy, planPosteur: L.posterPlan,
      prioritairesAttendus: L.expectedPriority,
      prioritairesServeur: final.priorityDrivers ?? null,
      prioriteIdentique: JSON.stringify(final.priorityDrivers ?? null) === JSON.stringify(L.expectedPriorityNames),
      prioriteEcriteApresMs: L.priorityWrittenAfterMs ?? null,
      tentatives: L.attempts.length,
      gagnants: wins.map((w) => `${w.driver} (+${(w.rel / 1000).toFixed(1)}s, ${w.why})`),
      refusesRegles: L.attempts.filter((a) => a.result === "refusé par les règles").map((a) => `${a.driver} +${(a.rel / 1000).toFixed(1)}s [${a.why}]`),
      dejaPrise: L.attempts.filter((a) => a.result === "already_taken").length,
      tricheurResultat: cheat.map((c) => c.result),
      prisesIllegalesPendantFenetre: earlyWins.map((w) => w.driver),
      confirmations: L.confirmActions.map((c) => `${c.kind} par ${c.by}`),
      statutFinal: final.status, prisePar: final.takenBy ?? null,
      transitions: L.transitions.map((t) => `${t.status}${t.who ? ` (${t.who})` : ""} @+${(t.rel / 1000).toFixed(1)}s`),
    });
  }
  report.rides.sort((a, b) => a.label.localeCompare(b.label));
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
  log(`Rapport écrit dans ${OUT_FILE}`);
  process.exit(0);
}

main().catch((e) => { console.error("ÉCHEC", e); process.exit(1); });
