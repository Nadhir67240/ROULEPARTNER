// Service worker de notifications RoulePartner.
//
// Ce fichier doit se trouver dans le dossier "public/" du projet, à la racine
// du site une fois déployé (https://roulepartner.vercel.app/firebase-messaging-sw.js).
// C'est lui qui reçoit les notifications quand l'appli est fermée ou en arrière-plan.
//
// Un service worker ne peut pas utiliser les imports du reste de l'appli :
// il charge les scripts Firebase "compat" directement depuis le CDN.

importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyDdydh0RLrQ9wlityD-Zbpe69OcpXNTm7c",
  authDomain: "roulepartners.firebaseapp.com",
  projectId: "roulepartners",
  storageBucket: "roulepartners.firebasestorage.app",
  messagingSenderId: "194366872374",
  appId: "1:194366872374:web:a7a253a3d8068b62577197",
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const n = payload.notification || {};
  const d = payload.data || {};
  const isPriority = d.priority === "true";

  self.registration.showNotification(n.title || "RoulePartner", {
    body: n.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: d.rideId || "roulepartner",
    // Une course prioritaire reste affichée tant que le chauffeur ne l'a pas vue :
    // il n'a que quelques secondes pour se décider.
    requireInteraction: isPriority,
    data: d,
  });
});

// Un clic sur la notification ramène sur l'onglet RoulePartner déjà ouvert
// s'il y en a un, plutôt que d'en ouvrir un deuxième.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      return clients.openWindow("/");
    })
  );
});
