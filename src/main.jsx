import React from "react";
import ReactDOM from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App.jsx";
import "./index.css";

// Vérifie et applique une nouvelle version dès qu'elle est disponible, pour qu'une
// PWA déjà installée sur l'écran d'accueil ne reste pas bloquée sur un ancien build.
registerSW({ immediate: true });

// Thème choisi par le chauffeur ("auto" | "dark" | "light"), appliqué AVANT le premier
// affichage pour éviter un flash de la mauvaise couleur au démarrage.
try {
  const theme = localStorage.getItem("rp-theme");
  if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;
} catch (e) {
  // stockage indisponible : thème automatique
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
