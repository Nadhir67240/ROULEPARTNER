export let sharedAudioCtx = null;
export let audioUnlocked = false;

export function getAudioCtx() {
  if (!sharedAudioCtx) {
    sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return sharedAudioCtx;
}

export function unlockAudio() {
  if (audioUnlocked) return;
  try {
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") ctx.resume();
    // joue un son quasi silencieux pour "débloquer" définitivement l'audio sur ce téléphone
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.05);
    audioUnlocked = true;
  } catch (e) {
    // ignore
  }
}

// Vibration en plus du son : au volant ou dans le bruit, on la sent même sans
// entendre l'alerte. Sans effet sur iPhone (Safari ne gère pas l'API Vibration).
export const VIBRATION = {
  priority: [400, 150, 400, 150, 400, 150, 800],
  claim: [300, 120, 300],
  urgent: [250, 100, 250],
  normal: [200],
};
export function vibrate(kind) {
  try {
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(VIBRATION[kind] || VIBRATION.normal);
  } catch (e) {
    // ignore
  }
}

export function playAlertSound(urgent) {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") ctx.resume();
    const notes = urgent ? [880, 660, 880] : [740];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = "sine";
      gain.gain.value = urgent ? 0.15 : 0.1;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const start = ctx.currentTime + i * 0.18;
      osc.start(start);
      osc.stop(start + 0.16);
    });
  } catch (e) {
    // navigateur sans support audio, on ignore silencieusement
  }
}

// Notification visuelle du système (bannière), en plus du son.
// Fonctionne tant que le navigateur tourne (onglet ouvert, même en arrière-plan) —
// pas si l'appli est complètement fermée ou le téléphone verrouillé longtemps.
export function notifyNewRide(ride) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification(ride.urgent ? "🚨 Course urgente disponible" : "Nouvelle course disponible", {
      body: `${ride.depart} → ${ride.arrivee} — ${ride.heure}`,
      icon: "/icon-192.png",
      tag: ride.id,
    });
  } catch (e) {
    // ignore
  }
}

// Notification "course prioritaire" : plus insistante que la notification
// normale, et elle reste affichée jusqu'à ce que le chauffeur la voie
// (requireInteraction) — c'est une course qui lui est réservée quelques secondes.
export function notifyPriorityRide(ride, shared) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification("⭐ Course prioritaire pour toi", {
      body: shared
        ? `${ride.depart} → ${ride.arrivee} — premier arrivé, premier servi !`
        : `${ride.depart} → ${ride.arrivee} — tu es le plus proche.`,
      icon: "/icon-192.png",
      tag: ride.id,
      requireInteraction: true,
    });
  } catch (e) {
    // ignore
  }
}

export function notifyClaimRequest(ride) {
  playAlertSound(false);
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification("🙋 Un chauffeur veut prendre ta course", {
      body: `${ride.pendingBy} — ${ride.depart} → ${ride.arrivee}`,
      icon: "/icon-192.png",
      tag: `${ride.id}-claim`,
    });
  } catch (e) {
    // ignore
  }
}

export function notifyRideReleased(ride, takenByName) {
  playAlertSound(false);
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification("😬 Un chauffeur a relâché ta course", {
      body: `${takenByName} — ${ride.depart} → ${ride.arrivee}`,
      icon: "/icon-192.png",
      tag: `${ride.id}-released`,
    });
  } catch (e) {
    // ignore
  }
}

export function notifyStatusChange(ride, newStatus) {
  const titles = {
    en_cours: "🚗 Ta course a démarré",
    terminee: "✅ Ta course est terminée",
  };
  const title = titles[newStatus];
  if (!title) return;
  playAlertSound(false);
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification(title, {
      body: `${ride.depart} → ${ride.arrivee} — prise par ${ride.takenBy || "?"}`,
      icon: "/icon-192.png",
      tag: `${ride.id}-${newStatus}`,
    });
  } catch (e) {
    // ignore
  }
}

export function notifyNewMessage(senderName, text) {
  playAlertSound(false);
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification(`💬 Message de ${senderName}`, {
      body: text,
      icon: "/icon-192.png",
    });
  } catch (e) {
    // ignore
  }
}
