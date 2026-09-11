import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // On enregistre le service worker nous-mêmes dans main.jsx (virtual:pwa-register)
      // pour qu'une mise à jour détectée recharge automatiquement l'app — sans ça, une
      // PWA déjà installée peut rester bloquée sur un ancien build en cache.
      injectRegister: false,
      includeAssets: ["icon-192.png", "icon-512.png"],
      manifest: {
        name: "RoulePartner",
        short_name: "RoulePartner",
        description:
          "Tableau de partage de courses taxi / transport médical entre chauffeurs",
        theme_color: "#1C1F26",
        background_color: "#1C1F26",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "icon-512.png",
            sizes: "512x512",
            type: "image/png",
          },
        ],
      },
    }),
  ],
});
