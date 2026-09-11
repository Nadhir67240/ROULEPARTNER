import React from "react";
import ReactDOM from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App.jsx";
import "./index.css";

// Vérifie et applique une nouvelle version dès qu'elle est disponible, pour qu'une
// PWA déjà installée sur l'écran d'accueil ne reste pas bloquée sur un ancien build.
registerSW({ immediate: true });

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
