import { initializeApp } from "firebase/app";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  runTransaction,
  disableNetwork,
  enableNetwork,
} from "firebase/firestore";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendEmailVerification,
  sendPasswordResetEmail,
  updateProfile,
  onAuthStateChanged,
  verifyBeforeUpdateEmail,
} from "firebase/auth";
import { getMessaging, getToken, isSupported } from "firebase/messaging";
import { getFunctions, httpsCallable } from "firebase/functions";

const firebaseConfig = {
  apiKey: "AIzaSyDdydh0RLrQ9wlityD-Zbpe69OcpXNTm7c",
  authDomain: "roulepartners.firebaseapp.com",
  projectId: "roulepartners",
  storageBucket: "roulepartners.firebasestorage.app",
  messagingSenderId: "194366872374",
  appId: "1:194366872374:web:a7a253a3d8068b62577197",
};

const app = initializeApp(firebaseConfig);
// Cache local persistant (IndexedDB) : sans ça, une écriture (prendre une
// course, envoyer un message...) faite pendant que le flux temps réel est
// coupé (téléphone en veille/arrière-plan pendant 1-2h, comme en usage réel)
// ne reste qu'en mémoire — si l'appli est rechargée ou déchargée par l'OS
// avant reconnexion, l'écriture est perdue sans aucune erreur visible.
// Avec la persistance, l'écriture survit et repart dès que le réseau revient.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
export const auth = getAuth(app);
// Même région que setGlobalOptions() dans functions/index.js — sinon les appels
// aux fonctions callable échouent silencieusement (mauvaise URL).
const functions = getFunctions(app, "europe-west1");

// Force une reprise de la synchronisation dès que l'appli redevient visible
// (retour au premier plan après une longue veille) : on coupe puis on rouvre
// la connexion plutôt que d'attendre que le SDK détecte tout seul que le
// flux temps réel est mort, ce qui peut prendre du temps sur mobile.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      disableNetwork(db).then(() => enableNetwork(db)).catch(() => {});
    }
  });
}

const ridesCol = collection(db, "rides");
const positionsCol = collection(db, "positions");
const profilesCol = collection(db, "profiles");
const messagesCol = collection(db, "messages");
const licensesCol = collection(db, "licenses");
const fcmTokensCol = collection(db, "fcmTokens");

// --- Authentification ---
export function watchAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function signUp(email, password, displayName, licenseNumber, commune) {
  const normalizedLicense = licenseNumber.trim().toUpperCase().replace(/\s+/g, "");
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(cred.user, { displayName });
  // Force le rafraîchissement du jeton pour que le nom soit dispo immédiatement
  // dans les règles de sécurité Firestore (sinon le tout premier post échouerait).
  await cred.user.getIdToken(true);

  // Réserve le numéro de licence : les règles Firestore n'autorisent la création
  // de ce document que s'il n'existe pas déjà — un doublon est donc rejeté ici.
  try {
    await setDoc(doc(licensesCol, normalizedLicense), {
      owner: displayName,
      commune,
      createdAt: Date.now(),
    });
  } catch (e) {
    // Le numéro de licence est déjà utilisé par un autre compte : on annule
    // proprement la création du compte pour ne pas laisser de compte orphelin.
    await cred.user.delete().catch(() => {});
    throw new Error("license_taken");
  }

  await setDoc(doc(profilesCol, displayName), {
    email,
    licenseNumber: normalizedLicense,
    commune,
    banned: false,
    createdAt: Date.now(),
  }, { merge: true });

  await sendEmailVerification(cred.user);
  return cred.user;
}

export async function logIn(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  await cred.user.getIdToken(true);
  return cred.user;
}

export async function logOut() {
  await signOut(auth);
}

export async function resendVerificationEmail() {
  if (auth.currentUser) await sendEmailVerification(auth.currentUser);
}

export async function requestPasswordReset(email) {
  await sendPasswordResetEmail(auth, email);
}

export async function reloadUser() {
  if (auth.currentUser) {
    await auth.currentUser.reload();
    return auth.currentUser;
  }
  return null;
}

// --- Courses ---
export function listenRides(callback, maxCount = 200) {
  // Limite volontaire : au-delà de ~200 chauffeurs actifs postant plusieurs
  // courses par jour, charger tout l'historique ralentirait l'appli inutilement.
  const q = query(ridesCol, orderBy("createdAt", "desc"), limit(maxCount));
  return onSnapshot(q, (snap) => {
    const rides = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    callback(rides);
  });
}

export async function addRide(ride) {
  const ref = doc(ridesCol, ride.id);
  await setDoc(ref, ride);
}

export async function updateRide(id, patch) {
  const ref = doc(ridesCol, id);
  await updateDoc(ref, patch);
}

export async function deleteRide(id) {
  const ref = doc(ridesCol, id);
  await deleteDoc(ref);
}

// Prise d'une course en "premier arrivé, premier servi".
//
// Quand plusieurs chauffeurs sont notifiés en même temps (voir la fenêtre de
// priorité côté App.jsx), ils peuvent taper "Je la prends" à la même seconde.
// Une simple écriture laisserait le dernier arrivé écraser le premier : on
// passe donc par une transaction, qui relit le document au moment de l'écriture
// et refuse si la course n'est plus disponible. Un seul chauffeur peut gagner.
export async function claimRide(id, driverName) {
  const ref = doc(ridesCol, id);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("ride_gone");
    const data = snap.data();
    if (data.status !== "disponible") throw new Error("already_taken");
    tx.update(ref, {
      status: "en_attente",
      pendingBy: driverName,
      pendingSince: Date.now(),
    });
  });
}

// --- Positions des chauffeurs ---
export function listenPositions(callback) {
  return onSnapshot(positionsCol, (snap) => {
    const positions = {};
    snap.docs.forEach((d) => {
      positions[d.id] = d.data();
    });
    callback(positions);
  });
}

export async function setDriverPosition(name, coords) {
  const ref = doc(positionsCol, name);
  await setDoc(ref, coords);
}

export async function clearDriverPosition(name) {
  const ref = doc(positionsCol, name);
  await deleteDoc(ref);
}

export function listenProfiles(callback) {
  return onSnapshot(profilesCol, (snap) => {
    const profiles = {};
    snap.docs.forEach((d) => {
      profiles[d.id] = d.data();
    });
    callback(profiles);
  });
}

export async function setDriverPhone(name, phone) {
  const ref = doc(profilesCol, name);
  await setDoc(ref, { phone }, { merge: true });
}

// Chat lié à une course précise, entre le posteur et celui qui l'a prise.
export function listenMessages(rideId, callback) {
  const q = query(messagesCol, where("rideId", "==", rideId), orderBy("createdAt", "asc"));
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

// Écoute les messages de plusieurs courses à la fois (jusqu'à 30, limite Firestore
// pour "in") — utilisé pour l'onglet Messages, qui regroupe toutes tes conversations.
export function listenMessagesForRides(rideIds, callback) {
  if (!rideIds || rideIds.length === 0) {
    callback([]);
    return () => {};
  }
  const q = query(messagesCol, where("rideId", "in", rideIds.slice(0, 30)), orderBy("createdAt", "asc"));
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export async function sendMessage(rideId, senderName, text) {
  await addDoc(messagesCol, { rideId, senderName, text, createdAt: Date.now() });
}

// Réservé à l'administrateur (les règles Firestore vérifient aussi ce droit côté serveur).
export async function setDriverBanned(name, banned, reason = "") {
  const ref = doc(profilesCol, name);
  await setDoc(ref, { banned, bannedReason: banned ? reason : "" }, { merge: true });
}

// Réservé à l'administrateur. On ne peut pas supprimer le compte Firebase Auth
// depuis le navigateur (ça demanderait un petit programme serveur), donc on
// "supprime" ce qu'on peut : la position, les infos personnelles, et un
// bannissement permanent qui empêche toute reconnexion tant que ce n'est pas restauré.
export async function deleteDriverAccount(name) {
  await clearDriverPosition(name).catch(() => {});
  const ref = doc(profilesCol, name);
  await setDoc(ref, { banned: true, deleted: true, phone: "", commune: "" }, { merge: true });
}

export async function restoreDriverAccount(name) {
  const ref = doc(profilesCol, name);
  await setDoc(ref, { banned: false, deleted: false, bannedReason: "" }, { merge: true });
}

// Réservé à l'admin : complète les profils dont l'email n'a jamais été
// enregistré (comptes créés avant que signUp() ne le sauvegarde), en le
// recopiant depuis Firebase Auth via la fonction Cloud backfillProfileEmails.
export async function backfillProfileEmails() {
  const call = httpsCallable(functions, "backfillProfileEmails");
  const res = await call();
  return res.data;
}

// Clé publique VAPID générée dans Firebase Console > Paramètres > Cloud Messaging.
const VAPID_KEY = "BJM083fCjLvVEZNnP2NmsQM146hHmdKNIpZTIMCFx9IXScg1qJH4gWFgiEUPdGqrL_skfBXpajgSiDnRF_D5Eks";

// Enregistre ce téléphone pour recevoir de vraies notifications même appli
// fermée (via un petit programme serveur — Cloud Function). Ne fait rien si
// le navigateur ne supporte pas cette fonctionnalité (ex: anciens navigateurs).
export async function registerFcmToken(driverName) {
  try {
    const supported = await isSupported();
    if (!supported) return null;
    const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    const messaging = getMessaging(app);
    const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
    if (token) {
      await setDoc(doc(fcmTokensCol, driverName), { token, updatedAt: Date.now() }, { merge: true });
    }
    return token;
  } catch (e) {
    console.warn("Notifications push indisponibles sur cet appareil :", e);
    return null;
  }
}

// Envoie un email de confirmation à la NOUVELLE adresse — le changement ne
// devient effectif qu'une fois ce lien cliqué (sécurité standard Firebase).
export async function requestEmailChange(newEmail) {
  await verifyBeforeUpdateEmail(auth.currentUser, newEmail);
}

// Champs libres du profil (commune, société...) — un seul point d'entrée
// générique pour tout ce qui ne demande pas de logique particulière.
export async function updateProfileFields(name, fields) {
  const ref = doc(profilesCol, name);
  await setDoc(ref, fields, { merge: true });
}

// Changer de numéro de licence : libère l'ancienne réservation (les règles
// Firestore n'autorisent qu'un chauffeur à libérer la sienne) et en réserve
// une nouvelle — si le nouveau numéro est déjà pris par quelqu'un d'autre,
// l'écriture est refusée automatiquement par les règles.
export async function changeDriverLicense(driverName, oldLicense, newLicense, commune) {
  const normalized = newLicense.trim().toUpperCase().replace(/\s+/g, "");
  try {
    await setDoc(doc(licensesCol, normalized), {
      owner: driverName,
      commune,
      createdAt: Date.now(),
    });
  } catch (e) {
    throw new Error("license_taken");
  }
  if (oldLicense && oldLicense !== normalized) {
    await deleteDoc(doc(licensesCol, oldLicense)).catch(() => {});
  }
  await setDoc(doc(profilesCol, driverName), { licenseNumber: normalized }, { merge: true });
}
