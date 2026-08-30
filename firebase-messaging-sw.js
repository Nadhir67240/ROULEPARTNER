// Service worker Firebase Cloud Messaging — reçoit et affiche les
// notifications même quand l'appli RoulePartner est complètement fermée.
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
  const title = payload.notification?.title || "RoulePartner";
  const body = payload.notification?.body || "";
  self.registration.showNotification(title, {
    body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
  });
});
