import React from "react";
import { Car } from "lucide-react";
import { styles } from "../styles";

// Silhouette d'un véhicule (taxi / VSL / ambulance) pour le fond de l'écran de connexion.
// `withCross` ajoute la croix d'ambulance, `roofSign` la plaque taxi lumineuse.
export function VehicleSilhouette({ x, y, scale = 1, color, withCross, roofSign }) {
  return (
    <g transform={`translate(${x},${y}) scale(${scale})`}>
      {roofSign && <rect x={44} y={-16} width={22} height={9} rx={2.5} fill={color} opacity={0.9} />}
      <path
        d="M6,34 C2,34 0,31 0,27 L0,20 C0,16 2,13 6,11 L22,11 L34,-6 C36,-9 39,-10 43,-10 L88,-10 C92,-10 95,-8 96,-4 L100,11 L114,11 C118,11 120,14 120,18 L120,27 C120,31 118,34 114,34 Z"
        fill={color}
      />
      <path d="M38,-6 L46,-6 L42,10 L30,10 Z" fill="#0F1114" opacity={0.55} />
      <path d="M52,-6 L82,-6 L86,10 L52,10 Z" fill="#0F1114" opacity={0.55} />
      {withCross && (
        <g transform="translate(64,12)">
          <rect x={-3} y={-9} width={6} height={18} rx={1.5} fill="#F2F4F7" />
          <rect x={-9} y={-3} width={18} height={6} rx={1.5} fill="#F2F4F7" />
        </g>
      )}
      <circle cx={26} cy={34} r={11} fill="#15181D" />
      <circle cx={26} cy={34} r={4.5} fill="#3A4048" />
      <circle cx={94} cy={34} r={11} fill="#15181D" />
      <circle cx={94} cy={34} r={4.5} fill="#3A4048" />
    </g>
  );
}

// Ligne ondulée (texture de fond de l'écran de démarrage) échantillonnée sur une sinusoïde.
export function wavePath(yBase, amp, freq, phase, width = 400, steps = 48) {
  let d = `M0,${(yBase + amp * Math.sin(phase)).toFixed(1)}`;
  for (let i = 1; i <= steps; i++) {
    const x = (width / steps) * i;
    const y = yBase + amp * Math.sin((i / steps) * Math.PI * 2 * freq + phase);
    d += ` L${x.toFixed(1)},${y.toFixed(1)}`;
  }
  return d;
}

// Écran de démarrage affiché une fois par session avant le formulaire de connexion :
// logo, nom de l'appli, illustration des 3 types de véhicules pris en charge, puis un
// bouton pour continuer. `splashSeen` (sessionStorage) évite de le réafficher à chaque
// rechargement pendant la même session.
export function AuthSplash({ onChoose }) {
  const waveLines = React.useMemo(() => {
    const lines = [];
    for (let i = 0; i < 15; i++) {
      lines.push({
        d: wavePath(30 + i * 42, 12 + (i % 3) * 5, 1.3 + (i % 4) * 0.25, i * 0.55, 400, 48),
        opacity: 0.05 + (i % 3) * 0.025,
      });
    }
    return lines;
  }, []);

  return (
    <div className="rp-force-dark" style={{ position: "fixed", inset: 0, overflow: "hidden", fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      {/* position:fixed + inset:0 plutôt que 100vh : sur mobile (Safari/Chrome), 100vh compte
          la hauteur avec la barre d'adresse repliée, donc le contenu déborde et se retrouve
          décentré tant qu'on n'a pas scrollé — ça colle toujours exactement à l'écran visible. */}
      <style>{`
        @keyframes rpSplashIn { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
        .rp-splash-fade { animation: rpSplashIn 0.55s ease-out both; }
      `}</style>
      <svg
        viewBox="0 0 400 860"
        preserveAspectRatio="xMidYMid slice"
        style={{ position: "fixed", inset: 0, width: "100%", height: "100%", zIndex: 0 }}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="splashBgGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0B0E1A" />
            <stop offset="55%" stopColor="#10142A" />
            <stop offset="100%" stopColor="#161B33" />
          </linearGradient>
        </defs>
        <rect width={400} height={860} fill="url(#splashBgGrad)" />
        {waveLines.map((w, i) => (
          <path key={i} d={w.d} stroke="#8FA6FF" strokeWidth={1} fill="none" opacity={w.opacity} />
        ))}
      </svg>

      <div
        className="rp-splash-fade"
        style={{
          position: "relative", zIndex: 1, height: "100%", boxSizing: "border-box",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: "calc(env(safe-area-inset-top, 0px) + 20px) 22px calc(env(safe-area-inset-bottom, 0px) + 20px)",
          textAlign: "center", gap: 0, overflowY: "auto",
        }}
      >
        <div style={{ ...styles.logoBadgeLarge, width: 52, height: 52, margin: "0 auto 10px", boxShadow: "0 0 36px rgba(255,180,58,0.45)" }}>
          <Car size={24} color="#1A1206" />
          <span style={styles.logoBeaconLarge} />
        </div>

        <h1 style={{ fontFamily: "'Manrope', sans-serif", fontSize: 28, fontWeight: 800, letterSpacing: 0.2, margin: 0 }}>
          <span style={{ color: "#F2F4F7" }}>Roule</span>
          <span style={{ color: "#FFB43A" }}>Partner</span>
        </h1>

        <div style={{ display: "flex", width: 90, height: 3, borderRadius: 2, overflow: "hidden", margin: "9px 0 9px" }}>
          <span style={{ flex: 1, background: "#4169E1" }} />
          <span style={{ flex: 1, background: "#F2F4F7" }} />
          <span style={{ flex: 1, background: "#E5484D" }} />
        </div>

        <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: 2.5, color: "#9AA4C7", textTransform: "uppercase", margin: 0 }}>
          Signalez · Partagez · Roulez
        </p>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", margin: "14px 0" }}>
          <svg viewBox="0 0 400 160" width="100%" style={{ maxWidth: 260 }} aria-hidden="true">
            <defs>
              <linearGradient id="vehGradTaxi" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#FFC968" />
                <stop offset="100%" stopColor="#F0A020" />
              </linearGradient>
              <linearGradient id="vehGradAmb" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#F0897A" />
                <stop offset="100%" stopColor="#D85242" />
              </linearGradient>
              <linearGradient id="vehGradVsl" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#5FE096" />
                <stop offset="100%" stopColor="#28A860" />
              </linearGradient>
              <radialGradient id="vehShadow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#000" stopOpacity={0.45} />
                <stop offset="100%" stopColor="#000" stopOpacity={0} />
              </radialGradient>
            </defs>
            <ellipse cx={70} cy={148} rx={55} ry={9} fill="url(#vehShadow)" />
            <ellipse cx={210} cy={152} rx={65} ry={10} fill="url(#vehShadow)" />
            <ellipse cx={345} cy={148} rx={50} ry={9} fill="url(#vehShadow)" />
            <VehicleSilhouette x={16} y={110} scale={0.82} color="url(#vehGradTaxi)" roofSign />
            <VehicleSilhouette x={150} y={104} scale={1} color="url(#vehGradAmb)" withCross />
            <VehicleSilhouette x={292} y={112} scale={0.76} color="url(#vehGradVsl)" />
          </svg>
        </div>

        <p style={{ fontSize: 13.5, color: "#C6CCE6", lineHeight: 1.4, maxWidth: 300, margin: 0 }}>
          Taxi, VSL, ambulance : partagez vos courses entre pros, fini les groupes WhatsApp.
        </p>

        <div style={{ marginTop: 12, display: "inline-flex", alignItems: "center", gap: 7, padding: "5px 12px", borderRadius: 20, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" }}>
          <span style={{ width: 16, height: 11, borderRadius: 2, background: "linear-gradient(to right, #0055A4 33%, #fff 33% 66%, #EF4135 66%)" }} />
          <span style={{ fontSize: 11.5, color: "#C6CCE6" }}>Plateforme 100% française</span>
        </div>

        <div style={{ display: "flex", gap: 10, width: "100%", maxWidth: 320, marginTop: 18 }}>
          <button
            type="button"
            onClick={() => onChoose("login")}
            style={{ ...styles.btnPrimary, flex: 1, justifyContent: "center" }}
          >
            Se connecter
          </button>
          <button
            type="button"
            onClick={() => onChoose("signup")}
            style={{ ...styles.btnGhost, flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            S'inscrire
          </button>
        </div>
      </div>
    </div>
  );
}

// Fond fixe (dégradé + halos de couleur) derrière la carte de connexion.
export function AuthBackdrop() {
  return (
    <svg
      viewBox="0 0 400 820"
      preserveAspectRatio="xMidYMid slice"
      style={{ position: "fixed", inset: 0, width: "100%", height: "100%", zIndex: 0, pointerEvents: "none" }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="authBgGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0F1114" />
          <stop offset="60%" stopColor="#101317" />
          <stop offset="100%" stopColor="#15181D" />
        </linearGradient>
        <radialGradient id="authGlowAmber" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#FFB43A" stopOpacity={0.3} />
          <stop offset="100%" stopColor="#FFB43A" stopOpacity={0} />
        </radialGradient>
        <radialGradient id="authGlowGreen" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#3BD07A" stopOpacity={0.24} />
          <stop offset="100%" stopColor="#3BD07A" stopOpacity={0} />
        </radialGradient>
      </defs>
      <rect width={400} height={820} fill="url(#authBgGrad)" />
      <circle cx={40} cy={120} r={220} fill="url(#authGlowAmber)" />
      <circle cx={370} cy={200} r={200} fill="url(#authGlowGreen)" />
    </svg>
  );
}

// Bandeau "route" avec taxi / ambulance / VSL, placé sous la carte de connexion
// (dans le flux normal de la page, pas en fond superposé) pour rester visible
// même sur un écran mobile étroit où la carte occupe presque toute la largeur.
export function AuthVehicleStrip() {
  return (
    <div
      style={{
        position: "relative",
        zIndex: 1,
        maxWidth: 380,
        margin: "0 auto 24px",
        borderRadius: 14,
        overflow: "hidden",
        border: "1px solid #23272E",
        boxShadow: "0 12px 30px rgba(0,0,0,0.4)",
      }}
    >
      <svg viewBox="0 0 400 140" width="100%" height="140" aria-hidden="true">
        <rect width={400} height={140} fill="#131519" />
        {Array.from({ length: 9 }).map((_, i) => (
          <rect key={i} x={i * 46 + 6} y={28} width={22} height={3} rx={1.5} fill="#2A2F36" />
        ))}
        <VehicleSilhouette x={16} y={84} scale={0.78} color="#FFB43A" roofSign />
        <VehicleSilhouette x={150} y={78} scale={0.94} color="#E86E5E" withCross />
        <VehicleSilhouette x={290} y={86} scale={0.72} color="#3BD07A" />
      </svg>
    </div>
  );
}
