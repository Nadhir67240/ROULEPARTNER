import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  Car, MapPin, Clock, User, Plus, Check, Trash2, Siren,
  Stethoscope, X, Navigation, Timer, LogOut, ChevronUp, ChevronLeft, ChevronRight, MessageCircle, Home,
  Phone, List, Map as MapIcon, History, CalendarDays,
  FileText, Settings, Building2, Shield, Send, Euro, Copy, Pencil,
  Users, LayoutDashboard, LifeBuoy, Mail, Filter, Bell,
} from "lucide-react";
import {
  listenRides, listenMyRides, addRide, updateRide, deleteRide, claimRide,
  listenPositions, setDriverPosition, clearDriverPosition,
  listenProfiles, setDriverPhone,
  listenMessages, sendMessage, listenMessagesForRides,
  requestEmailChange, updateProfileFields, changeDriverLicense,
  setDriverBanned, deleteDriverAccount, restoreDriverAccount, registerFcmToken, backfillProfileEmails, assignProfileEmail, syncDriversWithAuth,
  watchAuthState, signUp, logIn, logOut, resendVerificationEmail, reloadUser, requestPasswordReset,
  listenForegroundMessages,
} from "./firebase";
import { TYPES, TRAJET_TYPES, trajetLabel, PRIORITY_WINDOW_MS, POSITION_FRESH_MS, AVG_SPEED_KMH, CLAIM_CONFIRM_WINDOW_MS, AUTO_PURGE_DAYS, ADMIN_EMAIL, emptyForm, uid, typeMeta, tintBg, statusColor } from "./lib/constants";
import { DEPARTMENT_KM_RATES, DEFAULT_DEPARTMENT, DEFAULT_KM_RATE, computeTaxiConventionneTarif, autoDetectNightWeekend, addressCityDept, isGrandeVilleZone, matchesGrandeVilleExtension } from "./lib/tarif";
import { formatPostedAt, dateKey, todayKey, timePlusMinutes, formatRideDate, FRENCH_MONTHS, formatDayMonth, FRENCH_WEEKDAYS_SHORT, keyFromDate, dateFromKey, addDaysKey, startOfWeekKey, rideTimingBadge, thisWeekRange } from "./lib/dates";
import { unlockAudio, vibrate, playAlertSound, notifyNewRide, notifyPriorityRide, notifyClaimRequest, notifyRideReleased, notifyStatusChange, notifyRideModified, notifyNewMessage } from "./lib/alerts";
import { loadRideDraft, saveRideDraft, clearRideDraft, loadRecentAddresses, saveRecentAddress } from "./lib/storage";
import { computePriorityDrivers, distanceKm, fetchRoadDistanceKm, ridePickupCoords, wazeUrl, googleMapsUrl, cardLocality, shortAddress, isMedicalPoi, fetchBanSuggestions, interleaveResults, rankAddressResults, suggestionDistanceLabel } from "./lib/geo";
import { compressPhoto, openPdfDocument } from "./lib/files";
import { AuthSplash, AuthBackdrop, AuthVehicleStrip } from "./components/AuthScreens";
import { styles } from "./styles";

// "Mes courses" : couleurs choisies hors de la palette des types de course
// (orange taxi, bleu payante, vert VSL, rouge ambulance) pour ne pas les confondre.
const MY_TAKEN_COLOR = "#22B8CF";  // course prise à un autre chauffeur
const MY_POSTED_COLOR = "#B07CF2"; // course donnée (postée par moi)

// Ce qui a changé entre la course acceptée et la version corrigée par le posteur, formulé
// pour le chauffeur qui l'a prise (bandeau "Course modifiée après acceptation").
const TAKER_WATCHED_FIELDS = [
  ["depart", "Départ"],
  ["arrivee", "Arrivée"],
  ["date", "Date", (v) => (v ? formatRideDate(v) : "")],
  ["heure", "Heure"],
  ["heureRetour", "Heure retour"],
  ["trajet", "Trajet", (v) => (v ? trajetLabel(v) : "")],
  ["type", "Type", (v) => (v ? typeMeta(v).label : "")],
  ["tarif", "Tarif", (v) => (v ? `${v} €` : "")],
  ["tpmr", "TPMR", (v) => (v ? "oui" : "non")],
  ["patient", "Patient"],
  ["patientTel", "Téléphone patient"],
  ["notes", "Notes"],
];
function rideChangesForTaker(before, after) {
  const changes = [];
  for (const [field, label, fmt = (v) => v ?? ""] of TAKER_WATCHED_FIELDS) {
    const from = String(fmt(before[field]) || "");
    const to = String(fmt(after[field]) || "");
    if (from !== to) changes.push({ field, label, from, to });
  }
  if ((before.photo || null) !== (after.photo || null)) changes.push({ field: "photo", label: "Photo du bon", from: "", to: after.photo ? "modifiée" : "retirée" });
  if ((before.document || null) !== (after.document || null)) changes.push({ field: "document", label: "PDF du bon", from: "", to: after.document ? "modifié" : "retiré" });
  return changes;
}

// --- Messagerie : petites aides d'affichage ---
const CHAT_QUICK_REPLIES = ["J'arrive", "Je suis sur place", "Bien reçu 👍", "Petit retard, j'arrive", "Je te rappelle"];
// Deux messages du même chauffeur à moins de 5 min d'écart forment un seul bloc.
const CHAT_GROUP_GAP_MS = 5 * 60 * 1000;
function chatInitials(name) {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
function chatTime(ts) {
  return ts ? new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "";
}
function chatDayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Aujourd'hui";
  if (d.toDateString() === yesterday.toDateString()) return "Hier";
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
}
// Heure pour la liste des conversations : l'heure si c'est aujourd'hui, sinon la date courte.
function chatListTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (d.toDateString() === new Date().toDateString()) return chatTime(ts);
  const label = chatDayLabel(ts);
  return label === "Hier" ? "Hier" : d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authDisplayName, setAuthDisplayName] = useState("");
  const [authLicense, setAuthLicense] = useState("");
  const [authCommune, setAuthCommune] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [splashSeen, setSplashSeen] = useState(() => {
    try { return sessionStorage.getItem("rp_splash_seen") === "1"; } catch { return false; }
  });
  const dismissSplash = () => {
    try { sessionStorage.setItem("rp_splash_seen", "1"); } catch {}
    setSplashSeen(true);
  };
  const driverName = user?.displayName || "";
  const [rides, setRides] = useState([]);
  const [myRides, setMyRides] = useState([]); // historique complet du chauffeur (listenMyRides)
  const [positions, setPositions] = useState({});
  const [profiles, setProfiles] = useState({});
  const [phoneInput, setPhoneInput] = useState("");
  const [chatRideId, setChatRideId] = useState(null);
  const [allMyMessages, setAllMyMessages] = useState([]);
  const [showMessagesPanel, setShowMessagesPanel] = useState(false);
  const [lastReadByRide, setLastReadByRide] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("rp-last-read") || "{}");
    } catch (e) {
      return {};
    }
  });
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const chatScrollRef = useRef(null);
  const chatInputRef = useRef(null);
  const [showAccountPanel, setShowAccountPanel] = useState(false);
  const [showMyCoursesPanel, setShowMyCoursesPanel] = useState(false);
  // Thème : "auto" (suit le téléphone), "light" ou "dark". main.jsx l'applique déjà au
  // démarrage ; ici on le garde à jour quand le chauffeur le change dans Réglages.
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("rp-theme") || "auto";
    } catch (e) {
      return "auto";
    }
  });
  useEffect(() => {
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("rp-theme", theme);
    } catch (e) {
      // ignore
    }
  }, [theme]);

  const [myCoursesView, setMyCoursesView] = useState("liste"); // "liste" | "calendrier"
  const [calPeriod, setCalPeriod] = useState("jour"); // "jour" | "semaine" | "mois"
  const [calAnchor, setCalAnchor] = useState(() => todayKey(0));
  const [calSelectedDay, setCalSelectedDay] = useState(() => todayKey(0));

  const markRideRead = (rideId) => {
    setLastReadByRide((prev) => {
      const next = { ...prev, [rideId]: Date.now() };
      localStorage.setItem("rp-last-read", JSON.stringify(next));
      return next;
    });
  };

  useEffect(() => {
    if (showAccountPanel && profiles[driverName]) {
      const p = profiles[driverName];
      setCommuneInput(p.commune || "");
      setLicenseInput(p.licenseNumber || "");
      setCompanyInput({
        companyName: p.companyName || "",
        siret: p.siret || "",
        companyAddress: p.companyAddress || "",
      });
    }
  }, [showAccountPanel, driverName, profiles]);

  useEffect(() => {
    if (!chatRideId) return;
    const unsub = listenMessages(chatRideId, setChatMessages);
    markRideRead(chatRideId);
    return () => unsub();
  }, [chatRideId]);

  // Continue à marquer comme lu tant que la conversation reste ouverte à l'écran.
  useEffect(() => {
    if (chatRideId && chatMessages.length > 0) markRideRead(chatRideId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages, chatRideId]);

  // On fait défiler la zone des messages elle-même (et pas la page) : scrollIntoView
  // décalait toute la fenêtre sur mobile et faisait déborder la discussion en bas.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (chatRideId && el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [chatMessages, chatRideId]);

  // Hauteur réellement visible (sans le clavier) : la discussion s'y cale pour que la
  // zone de saisie reste toujours au-dessus du clavier et de la barre de navigation.
  const [chatViewport, setChatViewport] = useState(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!chatRideId || !vv) return;
    const update = () => setChatViewport({ height: vv.height, top: vv.offsetTop });
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      setChatViewport(null);
    };
  }, [chatRideId]);

  // La zone de saisie grandit avec le texte (jusqu'à ~5 lignes).
  useEffect(() => {
    const el = chatInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [chatInput, chatRideId]);

  const handleSendMessage = async (preset) => {
    const text = (typeof preset === "string" ? preset : chatInput).trim();
    if (!text || !chatRideId) return;
    if (typeof preset !== "string") setChatInput("");
    try {
      await sendMessage(chatRideId, driverName, text);
    } catch (e) {
      if (typeof preset !== "string") setChatInput(text);
      setError("Échec de l'envoi du message.");
    }
  };
  const [myPosStatus, setMyPosStatus] = useState("idle");
  const [filter, setFilter] = useState("dispo");
  useEffect(() => {
    filterRef.current = filter;
    if (filter === "dispo") setNewRidesBadge(0);
  }, [filter]);
  const [dateFilter, setDateFilter] = useState("");
  const [radiusFilter, setRadiusFilter] = useState(() => localStorage.getItem("radius-filter") || "50");

  const updateRadiusFilter = (value) => {
    setRadiusFilter(value);
    localStorage.setItem("radius-filter", value);
  };
  const [initialDraft] = useState(loadRideDraft);
  const [showForm, setShowForm] = useState(() => !!initialDraft);
  const [formStep, setFormStep] = useState(() => initialDraft?.formStep || 1);
  const [pickupMode, setPickupMode] = useState(() => initialDraft?.pickupMode ?? null); // null | "now" | "time" | "datetime"
  const [form, setForm] = useState(() => (initialDraft ? { ...emptyForm, ...initialDraft.form } : emptyForm));
  const [error, setError] = useState("");
  const [, setTick] = useState(0);
  const [selectedRide, setSelectedRide] = useState(null);
  const [accountSubPanel, setAccountSubPanel] = useState(null); // null | "profile" | "settings" | "company" | "dashboard" | "support"
  const [newEmailInput, setNewEmailInput] = useState("");
  const [emailChangeStatus, setEmailChangeStatus] = useState(null); // null | { ok, text }
  const [communeInput, setCommuneInput] = useState("");
  const [licenseInput, setLicenseInput] = useState("");
  const [licenseChangeStatus, setLicenseChangeStatus] = useState(null); // null | { ok, text }
  const [companyInput, setCompanyInput] = useState({ companyName: "", siret: "", companyAddress: "" });
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [emailRepairStatus, setEmailRepairStatus] = useState(null); // null | "loading" | { updated, checked } | { error }
  // Résultat de la synchro avec Firebase Auth : null tant qu'elle n'a pas répondu
  // (on affiche alors tout ce qu'on connaît), sinon les chauffeurs qui existent encore.
  const [authSync, setAuthSync] = useState(null); // null | "loading" | { removed, activeNames } | { error }
  useEffect(() => {
    if (!showAdminPanel || user?.email !== ADMIN_EMAIL) return;
    setAuthSync("loading");
    syncDriversWithAuth()
      .then(setAuthSync)
      .catch((e) => setAuthSync({ error: e.message || "Échec" }));
  }, [showAdminPanel, user]);
  const [showFiltersPanel, setShowFiltersPanel] = useState(false);
  const [showNotifPanel, setShowNotifPanel] = useState(false);
  const [newRidesBadge, setNewRidesBadge] = useState(0);
  const filterRef = useRef("dispo");
  const [banTarget, setBanTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [banReason, setBanReason] = useState("");
  const [bannedNotice, setBannedNotice] = useState(false);
  const isAdmin = user?.email === ADMIN_EMAIL;
  const [pulling, setPulling] = useState(false);
  const pullStartY = useRef(null);

  useEffect(() => {
    const PULL_THRESHOLD = 70;

    // Le "tirer pour rafraîchir" ne vaut que pour la page principale : si le doigt part
    // d'une fenêtre ouverte (modale, chat, fiche course, formulaire… tous en position
    // fixe) ou d'une zone qui défile elle-même, un glissement vers le bas ne doit pas
    // recharger l'appli — sinon on perd l'écran en cours et on revient à l'accueil.
    const startsInOverlayOrScroller = (target) => {
      for (let el = target; el && el !== document.body; el = el.parentElement) {
        const cs = window.getComputedStyle(el);
        if (cs.position === "fixed") return true;
        if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && el.scrollHeight > el.clientHeight) return true;
      }
      return false;
    };

    const onTouchStart = (e) => {
      if (window.scrollY <= 0 && !startsInOverlayOrScroller(e.target)) {
        pullStartY.current = e.touches[0].clientY;
      } else {
        pullStartY.current = null;
      }
    };
    const onTouchMove = (e) => {
      if (pullStartY.current == null) return;
      const delta = e.touches[0].clientY - pullStartY.current;
      setPulling(delta > PULL_THRESHOLD);
    };
    const onTouchEnd = () => {
      if (pulling) {
        window.location.reload();
      }
      pullStartY.current = null;
      setPulling(false);
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [pulling]);
  const [notifPermission, setNotifPermission] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported"
  );

  useEffect(() => {
    if (driverName && notifPermission === "granted") {
      registerFcmToken(driverName);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driverName]);

  // Le service worker n'affiche les push que si l'appli est en arrière-plan — quand
  // l'onglet est ouvert au premier plan (cas typique pendant qu'un chauffeur regarde
  // sa course se faire prendre), Firebase livre le message silencieusement au JS de la
  // page. Ce listener rattrape ce cas en affichant quand même la notification.
  useEffect(() => {
    if (!driverName) return;
    listenForegroundMessages((payload) => {
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
      const n = payload.notification || {};
      const d = payload.data || {};
      navigator.serviceWorker?.getRegistration().then((reg) => {
        if (!reg) return;
        reg.showNotification(n.title || "RoulePartner", {
          body: n.body || "",
          icon: "/icon-192.png",
          badge: "/icon-192.png",
          tag: d.rideId || "roulepartner",
          renotify: true,
          data: d,
        });
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driverName]);

  const handleEmailChange = async () => {
    if (!newEmailInput.trim()) return;
    setEmailChangeStatus(null);
    try {
      await requestEmailChange(newEmailInput.trim());
      setEmailChangeStatus({ ok: true, text: "Email de confirmation envoyé à " + newEmailInput.trim() + " — clique sur le lien reçu pour valider le changement." });
      setNewEmailInput("");
    } catch (e) {
      setEmailChangeStatus({
        ok: false,
        text: e.code === "auth/requires-recent-login"
          ? "Pour ta sécurité, reconnecte-toi (déconnexion puis reconnexion) avant de changer d'email."
          : "Échec de l'envoi — vérifie l'adresse et réessaie.",
      });
    }
  };

  const handleLicenseChange = async () => {
    if (!licenseInput.trim()) return;
    setLicenseChangeStatus(null);
    try {
      await changeDriverLicense(driverName, profiles[driverName]?.licenseNumber || "", licenseInput.trim(), communeInput.trim());
      setLicenseChangeStatus({ ok: true, text: "Numéro de licence mis à jour." });
    } catch (e) {
      setLicenseChangeStatus({
        ok: false,
        text: e.message === "license_taken"
          ? "Ce numéro de licence est déjà associé à un autre compte."
          : "Échec de la mise à jour.",
      });
    }
  };

  const requestNotifPermission = async () => {
    if (typeof Notification === "undefined") return;
    const perm = await Notification.requestPermission();
    setNotifPermission(perm);
    if (perm === "granted" && driverName) {
      registerFcmToken(driverName);
    }
  };

  const [driverDept, setDriverDept] = useState(() => {
    return localStorage.getItem("taxi-department") || DEFAULT_DEPARTMENT;
  });
  const kmRate = DEPARTMENT_KM_RATES.find(([code]) => code === driverDept)?.[2] || DEFAULT_KM_RATE;

  const updateDriverDept = (code) => {
    setDriverDept(code);
    localStorage.setItem("taxi-department", code);
  };
  const [departSuggestions, setDepartSuggestions] = useState([]);
  const [arriveeSuggestions, setArriveeSuggestions] = useState([]);
  const [searchingAddress, setSearchingAddress] = useState(false);
  const [activeField, setActiveField] = useState(null);
  const [recentAddresses, setRecentAddresses] = useState(loadRecentAddresses);
  const [suggestionActiveIndex, setSuggestionActiveIndex] = useState(-1);
  const debounceRef = useRef(null);
  const debounceRefArrivee = useRef(null);
  const photoInputRef = useRef(null);
  const photoLibraryInputRef = useRef(null); // sans "capture" : ouvre la photothèque au lieu de l'appareil photo
  const documentInputRef = useRef(null);
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const mapMarkersRef = useRef({});
  const mapMarkerStatusRef = useRef({}); // name -> "busy"/"free" déjà affiché, pour éviter de recréer l'icône inutilement
  const [editingId, setEditingId] = useState(null);
  // Course telle qu'elle était à l'ouverture de "Modifier" : sert à repérer ce qui a changé
  // quand le posteur corrige une course déjà acceptée, pour prévenir le chauffeur.
  const editOriginalRideRef = useRef(null);
  // Bandeaux "course modifiée" déjà vus par ce chauffeur : { [rideId]: modifiedAfterAccept.at }.
  const [seenModifs, setSeenModifs] = useState(() => {
    try { return JSON.parse(localStorage.getItem("rp-seen-modifs") || "{}"); } catch { return {}; }
  });
  const markModifSeen = (r) => {
    const next = { ...seenModifs, [r.id]: r.modifiedAfterAccept?.at };
    setSeenModifs(next);
    try { localStorage.setItem("rp-seen-modifs", JSON.stringify(next)); } catch {}
  };
  // Bandeau pour le chauffeur qui a pris (ou demandé) une course corrigée ensuite par le posteur.
  const renderModifBanner = (r, { compact = false } = {}) => {
    const modif = r.modifiedAfterAccept;
    if (!modif?.changes?.length || r.postedBy === driverName) return null;
    if (r.takenBy !== driverName && r.pendingBy !== driverName) return null;
    if (modif.forDriver !== driverName || seenModifs[r.id] === modif.at) return null;
    if (compact) {
      return (
        <div style={styles.modifBanner}>
          ⚠️ Course modifiée par {r.postedBy} : ouvre-la pour voir ce qui a changé
        </div>
      );
    }
    return (
      <div style={styles.modifBanner}>
        <div style={{ marginBottom: 6 }}>⚠️ Course modifiée après acceptation par {r.postedBy}</div>
        {modif.changes.map((c) => (
          <div key={c.field} style={{ fontWeight: 500, fontSize: 13.5, marginTop: 3 }}>
            <strong>{c.label}</strong> : {c.from ? <><s>{c.from}</s> → </> : null}{c.to || "(vide)"}
          </div>
        ))}
        <button type="button" onClick={() => markModifSeen(r)} style={{ ...styles.btnUtilityAction, marginTop: 10 }}>
          <Check size={14} /> J'ai vu
        </button>
      </div>
    );
  };

  // Sauvegarde du brouillon à chaque modification tant que le formulaire de NOUVELLE
  // course est ouvert ; effacé dès qu'il se ferme (publié ou annulé). Les modifications
  // d'une course existante ne sont pas concernées : la course est déjà enregistrée.
  useEffect(() => {
    if (!showForm) {
      clearRideDraft();
      return;
    }
    if (editingId) return;
    saveRideDraft({ form, formStep, pickupMode, savedAt: Date.now() });
  }, [showForm, editingId, form, formStep, pickupMode]);

  // Pendant la saisie, le geste "tirer vers le bas" ne doit pas recharger la page.
  useEffect(() => {
    if (!showForm) return;
    const html = document.documentElement;
    const prev = [html.style.overscrollBehaviorY, document.body.style.overscrollBehaviorY];
    html.style.overscrollBehaviorY = "contain";
    document.body.style.overscrollBehaviorY = "contain";
    return () => {
      html.style.overscrollBehaviorY = prev[0];
      document.body.style.overscrollBehaviorY = prev[1];
    };
  }, [showForm]);
  // Valeurs "tarif-sensibles" de la course telle qu'elle existait avant l'ouverture de la
  // modification (adresses, trajet, majorations). Le formulaire d'édition se remplit avec ces
  // mêmes valeurs, ce qui ne doit PAS déclencher de recalcul (sinon on écraserait un tarif déjà
  // facturé rien qu'en ouvrant la course) — mais dès que le chauffeur modifie l'une d'elles
  // (typiquement l'adresse de départ ou d'arrivée), la comparaison ci-dessous ne correspond
  // plus et le recalcul doit reprendre normalement.
  const editOriginalTarifInputs = useRef(null);
  // Le pied de page du parcours réutilise la même position pour "Continuer" (étapes 1-3) et
  // "Publier" (étape 4) : un appui un peu long ou un double-tap machinal du chauffeur peut
  // donc retomber sur "Publier" pile au moment où l'étape 4 apparaît, avant qu'il ait eu le
  // temps de voir/relire quoi que ce soit. On ignore une soumission trop rapide après ce
  // passage à l'étape 4 pour laisser le temps de lire l'écran avant de pouvoir publier.
  const step3EnteredAtRef = useRef(0);
  const wizBodyRef = useRef(null);
  const knownRideIds = useRef(new Map()); // id -> dernier statut connu
  // L'écouteur Firestore est monté une seule fois : il ne "voit" pas les mises à
  // jour d'état React. On garde donc les positions dans un ref pour pouvoir
  // calculer la priorité au moment exact où une course arrive.
  const positionsRef = useRef(positions);
  const [priorityAlert, setPriorityAlert] = useState(null); // { ride, shared }
  const [claimAlert, setClaimAlert] = useState(null); // { ride } — un chauffeur veut prendre une course que j'ai postée
  const [releaseAlert, setReleaseAlert] = useState(null); // { ride, takenByName } — un chauffeur a relâché une course que j'ai postée
  const knownMessageIds = useRef(new Set());
  const firstMessagesLoad = useRef(true);
  const knownProfileNames = useRef(new Set());
  const firstProfilesLoad = useRef(true);
  const firstLoad = useRef(true);

  // Zone privilégiée pour les résultats (Alsace : Strasbourg, Haguenau, Colmar, Mulhouse…)
  // — la recherche reste possible partout en France, mais les résultats de cette zone
  // remontent en priorité, ce qui accélère et fiabilise la recherche au quotidien.
  const ALSACE_VIEWBOX = "6.8,49.1,8.3,47.4"; // gauche,haut,droite,bas

  const searchAddress = (query, setSuggestions, ref = debounceRef) => {
    clearTimeout(ref.current);
    if (query.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    // Si le chauffeur est "en service" (position connue), on cherche en priorité
    // autour de lui plutôt qu'autour d'une zone fixe — plus pertinent au quotidien.
    const here = positions[driverName] || null;
    const viewbox = here
      ? `${here.lng - 0.6},${here.lat + 0.6},${here.lng + 0.6},${here.lat - 0.6}`
      : ALSACE_VIEWBOX;
    ref.current = setTimeout(async () => {
      setSearchingAddress(true);
      try {
        // Deux sources combinées : la Base Adresse Nationale (service public français)
        // tolère bien mieux les fautes de frappe sur les adresses de rue, tandis que
        // Nominatim/OSM connaît les lieux nommés (hôpitaux, cliniques, pharmacies...)
        // que la BAN ignore. On les interroge en parallèle et on fusionne le résultat.
        // namedetails=1 fait remonter le nom des lieux en plus de l'adresse brute ;
        // dedupe=1 évite les doublons du même lieu côté Nominatim.
        const [banResults, nominatimResults] = await Promise.all([
          fetchBanSuggestions(query, here).catch(() => []),
          fetch(
            `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&namedetails=1&dedupe=1&countrycodes=fr&limit=8&viewbox=${viewbox}&bounded=0&q=${encodeURIComponent(query)}`
          )
            .then((res) => res.json())
            .catch(() => []),
        ]);
        setSuggestions(rankAddressResults(interleaveResults(banResults, nominatimResults), here));
      } catch (e) {
        setSuggestions([]);
      } finally {
        setSearchingAddress(false);
      }
    }, 200);
  };

  // Source de suggestions active pour un champ : les adresses récentes tant que la saisie
  // est trop courte pour interroger le service, sinon les résultats de recherche en direct.
  const suggestionListFor = (field) => {
    const value = field === "depart" ? form.depart : form.arrivee;
    if (value.trim().length < 3) return recentAddresses;
    return field === "depart" ? departSuggestions : arriveeSuggestions;
  };

  const pickAddressSuggestion = (field, item) => {
    const address = item.recent ? item.address : shortAddress(item);
    const lat = item.recent ? item.lat : parseFloat(item.lat);
    const lng = item.recent ? item.lng : parseFloat(item.lon);
    // Commune/département déjà connus pour un choix récent, sinon extraits du résultat de
    // recherche — servent à détecter automatiquement le forfait "grande ville" (taxi conventionné).
    const { city, dept } = item.recent ? { city: item.city || "", dept: item.dept || "" } : addressCityDept(item);
    if (field === "depart") {
      setForm({ ...form, depart: address, departLat: lat, departLng: lng, departCity: city, departDept: dept });
      setDepartSuggestions([]);
    } else {
      setForm({ ...form, arrivee: address, arriveeLat: lat, arriveeLng: lng, arriveeCity: city, arriveeDept: dept });
      setArriveeSuggestions([]);
    }
    setActiveField(null);
    setSuggestionActiveIndex(-1);
    setRecentAddresses(saveRecentAddress({ address, lat, lng, city, dept }));
  };

  // Navigation clavier (↑/↓/Entrée/Échap) dans la liste de suggestions, pour choisir
  // une adresse sans quitter le clavier — plus rapide que de viser au doigt sur mobile.
  const handleAddressKeyDown = (field, e) => {
    if (activeField !== field) return;
    const list = suggestionListFor(field);
    if (list.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSuggestionActiveIndex((i) => Math.min(i + 1, list.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSuggestionActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && suggestionActiveIndex >= 0) {
      e.preventDefault();
      pickAddressSuggestion(field, list[suggestionActiveIndex]);
    } else if (e.key === "Escape") {
      setActiveField(null);
    }
  };

  useEffect(() => {
    const unsub = watchAuthState((u) => {
      setUser(u);
      setAuthLoading(false);
      // Déconnecté : on jette le brouillon de course (il peut contenir des infos patient)
      // pour qu'un autre chauffeur se connectant sur ce téléphone ne le retrouve pas.
      if (!u) {
        clearRideDraft();
        setShowForm(false);
        setForm(emptyForm);
        setFormStep(1);
        setPickupMode(null);
      }
    });
    return () => unsub();
  }, []);

  const handleSignUp = async (e) => {
    e.preventDefault();
    setAuthError("");
    if (!authDisplayName.trim()) {
      setAuthError("Indique ton nom ou pseudo.");
      return;
    }
    if (!authLicense.trim()) {
      setAuthError("Le numéro de licence est obligatoire.");
      return;
    }
    if (!authCommune.trim()) {
      setAuthError("La commune de rattachement est obligatoire.");
      return;
    }
    if (authPassword.length < 6) {
      setAuthError("Le mot de passe doit faire au moins 6 caractères.");
      return;
    }
    setAuthBusy(true);
    try {
      await signUp(authEmail.trim(), authPassword, authDisplayName.trim(), authLicense.trim(), authCommune.trim());
    } catch (err) {
      setAuthError(
        err.message === "license_taken" ? "Ce numéro de licence est déjà associé à un autre compte." :
        err.code === "auth/email-already-in-use" ? "Cet email a déjà un compte — connecte-toi plutôt." :
        err.code === "auth/invalid-email" ? "Adresse email invalide." :
        "Échec de l'inscription. Vérifie tes infos et réessaie."
      );
    }
    setAuthBusy(false);
  };

  const handleLogIn = async (e) => {
    e.preventDefault();
    setAuthError("");
    setAuthBusy(true);
    try {
      await logIn(authEmail.trim(), authPassword);
    } catch (err) {
      setAuthError("Email ou mot de passe incorrect.");
    }
    setAuthBusy(false);
  };

  const handleForgotPassword = async () => {
    setAuthError("");
    setResetSent(false);
    if (!authEmail.trim()) {
      setAuthError("Indique ton email pour recevoir le lien de réinitialisation.");
      return;
    }
    setAuthBusy(true);
    try {
      await requestPasswordReset(authEmail.trim());
    } catch (err) {
      // On ne distingue pas "compte inexistant" des autres cas dans le message
      // affiché, pour ne pas révéler si un email est associé à un compte.
      if (err.code === "auth/invalid-email") {
        setAuthError("Adresse email invalide.");
        setAuthBusy(false);
        return;
      }
      if (err.code !== "auth/user-not-found") {
        setAuthError("Échec de l'envoi. Réessaie plus tard.");
        setAuthBusy(false);
        return;
      }
    }
    setResetSent(true);
    setAuthBusy(false);
  };

  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("touchstart", unlock, { once: true });
    window.addEventListener("click", unlock, { once: true });
    return () => {
      window.removeEventListener("touchstart", unlock);
      window.removeEventListener("click", unlock);
    };
  }, []);

  useEffect(() => {
    const unsubRides = listenRides((newRides) => {
      if (!firstLoad.current) {
        newRides.forEach((r) => {
          const prevInfo = knownRideIds.current.get(r.id);
          const prevStatus = prevInfo?.status;
          const isNew = prevInfo === undefined;
          if (isNew && r.status === "disponible" && r.postedBy !== driverName) {
            playAlertSound(r.urgent);
            // Suis-je dans le groupe prioritaire sur cette course ?
            const prio = computePriorityDrivers(r, positionsRef.current);
            const iAmPriority = prio.some((d) => d.name === driverName);
            if (iAmPriority) {
              // Alerte plein écran, où que je sois dans l'appli : je ne suis pas
              // sorti de mon écran courant, la course s'affiche par-dessus.
              notifyPriorityRide(r, prio.length > 1);
              vibrate("priority");
              setPriorityAlert({ ride: r, shared: prio.length > 1 });
            } else {
              notifyNewRide(r);
              vibrate(r.urgent ? "urgent" : "normal");
            }
            if (filterRef.current !== "dispo") setNewRidesBadge((n) => n + 1);
          }
          if (!isNew && prevStatus !== r.status && r.postedBy === driverName) {
            notifyStatusChange(r, r.status);
            if (r.status === "en_attente" && r.pendingBy) {
              // Où que je sois dans l'appli, un popup s'affiche par-dessus pour
              // me dire tout de suite qui veut prendre la course que j'ai postée.
              notifyClaimRequest(r);
              vibrate("claim");
              setClaimAlert({ ride: r });
            }
            if (r.status === "disponible" && prevStatus === "prise" && prevInfo?.takenBy) {
              // Le chauffeur qui l'avait prise l'a relâchée avant de la commencer —
              // même traitement popup que pour une demande de prise.
              notifyRideReleased(r, prevInfo.takenBy);
              setReleaseAlert({ ride: r, takenByName: prevInfo.takenBy });
            }
          }
          const modifAt = r.modifiedAfterAccept?.at || null;
          if (!isNew && modifAt && modifAt !== prevInfo?.modifAt && r.postedBy !== driverName
            && r.modifiedAfterAccept.forDriver === driverName) {
            notifyRideModified(r);
            vibrate("claim");
          }
        });
      }
      knownRideIds.current = new Map(newRides.map((r) => [r.id, { status: r.status, takenBy: r.takenBy, modifAt: r.modifiedAfterAccept?.at || null }]));
      firstLoad.current = false;
      setRides(newRides);
    });
    const unsubPos = listenPositions((newPositions) => {
      positionsRef.current = newPositions;
      setPositions(newPositions);
    });
    const unsubProfiles = listenProfiles((newProfiles) => {
      if (!firstProfilesLoad.current && isAdmin) {
        Object.keys(newProfiles).forEach((name) => {
          if (!knownProfileNames.current.has(name)) {
            playAlertSound(false);
            if (typeof Notification !== "undefined" && Notification.permission === "granted") {
              try {
                new Notification("🆕 Nouveau chauffeur inscrit", {
                  body: `${name} vient de créer un compte sur RoulePartner.`,
                  icon: "/icon-192.png",
                });
              } catch (e) {
                // ignore
              }
            }
          }
        });
      }
      knownProfileNames.current = new Set(Object.keys(newProfiles));
      firstProfilesLoad.current = false;
      setProfiles(newProfiles);
    });
    return () => {
      unsubRides();
      unsubPos();
      unsubProfiles();
    };
  }, [driverName]);

  // Liste des courses où je suis impliqué (posteur, preneur, ou en attente) —
  // sert à récupérer tous les messages qui me concernent, tous fils confondus.
  const myRideIdsKey = useMemo(() => {
    const ids = rides
      .filter((r) => r.postedBy === driverName || r.takenBy === driverName || r.pendingBy === driverName)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 30)
      .map((r) => r.id);
    return ids.join(",");
  }, [rides, driverName]);

  useEffect(() => {
    if (!driverName) return;
    const ids = myRideIdsKey ? myRideIdsKey.split(",") : [];
    if (ids.length === 0) {
      // Pas encore de course connue (ex: juste après connexion, avant que /rides
      // se charge) — on ne touche pas au suivi "premier chargement" tant qu'on
      // n'a pas de vraies données, sinon les prochains vrais messages seraient
      // à tort traités comme "nouveaux" et renotifiés même s'ils sont déjà lus.
      setAllMyMessages([]);
      return;
    }
    const unsub = listenMessagesForRides(ids, (msgs) => {
      if (!firstMessagesLoad.current) {
        msgs.forEach((m) => {
          if (!knownMessageIds.current.has(m.id) && m.senderName !== driverName) {
            notifyNewMessage(m.senderName, m.text);
          }
        });
      }
      msgs.forEach((m) => knownMessageIds.current.add(m.id));
      firstMessagesLoad.current = false;
      setAllMyMessages(msgs);
    });
    return () => unsub();
  }, [myRideIdsKey, driverName]);

  // Si l'admin bannit ce chauffeur, on le déconnecte immédiatement, même en pleine session.
  useEffect(() => {
    if (driverName && !isAdmin && profiles[driverName]?.banned) {
      setBannedNotice(true);
      logOut();
    }
  }, [profiles, driverName, isAdmin]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const ridesRef = useRef(rides);
  useEffect(() => {
    ridesRef.current = rides;
  }, [rides]);

  // Mesure partielle de protection des données : purge automatiquement les courses
  // terminées depuis plus de AUTO_PURGE_DAYS (photo et notes incluses). Ce n'est pas
  // une vraie purge serveur planifiée (ça demanderait un service payant), donc ça ne
  // se déclenche que si au moins un chauffeur a l'appli ouverte.
  useEffect(() => {
    const cutoff = Date.now() - AUTO_PURGE_DAYS * 24 * 60 * 60 * 1000;
    ridesRef.current.forEach((r) => {
      if (r.status === "terminee" && r.createdAt < cutoff) {
        deleteRide(r.id).catch(() => {});
      }
    });
  }, [rides]);

  const driverNameRef = useRef(driverName);
  useEffect(() => {
    driverNameRef.current = driverName;
  }, [driverName]);

  // Auto-confirmation après CLAIM_CONFIRM_WINDOW_MS. Seuls le posteur et le demandeur
  // la tentent : les règles Firestore refusent tous les autres, et si chaque téléphone
  // ouvert essayait chaque seconde, les refus en boucle bloquaient leurs autres
  // écritures (prises de course comprises) — constaté en simulation à 30 chauffeurs.
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const me = driverNameRef.current;
      ridesRef.current.forEach((r) => {
        if (!me || (r.postedBy !== me && r.pendingBy !== me)) return;
        if (r.status === "en_attente" && r.pendingSince && now - r.pendingSince > CLAIM_CONFIRM_WINDOW_MS) {
          confirmClaim(r);
        }
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Ferme l'alerte prioritaire quand la fenêtre de 30 s est écoulée, ou dès
  // qu'un autre chauffeur a pris la course entre-temps.
  useEffect(() => {
    if (!priorityAlert) return;
    const check = () => {
      const current = ridesRef.current.find((x) => x.id === priorityAlert.ride.id);
      const expired = Date.now() >= priorityWindowEndsAt(priorityAlert.ride);
      if (expired || !current || current.status !== "disponible") {
        setPriorityAlert(null);
      }
    };
    check();
    const id = setInterval(check, 500);
    return () => clearInterval(id);
  }, [priorityAlert, rides]);

  // Ferme le popup "on veut prendre ta course" dès que ce n'est plus vrai —
  // confirmée (par moi ou automatiquement après 30s), refusée, ou annulée par
  // le chauffeur qui l'avait demandée.
  useEffect(() => {
    if (!claimAlert) return;
    const current = ridesRef.current.find((x) => x.id === claimAlert.ride.id);
    if (!current || current.status !== "en_attente" || current.pendingBy !== claimAlert.ride.pendingBy) {
      setClaimAlert(null);
    }
  }, [claimAlert, rides]);

  // Le popup "course relâchée" est purement informatif — il se ferme tout seul
  // après quelques secondes plutôt que d'attendre une action.
  useEffect(() => {
    if (!releaseAlert) return;
    const id = setTimeout(() => setReleaseAlert(null), 8000);
    return () => clearTimeout(id);
  }, [releaseAlert]);

  const watchIdRef = useRef(null);

  // [0] : refus des règles Firestore (compte pas encore reconnu, ou banni) ; [1] : autre échec.
  const POSITION_SHARE_ERRORS = [
    "Ta position n'a pas pu être partagée : ton compte n'est pas encore reconnu. Ferme complètement l'appli puis rouvre-la. Si ça continue, contacte l'administrateur.",
    "Ta position n'a pas pu être partagée pour le moment. Vérifie ta connexion internet, l'appli réessaie toute seule dès que tu bouges.",
  ];

  const sharePosition = () => {
    // Si le suivi est déjà actif, ce clic l'arrête (et retire le point de la carte).
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
      setMyPosStatus("idle");
      localStorage.setItem("rp-sharing-enabled", "0");
      clearDriverPosition(driverName).catch(() => {});
      return;
    }
    if (!navigator.geolocation) {
      setMyPosStatus("denied");
      return;
    }
    setMyPosStatus("locating");
    watchIdRef.current = navigator.geolocation.watchPosition(
      async (pos) => {
        const coords = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          updatedAt: Date.now(),
        };
        setMyPosStatus("ok");
        localStorage.setItem("rp-sharing-enabled", "1");
        try {
          await setDriverPosition(driverName, coords);
          // Le partage refonctionne : on retire l'éventuel message d'échec affiché plus tôt.
          setError((prev) => (POSITION_SHARE_ERRORS.includes(prev) ? "" : prev));
        } catch (e) {
          setError(e?.code === "permission-denied" ? POSITION_SHARE_ERRORS[0] : POSITION_SHARE_ERRORS[1]);
        }
      },
      () => setMyPosStatus("denied"),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
  };

  // Si le chauffeur était "en service" avant de fermer complètement l'appli
  // (balayage pour quitter), on réactive automatiquement le partage au
  // prochain lancement — plus besoin de retaper le bouton à chaque fois.
  const autoResumedSharingRef = useRef(false);
  useEffect(() => {
    if (!driverName || autoResumedSharingRef.current) return;
    if (localStorage.getItem("rp-sharing-enabled") === "1") {
      autoResumedSharingRef.current = true;
      sharePosition();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driverName]);

  // En service (position partagée), on garde l'écran allumé : pas de veille qui ferait
  // rater une alerte ou couperait l'envoi du GPS. Le navigateur relâche ce verrou dès
  // que l'appli passe en arrière-plan, donc on le redemande à chaque retour au premier plan.
  useEffect(() => {
    if (myPosStatus !== "ok" || typeof navigator === "undefined" || !navigator.wakeLock) return;
    let lock = null;
    let cancelled = false;
    const acquire = async () => {
      if (document.visibilityState !== "visible" || (lock && !lock.released)) return;
      try {
        lock = await navigator.wakeLock.request("screen");
        if (cancelled) lock.release().catch(() => {});
      } catch (e) {
        // refusé (batterie faible, navigateur non compatible…) : on ignore
      }
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", acquire);
      if (lock) lock.release().catch(() => {});
    };
  }, [myPosStatus]);

  // Coupe le suivi GPS si la page se ferme, pour ne pas laisser le capteur tourner inutilement.
  useEffect(() => {
    return () => {
      if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current);
    };
  }, []);

  const handlePost = async (e) => {
    e.preventDefault();
    if (Date.now() - step3EnteredAtRef.current < 500) return;
    await submitRide();
  };

  // Enregistre la course du formulaire. Appelé par la dernière étape ET par la
  // publication express de l'étape 2 (patient, notes et pièces jointes facultatifs).
  const postingRef = useRef(false);
  const submitRide = async () => {
    if (!form.depart || !form.arrivee || !form.heure) return;
    if (postingRef.current) return; // double appui : une seule publication
    postingRef.current = true;
    const myPos = positions[driverName] || null;
    try {
      if (editingId) {
        // Version la plus récente de la course : elle a pu être acceptée pendant la saisie.
        const original = rides.find((r) => r.id === editingId) || myRides.find((r) => r.id === editingId) || editOriginalRideRef.current;
        const patch = { ...form };
        if (original && original.status !== "disponible") {
          const changes = rideChangesForTaker(original, form);
          if (changes.length) {
            // On cumule avec les corrections précédentes : le bandeau montre tout ce qui a changé
            // depuis l'acceptation, en gardant pour chaque champ la valeur d'origine.
            const sameDriver = original.modifiedAfterAccept?.forDriver === (original.takenBy || original.pendingBy || null);
            const previous = sameDriver ? original.modifiedAfterAccept?.changes || [] : [];
            const merged = previous.filter((c) => !changes.some((n) => n.field === c.field));
            for (const c of changes) {
              const prev = previous.find((p) => p.field === c.field);
              const from = prev ? prev.from : c.from;
              if (from !== c.to || c.field === "photo" || c.field === "document") merged.push({ ...c, from });
            }
            // "forDriver" : si la course est relâchée puis reprise par un autre, il ne verra pas ce bandeau.
            const forDriver = original.takenBy || original.pendingBy || null;
            patch.modifiedAfterAccept = merged.length ? { at: Date.now(), forDriver, changes: merged } : null;
          }
        }
        await updateRide(editingId, patch);
      } else {
        const newRide = {
          id: uid(),
          ...form,
          postedBy: driverName,
          status: "disponible",
          takenBy: null,
          createdAt: Date.now(),
          lat: myPos ? myPos.lat : null,
          lng: myPos ? myPos.lng : null,
        };
        await addRide(newRide);
      }
      setForm(emptyForm);
      setEditingId(null);
      setShowForm(false);
      setFormStep(1);
      setPickupMode(null);
    } catch (e) {
      setError("Échec de l'enregistrement (vérifie ta config Firebase).");
    } finally {
      postingRef.current = false;
    }
  };

  // Remonte en haut du contenu à chaque changement d'étape du parcours, pour que le titre
  // de la nouvelle étape soit toujours visible tout de suite (sans ça, si le chauffeur avait
  // fait défiler l'étape précédente, la suivante pouvait s'afficher déjà scrollée).
  useEffect(() => {
    if (wizBodyRef.current) wizBodyRef.current.scrollTop = 0;
  }, [formStep]);

  const swapDepartArrivee = () => {
    setForm((f) => ({
      ...f,
      depart: f.arrivee,
      arrivee: f.depart,
      departLat: f.arriveeLat,
      departLng: f.arriveeLng,
      departCity: f.arriveeCity,
      departDept: f.arriveeDept,
      arriveeLat: f.departLat,
      arriveeLng: f.departLng,
      arriveeCity: f.departCity,
      arriveeDept: f.departDept,
    }));
  };

  // Coche/décoche automatiquement "Nuit/dimanche/férié" dès que l'heure change,
  // selon la règle de la convention. Le chauffeur peut toujours corriger à la main
  // ensuite (par exemple pour un jour férié, qu'on ne peut pas détecter tout seul).
  useEffect(() => {
    if (form.type !== "taxi") return;
    const orig = editOriginalTarifInputs.current;
    if (orig && orig.heure === form.heure) return; // heure inchangée depuis l'ouverture de la modification
    const auto = autoDetectNightWeekend(form.heure);
    setForm((f) => (f.majorationNuitWeekend === auto ? f : { ...f, majorationNuitWeekend: auto }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.heure, form.type]);

  // Coche/décoche automatiquement le forfait "grande ville" dès que le départ ou l'arrivée
  // change, selon la liste officielle (arrêté du 29 juillet 2025) et la liste des établissements
  // limitrophes ajoutés par extension par la Cnam. Le chauffeur garde la main pour corriger au
  // cas où un autre établissement limitrophe non répertorié ici en bénéficierait aussi.
  useEffect(() => {
    if (form.type !== "taxi") return;
    const orig = editOriginalTarifInputs.current;
    if (
      orig &&
      orig.departCity === form.departCity && orig.departDept === form.departDept &&
      orig.arriveeCity === form.arriveeCity && orig.arriveeDept === form.arriveeDept &&
      orig.depart === form.depart && orig.arrivee === form.arrivee
    ) {
      return; // adresses inchangées depuis l'ouverture de la modification
    }
    const auto =
      isGrandeVilleZone(form.departCity, form.departDept) || isGrandeVilleZone(form.arriveeCity, form.arriveeDept) ||
      matchesGrandeVilleExtension(form.depart) || matchesGrandeVilleExtension(form.arrivee);
    setForm((f) => (f.grandeVille === auto ? f : { ...f, grandeVille: auto }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.departCity, form.departDept, form.arriveeCity, form.arriveeDept, form.depart, form.arrivee, form.type]);

  // Recalcule automatiquement le tarif "Taxi conventionné" dès que la distance,
  // le trajet ou les majorations changent — plus besoin de cliquer sur un bouton.
  // Essaie d'abord la vraie distance routière (OSRM), retombe sur le vol d'oiseau
  // si le service externe ne répond pas.
  const [calculatingTarif, setCalculatingTarif] = useState(false);
  useEffect(() => {
    if (form.type !== "taxi") return;
    const orig = editOriginalTarifInputs.current;
    if (
      orig &&
      orig.departLat === form.departLat && orig.departLng === form.departLng &&
      orig.arriveeLat === form.arriveeLat && orig.arriveeLng === form.arriveeLng &&
      orig.trajet === form.trajet && orig.grandeVille === form.grandeVille &&
      orig.majorationNuitWeekend === form.majorationNuitWeekend &&
      orig.retourAVide === form.retourAVide && orig.tpmr === form.tpmr
    ) {
      return; // rien de tarif-sensible n'a changé depuis l'ouverture de la modification
    }
    const depart = { lat: form.departLat, lng: form.departLng };
    const arrivee = { lat: form.arriveeLat, lng: form.arriveeLng };
    if (depart.lat == null || arrivee.lat == null) return;
    let cancelled = false;
    setCalculatingTarif(true);
    (async () => {
      let distKm = await fetchRoadDistanceKm(depart, arrivee);
      let isRoadDistance = true;
      if (distKm == null) {
        distKm = distanceKm(depart, arrivee);
        isRoadDistance = false;
      }
      if (cancelled || distKm == null) {
        setCalculatingTarif(false);
        return;
      }
      const computed = computeTaxiConventionneTarif({
        distKm,
        allerRetour: form.trajet === "allerRetour",
        kmRate,
        grandeVille: form.grandeVille,
        majoration: form.majorationNuitWeekend,
        retourAVide: form.retourAVide,
        tpmr: form.tpmr,
      });
      setForm((f) => ({
        ...f,
        tarif: String(computed),
        calcDistanceKm: Math.round(distKm * 10) / 10,
        calcIsRoadDistance: isRoadDistance,
      }));
      setCalculatingTarif(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    form.type, form.trajet, form.departLat, form.departLng,
    form.arriveeLat, form.arriveeLng, form.grandeVille, form.majorationNuitWeekend,
    form.retourAVide, form.tpmr, kmRate,
  ]);

  const handlePhotoChange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await compressPhoto(file);
      setForm((f) => ({ ...f, photo: dataUrl }));
      setError("");
    } catch (err) {
      setError("Photo trop lourde ou illisible, essaie une autre image.");
    }
  };

  const MAX_PDF_SIZE = 600 * 1024; // 600 Ko — au-delà, ça ne tient plus dans un document Firestore
  const handleDocumentChange = (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (file.type !== "application/pdf") {
      setError("Seuls les fichiers PDF sont acceptés pour le bon de transport.");
      return;
    }
    if (file.size > MAX_PDF_SIZE) {
      setError("PDF trop volumineux (max ~600 Ko) — essaie de le compresser ou de le rescanner en plus léger.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setForm((f) => ({ ...f, document: reader.result, documentName: file.name }));
      setError("");
    };
    reader.onerror = () => setError("Échec de la lecture du PDF, réessaie.");
    reader.readAsDataURL(file);
  };

  const startEdit = (r) => {
    editOriginalRideRef.current = r;
    editOriginalTarifInputs.current = {
      departLat: r.departLat, departLng: r.departLng, arriveeLat: r.arriveeLat, arriveeLng: r.arriveeLng,
      departCity: r.departCity || "", departDept: r.departDept || "", arriveeCity: r.arriveeCity || "", arriveeDept: r.arriveeDept || "",
      depart: r.depart, arrivee: r.arrivee,
      trajet: r.trajet, grandeVille: r.grandeVille || false, majorationNuitWeekend: r.majorationNuitWeekend || false,
      retourAVide: r.retourAVide || false, tpmr: r.tpmr || false, heure: r.heure,
    };
    setForm({
      type: r.type, patient: r.patient, patientTel: r.patientTel || "", depart: r.depart, arrivee: r.arrivee,
      heure: r.heure, heureRetour: r.heureRetour || "", date: r.date || todayKey(0), trajet: r.trajet, tarif: r.tarif, urgent: r.urgent, tpmr: r.tpmr || false, notes: r.notes,
      departLat: r.departLat, departLng: r.departLng, departCity: r.departCity || "", departDept: r.departDept || "",
      arriveeLat: r.arriveeLat, arriveeLng: r.arriveeLng, arriveeCity: r.arriveeCity || "", arriveeDept: r.arriveeDept || "",
      grandeVille: r.grandeVille || false, majorationNuitWeekend: r.majorationNuitWeekend || false,
      retourAVide: r.retourAVide || false, calcDistanceKm: r.calcDistanceKm ?? null, calcIsRoadDistance: r.calcIsRoadDistance ?? false,
      photo: r.photo || null, document: r.document || null, documentName: r.documentName || "",
    });
    setEditingId(r.id);
    setShowForm(true);
    setFormStep(1);
    setPickupMode("datetime");
    setSelectedRide(null);
  };

  const duplicateRide = (r) => {
    editOriginalTarifInputs.current = null;
    setForm({
      type: r.type, patient: r.patient, patientTel: r.patientTel || "", depart: r.depart, arrivee: r.arrivee,
      heure: "", heureRetour: "", date: todayKey(0), trajet: r.trajet, tarif: r.tarif, urgent: false, tpmr: r.tpmr || false, notes: r.notes,
      departLat: r.departLat, departLng: r.departLng, departCity: r.departCity || "", departDept: r.departDept || "",
      arriveeLat: r.arriveeLat, arriveeLng: r.arriveeLng, arriveeCity: r.arriveeCity || "", arriveeDept: r.arriveeDept || "",
      grandeVille: r.grandeVille || false, majorationNuitWeekend: r.majorationNuitWeekend || false,
      retourAVide: r.retourAVide || false, calcDistanceKm: r.calcDistanceKm ?? null, calcIsRoadDistance: r.calcIsRoadDistance ?? false,
      photo: r.photo || null, document: r.document || null, documentName: r.documentName || "",
    });
    setEditingId(null);
    setShowForm(true);
    setFormStep(1);
    setPickupMode(null);
    setSelectedRide(null);
  };

  // "Je la prends" ne prend plus la course directement : ça envoie une demande.
  // Le posteur a un délai pour confirmer, sinon c'est validé automatiquement.
  // Plusieurs chauffeurs prioritaires peuvent taper en même temps : la
  // transaction côté Firestore n'en laisse passer qu'un seul, les autres
  // reçoivent "already_taken" et sont prévenus proprement.
  const claim = async (ride) => {
    try {
      await claimRide(ride.id, driverName);
      // Ouvre directement la fenêtre de détail sur la course qu'on vient de
      // prendre, pour que le chauffeur voie tout de suite le compte à rebours
      // de confirmation sans avoir à la rechercher dans la liste.
      setSelectedRide(ride);
    } catch (e) {
      if (e.message === "already_taken") {
        setError("Trop tard — un autre chauffeur vient de prendre cette course.");
        setSelectedRide(null);
      } else if (e.message === "ride_gone") {
        setError("Cette course n'existe plus.");
        setSelectedRide(null);
      } else if (e.code === "permission-denied") {
        // Refus des règles : priorité pas encore attribuée par le serveur, ou réservée
        // à un chauffeur plus proche pendant la fenêtre.
        setError("Cette course n'est pas encore ouverte pour toi — réessaie dans quelques secondes.");
      } else {
        setError("Échec de l'action.");
      }
    }
  };

  const confirmClaim = async (ride) => {
    try {
      await updateRide(ride.id, { status: "prise", takenBy: ride.pendingBy, pendingBy: null, pendingSince: null, pendingAt: null });
    } catch (e) {
      setError("Échec de l'action.");
    }
  };

  const refuseClaim = async (id) => {
    try {
      await updateRide(id, { status: "disponible", pendingBy: null, pendingSince: null, pendingAt: null });
    } catch (e) {
      setError("Échec de l'action.");
    }
  };

  const cancelMyClaim = async (id) => {
    try {
      await updateRide(id, { status: "disponible", pendingBy: null, pendingSince: null, pendingAt: null });
    } catch (e) {
      setError("Échec de l'action.");
    }
  };

  const startRide = async (id) => {
    try {
      await updateRide(id, { status: "en_cours", startedAt: Date.now() });
    } catch (e) {
      setError("Échec de l'action.");
    }
  };

  const markDone = async (id) => {
    try {
      await updateRide(id, { status: "terminee" });
    } catch (e) {
      setError("Échec de l'action.");
    }
  };

  // Ne garde que les chauffeurs ayant partagé leur position récemment (15 min) —
  // si un chauffeur arrête de partager ou ferme l'appli, il disparaît de la carte.
  const MAP_STALE_MS = 15 * 60 * 1000;
  const myPosForMap = positions[driverName] || null;
  const busyDriverNames = new Set(
    rides.filter((r) => r.status === "en_cours" && r.takenBy).map((r) => r.takenBy)
  );
  const mapDrivers = Object.entries(positions).filter(([name, pos]) => {
    if (!pos.updatedAt || Date.now() - pos.updatedAt >= MAP_STALE_MS) return false;
    if (radiusFilter === "all" || !myPosForMap || name === driverName) return true;
    const d = distanceKm(myPosForMap, pos);
    return d == null || d <= parseFloat(radiusFilter);
  });

  useEffect(() => {
    if (filter !== "carte" || !mapContainerRef.current) return;

    if (!mapInstanceRef.current) {
      const center = mapDrivers.length > 0
        ? [mapDrivers[0][1].lat, mapDrivers[0][1].lng]
        : [48.5734, 7.7521]; // Strasbourg par défaut
      const map = L.map(mapContainerRef.current, { zoomControl: false }).setView(center, 11);
      L.control.zoom({ position: "bottomright" }).addTo(map);
      // Style "Voyager" (CARTO) — clé gratuite (jusqu'à 5 millions de requêtes/mois),
      // plus détaillé et lisible que le rendu OpenStreetMap classique.
      L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=cb1_28sf_1_983cff967a2309e37d83fc04", {
        attribution: "© OpenStreetMap contributors © CARTO",
        maxZoom: 19,
      }).addTo(map);
      mapInstanceRef.current = map;
      // Leaflet a besoin d'un recalcul de taille une fois le conteneur bien affiché.
      setTimeout(() => map.invalidateSize(), 200);
    }

    const map = mapInstanceRef.current;
    const currentNames = new Set(mapDrivers.map(([name]) => name));

    // Retire les marqueurs des chauffeurs qui ne sont plus visibles
    Object.keys(mapMarkersRef.current).forEach((name) => {
      if (!currentNames.has(name)) {
        map.removeLayer(mapMarkersRef.current[name]);
        delete mapMarkersRef.current[name];
        delete mapMarkerStatusRef.current[name];
      }
    });

    // Ajoute ou déplace les marqueurs des chauffeurs visibles
    mapDrivers.forEach(([name, pos]) => {
      const isMe = name === driverName;
      const isBusy = busyDriverNames.has(name);
      const statusKey = `${isMe ? "me" : "other"}-${isBusy ? "busy" : "free"}`;
      if (mapMarkersRef.current[name]) {
        mapMarkersRef.current[name].setLatLng([pos.lat, pos.lng]);
        // On ne touche à l'icône que si le statut a vraiment changé — la
        // recréer à chaque mise à jour de position perturbait le zoom sur la carte.
        if (mapMarkerStatusRef.current[name] !== statusKey) {
          const carBg = isMe ? "#FFB43A" : "var(--border-subtle)";
          const statusColor = isBusy ? "#E5484D" : "#3BD07A";
          mapMarkersRef.current[name].setIcon(L.divIcon({
            className: "",
            html: `
              <div style="position:relative;width:34px;height:34px;">
                <div style="background:${carBg};width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;border:2px solid var(--bg-screen);box-shadow:0 2px 6px rgba(0,0,0,0.4);">🚗</div>
                <span style="position:absolute;top:-2px;right:-2px;width:13px;height:13px;border-radius:50%;background:${statusColor};border:2px solid var(--bg-screen);"></span>
              </div>
            `,
            iconSize: [34, 34],
            iconAnchor: [17, 17],
          }));
          mapMarkerStatusRef.current[name] = statusKey;
        }
      } else {
        const carBg = isMe ? "#FFB43A" : "var(--border-subtle)";
        const statusColor = isBusy ? "#E5484D" : "#3BD07A";
        const icon = L.divIcon({
          className: "",
          html: `
            <div style="position:relative;width:34px;height:34px;">
              <div style="background:${carBg};width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;border:2px solid var(--bg-screen);box-shadow:0 2px 6px rgba(0,0,0,0.4);">🚗</div>
              <span style="position:absolute;top:-2px;right:-2px;width:13px;height:13px;border-radius:50%;background:${statusColor};border:2px solid var(--bg-screen);"></span>
            </div>
          `,
          iconSize: [34, 34],
          iconAnchor: [17, 17],
        });
        const marker = L.marker([pos.lat, pos.lng], { icon }).addTo(map);
        marker.bindPopup(`<strong>${name}${isMe ? " (toi)" : ""}</strong>${isBusy ? " — 🔴 en course" : " — 🟢 libre"}`);
        mapMarkersRef.current[name] = marker;
        mapMarkerStatusRef.current[name] = statusKey;
      }
    });
  }, [filter, positions, driverName, rides]);

  // Nettoie la carte quand on quitte l'onglet, pour éviter les doublons au retour.
  useEffect(() => {
    if (filter !== "carte" && mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
      mapMarkersRef.current = {};
    }
  }, [filter]);

  const release = async (id) => {
    try {
      await updateRide(id, { status: "disponible", takenBy: null });
    } catch (e) {
      setError("Échec de l'action.");
    }
  };

  const remove = async (id) => {
    try {
      await deleteRide(id);
    } catch (e) {
      setError("Échec de la suppression.");
    }
  };

  // Chauffeurs prioritaires sur une course. Dès que le serveur a eu le temps d'écrire sa
  // propre liste sur le document (r.priorityDrivers — voir functions/index.js), on s'y fie :
  // c'est elle qui fait foi pour l'attribution réelle (règles de sécurité Firestore). Avant ça
  // (les toutes premières secondes après la publication, le temps que la Cloud Function se
  // déclenche), on retombe sur une estimation locale utilisant le même algorithme que le
  // serveur, pour que l'alerte de priorité et le verrouillage de "Je la prends" réagissent
  // instantanément sans attendre le serveur — la transaction Firestore garantit de toute façon
  // qu'un seul chauffeur gagne si plusieurs tapent en même temps.
  const priorityDriversFor = (ride) => {
    if (Array.isArray(ride.priorityDrivers)) {
      return ride.priorityDrivers.map((name) => ({ name, dist: null }));
    }
    return computePriorityDrivers(ride, positions);
  };

  // Fin de la fenêtre de priorité : la valeur écrite par le serveur (priorityUntil) fait foi
  // dès qu'elle existe, sinon on l'estime depuis l'heure de création de la course.
  const priorityWindowEndsAt = (ride) => ride.priorityUntil ?? (ride.createdAt + PRIORITY_WINDOW_MS);

  // Tant que la Cloud Function n'a pas écrit priorityDrivers (≈1 s après la publication,
  // plus si elle démarre à froid), les règles Firestore refusent TOUTE prise, même d'un
  // chauffeur prioritaire : on grise donc "Je la prends" plutôt que de laisser le
  // chauffeur tomber sur un échec incompréhensible.
  const awaitingServerPriority = (ride) =>
    ride.status === "disponible" && !Array.isArray(ride.priorityDrivers);

  const renderAwaitingClaimBtn = (style) => (
    <button disabled style={{ ...style, opacity: 0.55, cursor: "wait" }} onClick={(e) => e.stopPropagation()}>
      <Timer size={14} style={{ marginRight: 4 }} /> Attribution en cours…
    </button>
  );

  const myPos = positions[driverName] || null;

  // Regroupe tous les messages par course pour construire la liste des
  // conversations (dernier message, interlocuteur, nombre de non-lus).
  const conversations = useMemo(() => {
    const byRide = {};
    allMyMessages.forEach((m) => {
      if (!byRide[m.rideId]) byRide[m.rideId] = [];
      byRide[m.rideId].push(m);
    });
    return Object.entries(byRide)
      .map(([rideId, msgs]) => {
        const ride = rides.find((r) => r.id === rideId);
        const last = msgs[msgs.length - 1];
        const lastRead = lastReadByRide[rideId] || 0;
        const unread = msgs.filter((m) => m.senderName !== driverName && m.createdAt > lastRead).length;
        const otherParty = ride
          ? (ride.postedBy === driverName ? ride.takenBy || ride.pendingBy : ride.postedBy)
          : "?";
        return { rideId, ride, last, unread, otherParty };
      })
      .filter((c) => c.last)
      .sort((a, b) => b.last.createdAt - a.last.createdAt);
  }, [allMyMessages, rides, lastReadByRide, driverName]);

  const totalUnreadMessages = conversations.reduce((sum, c) => sum + c.unread, 0);

  // Certains comptes créés avant l'ajout de la création automatique de profil
  // n'ont pas de fiche dans /profiles — on les retrouve quand même via les
  // courses postées/prises ou une position déjà partagée, pour que
  // l'administration les voie tous, même les plus anciens.
  const allKnownDriverNames = Array.from(new Set([
    ...Object.keys(profiles),
    ...Object.keys(positions),
    ...rides.map((r) => r.postedBy).filter(Boolean),
    ...rides.map((r) => r.takenBy).filter(Boolean),
  ]));
  // Dans l'administration, on ne garde que les chauffeurs qui ont encore un compte
  // Firebase (un nom qui ne subsiste que dans d'anciennes courses n'est plus un inscrit).
  const normalizeDriverName = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  const activeDriverSet = authSync?.activeNames ? new Set(authSync.activeNames.map(normalizeDriverName)) : null;
  const adminDriverNames = activeDriverSet
    ? allKnownDriverNames.filter((n) => activeDriverSet.has(normalizeDriverName(n)))
    : allKnownDriverNames;

  // Mes courses = historique complet (listenMyRides) + le flux général (plus frais pour
  // les courses toutes récentes). Le flux général seul s'arrête aux 200 dernières courses
  // de TOUS les chauffeurs, ce qui vidait le calendrier au bout de quelques jours.
  useEffect(() => {
    if (!user || !user.emailVerified) {
      setMyRides([]);
      return undefined;
    }
    return listenMyRides(driverName, setMyRides);
  }, [user, driverName]);

  const myRidesAll = useMemo(() => {
    const byId = new Map();
    myRides.forEach((r) => byId.set(r.id, r));
    rides.forEach((r) => {
      if (r.postedBy === driverName || r.takenBy === driverName) byId.set(r.id, r);
    });
    return [...byId.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }, [myRides, rides, driverName]);

  const myTakenRides = myRidesAll
    .filter((r) => r.takenBy === driverName)
    .filter((r) => !dateFilter || dateKey(r.createdAt) === dateFilter);
  const myEarnings = myTakenRides.reduce((sum, r) => sum + (parseFloat(String(r.tarif).replace(",", ".")) || 0), 0);

  const myPostedRides = myRidesAll
    .filter((r) => r.postedBy === driverName)
    .filter((r) => !dateFilter || dateKey(r.createdAt) === dateFilter);
  const myPostedValue = myPostedRides.reduce((sum, r) => sum + (parseFloat(String(r.tarif).replace(",", ".")) || 0), 0);

  const earningsLabel =
    dateFilter === todayKey(0) ? "aujourd'hui" :
    dateFilter === todayKey(-1) ? "hier" :
    dateFilter ? `le ${dateFilter.split("-").reverse().join("/")}` :
    "au total";

  // Vitesse moyenne estimée pour convertir une distance à vol d'oiseau en temps de trajet.
  // C'est une approximation (pas un vrai calcul d'itinéraire routier) — prévoir une marge.

  // Course(s) que ce chauffeur a en ce moment (prise ou en cours) — affichées
  // en raccourci permanent en haut de l'écran, quel que soit l'onglet/filtre
  // actif, pour ne pas avoir à la rechercher dans une longue liste.
  const myActiveRides = rides
    .filter((r) => r.takenBy === driverName && (r.status === "prise" || r.status === "en_cours"))
    .sort((a, b) => (a.status === b.status ? 0 : a.status === "en_cours" ? -1 : 1));

  const visibleRides = rides
    .filter((r) => {
      if (dateFilter === "week") {
        const { start, end } = thisWeekRange();
        const d = r.date || dateKey(r.createdAt);
        if (d < start || d > end) return false;
      } else if (dateFilter && (r.date || dateKey(r.createdAt)) !== dateFilter) {
        return false;
      }
      if (filter === "dispo") return r.status === "disponible";
      if (filter === "historique") return r.status === "terminee";
      return true;
    })
    .map((r) => ({ ...r, _dist: myPos ? distanceKm(myPos, ridePickupCoords(r)) : null }))
    .filter((r) => {
      // Le rayon ne s'applique qu'aux vues "Disponibles"/"Toutes" — tes propres
      // courses (Mes courses/Historique) restent visibles quelle que soit la distance.
      if ((filter !== "dispo" && filter !== "toutes") || radiusFilter === "all") return true;
      if (!myPos || r._dist == null) return true; // pas de position = pas filtré, pour ne rien cacher par erreur
      return r._dist <= parseFloat(radiusFilter);
    })
    .sort((a, b) => {
      if (a._dist != null && b._dist != null) return a._dist - b._dist;
      if (a._dist != null) return -1;
      if (b._dist != null) return 1;
      return b.createdAt - a.createdAt;
    });

  if (authLoading) {
    return (
      <div className="rp-force-dark" style={styles.pageAuth}>
        <AuthBackdrop />
        <div style={styles.gateCard}>
          <div style={styles.logoBadgeLarge}>
            <Car size={30} color="#1A1206" />
            <span style={styles.logoBeaconLarge} />
          </div>
          <h1 style={styles.gateTitle}>RoulePartner</h1>
        </div>
        <AuthVehicleStrip />
      </div>
    );
  }

  if (!user) {
    if (!splashSeen) {
      return <AuthSplash onChoose={(mode) => { setAuthMode(mode); dismissSplash(); }} />;
    }
    return (
      <div className="rp-force-dark" style={styles.pageAuth}>
        <AuthBackdrop />
        <div style={styles.gateCard}>
          <div style={styles.logoBadgeLarge}>
            <Car size={30} color="#1A1206" />
            <span style={styles.logoBeaconLarge} />
          </div>
          <h1 style={styles.gateTitle}>RoulePartner</h1>
          {bannedNotice ? (
            <p style={{ ...styles.gateSub, color: "#E5484D" }}>
              Ton compte a été suspendu par l'administrateur. Contacte-le si tu penses que c'est une erreur.
            </p>
          ) : (
          <p style={styles.gateSub}>
            Le tableau de bord partagé entre chauffeurs pour redistribuer les
            courses — fini les groupes WhatsApp.
          </p>
          )}

          <div style={{ display: "flex", gap: 8, margin: "20px 0 4px" }}>
            <button
              type="button"
              onClick={() => { setAuthMode("login"); setAuthError(""); setResetSent(false); }}
              style={{ ...styles.tab, flex: 1, ...(authMode === "login" ? styles.tabActive : {}) }}
            >
              Connexion
            </button>
            <button
              type="button"
              onClick={() => { setAuthMode("signup"); setAuthError(""); setResetSent(false); }}
              style={{ ...styles.tab, flex: 1, ...(authMode === "signup" ? styles.tabActive : {}) }}
            >
              Créer un compte
            </button>
          </div>

          <form
            onSubmit={authMode === "signup" ? handleSignUp : handleLogIn}
            style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}
          >
            {authMode === "signup" && (
              <>
                <input
                  value={authDisplayName}
                  onChange={(e) => setAuthDisplayName(e.target.value)}
                  placeholder="Ton nom ou pseudo"
                  style={styles.input}
                  required
                />
                <input
                  value={authLicense}
                  onChange={(e) => setAuthLicense(e.target.value)}
                  placeholder="Numéro de licence taxi"
                  style={styles.input}
                  required
                />
                <input
                  value={authCommune}
                  onChange={(e) => setAuthCommune(e.target.value)}
                  placeholder="Commune de rattachement"
                  style={styles.input}
                  required
                />
              </>
            )}
            <input
              type="email"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
              placeholder="Adresse email"
              style={styles.input}
              required
              autoComplete="email"
            />
            <input
              type="password"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
              placeholder="Mot de passe (6 caractères min.)"
              style={styles.input}
              required
              autoComplete={authMode === "signup" ? "new-password" : "current-password"}
            />
            {authMode === "login" && (
              <button
                type="button"
                onClick={handleForgotPassword}
                disabled={authBusy}
                style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 12.5, textAlign: "right", cursor: "pointer", padding: 0, textDecoration: "underline" }}
              >
                Mot de passe oublié ?
              </button>
            )}
            {resetSent && (
              <span style={{ color: "var(--positive-text)", fontSize: 13 }}>
                Si un compte existe avec cet email, un lien de réinitialisation vient d'être envoyé.
              </span>
            )}
            {authError && <span style={{ color: "#E5484D", fontSize: 13 }}>{authError}</span>}
            <button type="submit" style={styles.btnPrimary} disabled={authBusy}>
              {authBusy ? "…" : authMode === "signup" ? "Créer mon compte" : "Se connecter"}
            </button>
          </form>
        </div>
        <AuthVehicleStrip />
      </div>
    );
  }

  if (!user.emailVerified) {
    return (
      <div className="rp-force-dark" style={styles.pageAuth}>
        <AuthBackdrop />
        <div style={styles.gateCard}>
          <div style={styles.logoBadgeLarge}>
            <Car size={30} color="#1A1206" />
            <span style={styles.logoBeaconLarge} />
          </div>
          <h1 style={styles.gateTitle}>RoulePartner</h1>
          <p style={styles.gateSub}>
            Un email de confirmation a été envoyé à <strong>{user.email}</strong>. Clique sur le lien qu'il
            contient, puis reviens ici.
          </p>
          <p style={styles.gateSub}>
            <strong>Tu ne le trouves pas ?</strong> Regarde dans tes <strong>spams</strong> ou ton dossier
            <strong> courrier indésirable</strong> : il y arrive souvent. Pense à le marquer comme « non spam ».
          </p>
          {authError && <p style={{ color: "#E5484D", fontSize: 13 }}>{authError}</p>}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 20 }}>
            <button
              type="button"
              style={styles.btnPrimary}
              onClick={async () => {
                setAuthError("");
                const refreshed = await reloadUser();
                if (refreshed && !refreshed.emailVerified) {
                  setAuthError("Toujours pas confirmé — vérifie ta boîte mail (et les spams).");
                }
                setUser(refreshed);
              }}
            >
              J'ai confirmé, actualiser
            </button>
            <button
              type="button"
              style={styles.btnGhost}
              onClick={async () => {
                setAuthError("");
                try {
                  await resendVerificationEmail();
                  setAuthError("Email renvoyé.");
                } catch (e) {
                  setAuthError("Échec de l'envoi, réessaie dans un instant.");
                }
              }}
            >
              Renvoyer l'email
            </button>
            <button type="button" style={styles.btnGhost} onClick={() => logOut()}>
              Se déconnecter
            </button>
          </div>
        </div>
        <AuthVehicleStrip />
      </div>
    );
  }

  const viewTabs = [
    { id: "carte", label: "Carte", icon: MapIcon },
    { id: "historique", label: "Historique", icon: History },
    { id: "toutes", label: "Toutes", icon: List },
  ];
  const activeViewTab = viewTabs.find((t) => t.id === filter);
  const hasActiveFilters = !!dateFilter || radiusFilter !== "all" || !!activeViewTab;

  // Couleur propre à chaque sens dans "Mes courses" : une course prise (à un autre
  // chauffeur) et une course donnée (postée par moi) doivent se distinguer d'un coup d'œil.
  const myRideRole = (r) => r.takenBy === driverName
    ? { label: "Prise", color: MY_TAKEN_COLOR, icon: Car }
    : { label: "Donnée", color: MY_POSTED_COLOR, icon: Send };

  // Carte compacte utilisée dans la page "Mes courses" (prises ET données) — ouvre la fiche
  // détaillée existante au clic plutôt que de dupliquer toutes ses actions ici.
  const renderMyCourseCard = (r) => {
    const meta = typeMeta(r.type);
    const role = myRideRole(r);
    return (
      <div
        key={r.id}
        style={{ ...styles.card, cursor: "pointer", borderLeft: `4px solid ${role.color}` }}
        onClick={() => { setSelectedRide(r); setShowMyCoursesPanel(false); }}
      >
        <div style={styles.cardHeader}>
          <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ ...styles.typeTag, background: tintBg(role.color, 0.16), color: role.color }}>
              <role.icon size={12} style={{ marginRight: 4 }} />
              {role.label}
            </span>
            <span style={{ ...styles.typeTag, background: tintBg(meta.color, 0.12), color: meta.color }}>
              <meta.icon size={12} style={{ marginRight: 4 }} />
              {meta.label}
            </span>
          </span>
          <span
            style={{
              ...styles.statusTag,
              color: statusColor(r.status), background: tintBg(statusColor(r.status), 0.14),
            }}
          >
            {r.status === "disponible" ? "Disponible"
              : r.status === "en_attente" ? "En attente"
              : r.status === "en_cours" ? "En cours"
              : r.status === "terminee" ? "Terminée"
              : r.status === "prise" ? "Prise"
              : r.status}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
          <div style={{ display: "flex", gap: 10, flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 8, flexShrink: 0, padding: "4px 0" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#FFB43A", flexShrink: 0 }} />
              <span style={{ flex: 1, width: 2, minHeight: 16, background: "var(--border-outline)", margin: "3px 0", borderRadius: 1 }} />
              <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--text-faint)", flexShrink: 0 }} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 14, minWidth: 0, flex: 1 }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cardLocality(r.depart)}</span>
              <span style={{ fontWeight: 600, fontSize: 15, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cardLocality(r.arrivee)}</span>
            </div>
          </div>
          {r.tarif && <span style={styles.tarifTag}>{r.tarif} €</span>}
        </div>
        <div style={styles.metaRow}>
          <span style={styles.metaItem}><Clock size={13} /> {formatRideDate(r.date)} à {r.heure} — {trajetLabel(r.trajet)}</span>
        </div>
      </div>
    );
  };

  // ---- Calendrier "Mes courses" : courses prises + données, rangées par ride.date ----
  const myCalendarRides = myRidesAll.filter((r) => r.date);
  const calRidesByDay = myCalendarRides.reduce((acc, r) => {
    (acc[r.date] = acc[r.date] || []).push(r);
    return acc;
  }, {});
  Object.values(calRidesByDay).forEach((list) =>
    list.sort((a, b) => String(a.heure || "").localeCompare(String(b.heure || "")))
  );

  const calShift = (dir) => {
    if (calPeriod === "jour") setCalAnchor(addDaysKey(calAnchor, dir));
    else if (calPeriod === "semaine") setCalAnchor(addDaysKey(calAnchor, 7 * dir));
    else {
      const d = dateFromKey(calAnchor);
      setCalAnchor(keyFromDate(new Date(d.getFullYear(), d.getMonth() + dir, 1)));
    }
  };

  const calTitle = (() => {
    if (calPeriod === "jour") {
      const d = dateFromKey(calAnchor);
      const label = calAnchor === todayKey(0) ? "Aujourd'hui" : calAnchor === todayKey(1) ? "Demain" : calAnchor === todayKey(-1) ? "Hier" : FRENCH_WEEKDAYS_SHORT[d.getDay()];
      return `${label} ${formatDayMonth(calAnchor)}`;
    }
    if (calPeriod === "semaine") {
      const start = startOfWeekKey(calAnchor);
      return `${formatDayMonth(start)} – ${formatDayMonth(addDaysKey(start, 6))}`;
    }
    const d = dateFromKey(calAnchor);
    return `${FRENCH_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  })();

  const renderCalRideRow = (r) => {
    const meta = typeMeta(r.type);
    const role = myRideRole(r);
    return (
      <div
        key={r.id}
        onClick={() => { setSelectedRide(r); setShowMyCoursesPanel(false); }}
        style={{
          display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
          background: "var(--bg-screen)", border: "1px solid var(--border-subtle)", borderLeft: `4px solid ${role.color}`,
          borderRadius: 10, padding: "10px 12px",
        }}
      >
        <span className="rp-meter" style={{ fontSize: 15, fontWeight: 800, color: "var(--text-primary)", minWidth: 44 }}>{r.heure || "--:--"}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {cardLocality(r.depart)} → {cardLocality(r.arrivee)}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
            <span style={{ color: role.color, fontWeight: 700 }}>{role.label}</span> · {meta.label}
            {r.status === "terminee" ? " · Terminée" : r.status === "en_cours" ? " · En cours" : r.status === "en_attente" ? " · En attente" : ""}
          </div>
        </div>
        {r.tarif && <span style={styles.tarifTag}>{r.tarif} €</span>}
      </div>
    );
  };

  const renderCalDayList = (key) => {
    const list = calRidesByDay[key] || [];
    return list.length === 0 ? (
      <p style={{ color: "var(--text-faint)", fontSize: 13, margin: "4px 0 0" }}>Aucune course ce jour-là.</p>
    ) : (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{list.map(renderCalRideRow)}</div>
    );
  };

  const renderMyCoursesCalendar = () => {
    const today = todayKey(0);
    const periodBtn = (id, label) => (
      <button
        key={id}
        onClick={() => { setCalPeriod(id); if (id === "mois") setCalSelectedDay(calAnchor); }}
        style={{
          flex: 1, border: "none", borderRadius: 8, padding: "9px 0", fontSize: 13.5, fontWeight: 700, cursor: "pointer",
          background: calPeriod === id ? "#FFB43A" : "transparent", color: calPeriod === id ? "#1A1206" : "var(--text-tertiary)",
        }}
      >
        {label}
      </button>
    );

    let body;
    if (calPeriod === "jour") {
      body = renderCalDayList(calAnchor);
    } else if (calPeriod === "semaine") {
      const start = startOfWeekKey(calAnchor);
      body = (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {Array.from({ length: 7 }, (_, i) => addDaysKey(start, i)).map((key) => {
            const count = (calRidesByDay[key] || []).length;
            return (
              <div key={key}>
                <div style={{ ...styles.myCoursesSectionTitle, color: key === today ? "var(--accent-text)" : "var(--text-muted)", marginBottom: 8 }}>
                  {FRENCH_WEEKDAYS_SHORT[dateFromKey(key).getDay()]} {formatDayMonth(key)}
                  {count > 0 && <span style={{ color: "var(--text-faint)" }}>· {count}</span>}
                </div>
                {count > 0 ? renderCalDayList(key) : <div style={{ height: 1, background: "var(--divider)" }} />}
              </div>
            );
          })}
        </div>
      );
    } else {
      const a = dateFromKey(calAnchor);
      const firstKey = keyFromDate(new Date(a.getFullYear(), a.getMonth(), 1));
      const gridStart = startOfWeekKey(firstKey);
      const daysInMonth = new Date(a.getFullYear(), a.getMonth() + 1, 0).getDate();
      const cellCount = Math.ceil(((dateFromKey(firstKey).getDay() + 6) % 7 + daysInMonth) / 7) * 7;
      body = (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 16 }}>
            {["L", "M", "M", "J", "V", "S", "D"].map((l, i) => (
              <div key={i} style={{ textAlign: "center", fontSize: 11, fontWeight: 800, color: "var(--text-faint)", paddingBottom: 4 }}>{l}</div>
            ))}
            {Array.from({ length: cellCount }, (_, i) => addDaysKey(gridStart, i)).map((key) => {
              const inMonth = dateFromKey(key).getMonth() === a.getMonth();
              const count = (calRidesByDay[key] || []).length;
              const selected = key === calSelectedDay;
              return (
                <button
                  key={key}
                  onClick={() => setCalSelectedDay(key)}
                  style={{
                    aspectRatio: "1", border: key === today ? "1.5px solid #FFB43A" : "1px solid var(--border-subtle)",
                    borderRadius: 8, cursor: "pointer", padding: 0,
                    background: selected ? "#FFB43A" : "var(--bg-screen)",
                    color: selected ? "#1A1206" : inMonth ? "var(--text-secondary)" : "var(--text-disabled)",
                    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
                    fontSize: 13.5, fontWeight: 700,
                  }}
                >
                  {dateFromKey(key).getDate()}
                  <span style={{
                    minWidth: 16, height: 16, borderRadius: 8, fontSize: 10, fontWeight: 800, lineHeight: "16px",
                    background: count ? (selected ? "#1A1206" : "#FFB43A") : "transparent",
                    color: selected ? "var(--accent-text)" : "#1A1206",
                  }}>
                    {count || ""}
                  </span>
                </button>
              );
            })}
          </div>
          <div style={styles.myCoursesSectionTitle}>
            {FRENCH_WEEKDAYS_SHORT[dateFromKey(calSelectedDay).getDay()]} {formatDayMonth(calSelectedDay)}
          </div>
          {renderCalDayList(calSelectedDay)}
        </>
      );
    }

    return (
      <>
        <div style={{ display: "flex", gap: 4, background: "var(--surface-card)", borderRadius: 10, padding: 4, marginBottom: 14 }}>
          {periodBtn("jour", "Aujourd'hui")}
          {periodBtn("semaine", "Semaine")}
          {periodBtn("mois", "Mois")}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 16 }}>
          <button onClick={() => calShift(-1)} style={styles.wizardNavBtn} aria-label="Précédent"><ChevronLeft size={20} /></button>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontWeight: 800, fontSize: 15.5, color: "var(--text-primary)", textTransform: calPeriod === "mois" ? "capitalize" : "none" }}>{calTitle}</div>
            <button
              onClick={() => { setCalAnchor(today); setCalSelectedDay(today); }}
              style={{ background: "none", border: "none", color: "var(--accent-text)", fontSize: 12.5, fontWeight: 700, cursor: "pointer", padding: "2px 0" }}
            >
              Revenir à aujourd'hui
            </button>
          </div>
          <button onClick={() => calShift(1)} style={styles.wizardNavBtn} aria-label="Suivant"><ChevronRight size={20} /></button>
        </div>
        {body}
      </>
    );
  };

  return (
    <div style={styles.page}>
      <style>{`
        .rp-bottom-nav { display: none; }
        .rp-bottom-spacer { height: 0; }
        .rp-fab-floating { display: none !important; }
        @media (max-width: 720px) {
          .rp-bottom-nav { display: flex; }
          .rp-bottom-spacer { height: 78px; }
          .rp-fab-floating { display: flex !important; }
        }
      `}</style>

      {/* Alerte course prioritaire — s'affiche par-dessus n'importe quel écran
          de l'appli (accueil, carte, messages, compte...) sans faire sortir le
          chauffeur de ce qu'il était en train de faire. */}
      {priorityAlert && (() => {
        const r = priorityAlert.ride;
        const meta = typeMeta(r.type);
        const secondsLeft = Math.max(
          0,
          Math.ceil((priorityWindowEndsAt(r) - Date.now()) / 1000)
        );
        const dist = myPos ? distanceKm(myPos, ridePickupCoords(r)) : null;
        return (
          <div style={styles.priorityAlertOverlay}>
            <div style={styles.priorityAlertCard}>
              <div style={styles.priorityAlertTop}>
                <span className="rp-beacon-pulse" style={styles.priorityAlertPill}>
                  COURSE PRIORITAIRE
                </span>
                <span className="rp-meter" style={{ fontSize: 26 }}>{secondsLeft}s</span>
              </div>

              <p style={styles.priorityAlertSub}>
                {priorityAlert.shared
                  ? "Tu fais partie des chauffeurs les plus proches — le premier qui accepte l'obtient."
                  : "Tu es le chauffeur le plus proche."}
              </p>

              <div style={styles.priorityAlertBody}>
                <span style={{ ...styles.typeTag, background: tintBg(meta.color, 0.12), color: meta.color, marginBottom: 10, display: "inline-flex" }}>
                  {meta.label}
                </span>
                {r.urgent && (
                  <div className="rp-beacon-pulse" style={{ ...styles.urgentBadge, position: "static", marginBottom: 10, display: "inline-flex" }}>
                    <Siren size={12} style={{ marginRight: 4 }} /> URGENT
                  </div>
                )}
                <div style={styles.priorityAlertRoute}>
                  <div><strong>Départ</strong> · {r.depart}</div>
                  <div><strong>Arrivée</strong> · {r.arrivee}</div>
                </div>
                <div style={styles.priorityAlertMeta}>
                  <span><Clock size={12} /> {r.heure}</span>
                  {r.date && <span>{formatRideDate(r.date)}</span>}
                  {dist != null && <span><Navigation size={12} /> à {dist.toFixed(1)} km de toi</span>}
                  {r.tarif && <span className="rp-meter">{Number(r.tarif).toFixed(2)} €</span>}
                </div>
                {r.notes && <p style={styles.notes}>{r.notes}</p>}
              </div>

              <div style={styles.priorityAlertActions}>
                <button
                  style={{ ...styles.btnGhost, flex: 1, minHeight: 52, fontSize: 15 }}
                  onClick={() => setPriorityAlert(null)}
                >
                  Je la laisse
                </button>
                {awaitingServerPriority(rides.find((x) => x.id === r.id) || r)
                  ? renderAwaitingClaimBtn({ ...styles.btnPrimary, flex: 1, minHeight: 52, fontSize: 15, justifyContent: "center" })
                  : (
                    <button
                      style={{ ...styles.btnPrimary, flex: 1, minHeight: 52, fontSize: 15, justifyContent: "center" }}
                      onClick={async () => {
                        await claim(r);
                        setPriorityAlert(null);
                      }}
                    >
                      Je la prends
                    </button>
                  )}
              </div>
            </div>
          </div>
        );
      })()}

      {claimAlert && (() => {
        const r = claimAlert.ride;
        const remainingMs = r.pendingSince ? CLAIM_CONFIRM_WINDOW_MS - (Date.now() - r.pendingSince) : 0;
        return (
          <div style={styles.claimToast}>
            <div style={styles.claimToastHeader}>
              <span style={styles.claimToastTitle}>
                <Check size={14} style={{ marginRight: 6 }} />
                <strong>{r.pendingBy}</strong>&nbsp;veut prendre ta course
              </span>
              <button onClick={() => setClaimAlert(null)} style={{ background: "none", border: "none", cursor: "pointer", padding: 2 }}>
                <X size={15} color="#8A9099" />
              </button>
            </div>
            <div style={styles.claimToastRoute}>{r.depart} → {r.arrivee}</div>
            <div style={styles.claimToastActions}>
              <button
                style={{ ...styles.btnGhost, flex: 1 }}
                onClick={() => { refuseClaim(r.id); setClaimAlert(null); }}
              >
                Refuser
              </button>
              <button
                style={{ ...styles.btnPrimary, flex: 1, justifyContent: "center" }}
                onClick={() => { confirmClaim(r); setClaimAlert(null); }}
              >
                Confirmer
              </button>
            </div>
            {remainingMs > 0 && (
              <div style={styles.claimToastHint}>
                Confirmation automatique dans {Math.max(0, Math.ceil(remainingMs / 1000))}s si tu ne réponds pas
              </div>
            )}
          </div>
        );
      })()}

      {releaseAlert && (() => {
        const r = releaseAlert.ride;
        return (
          <div style={{ ...styles.claimToast, borderColor: "#E5484D" }}>
            <div style={styles.claimToastHeader}>
              <span style={styles.claimToastTitle}>
                😬 Mince — <strong>&nbsp;{releaseAlert.takenByName}</strong>&nbsp;a relâché ta course
              </span>
              <button onClick={() => setReleaseAlert(null)} style={{ background: "none", border: "none", cursor: "pointer", padding: 2 }}>
                <X size={15} color="#8A9099" />
              </button>
            </div>
            <div style={styles.claimToastRoute}>{r.depart} → {r.arrivee} — elle est de nouveau disponible</div>
          </div>
        );
      })()}

      {pulling && (
        <div style={styles.pullBanner}>
          ↓ Relâche pour actualiser
        </div>
      )}
      <header style={styles.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
          <div style={styles.logoBadge}>
            <Car size={18} color="#1A1206" />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <h1 style={styles.title}>Roule<span style={{ color: "var(--positive-text)" }}>Partner</span></h1>
            <span style={styles.headerSubtitle}>
              {driverName}{profiles[driverName]?.commune ? ` · ${profiles[driverName].commune}` : ""}
            </span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          {isAdmin && (
            <span
              style={styles.onlineDriversBadge}
              title="Chauffeurs en ligne (visible admin uniquement)"
            >
              <Users size={13} />
              {Object.values(positions).filter((p) => p.updatedAt && Date.now() - p.updatedAt < POSITION_FRESH_MS).length}
            </span>
          )}
          <button
            onClick={sharePosition}
            aria-label="Basculer en service / hors service"
            aria-pressed={myPosStatus === "ok"}
            style={{ ...styles.statusPill, ...(myPosStatus === "ok" ? styles.statusPillOn : styles.statusPillOff) }}
          >
            {myPosStatus === "ok" ? "ON" : myPosStatus === "locating" ? "Localisation…" : "OFF"}
            <span style={{
              position: "relative", width: 34, height: 20, borderRadius: 999, flexShrink: 0,
              background: myPosStatus === "ok" ? "#3BD07A" : "var(--border-outline)",
              transition: "background 0.2s",
            }}>
              <span style={{
                position: "absolute", top: 2, left: myPosStatus === "ok" ? 16 : 2,
                width: 16, height: 16, borderRadius: "50%", background: "#fff",
                transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
              }} />
            </span>
          </button>
        </div>
      </header>
      {myPosStatus === "denied" && (
        <div style={styles.hintBanner}>Position refusée — vérifie les réglages du navigateur pour recevoir les courses proches de toi.</div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, padding: "12px 24px 14px" }}>
        <button
          onClick={() => setShowFiltersPanel(true)}
          aria-label="Filtres"
          style={{ ...styles.iconCircleBtn, ...(hasActiveFilters ? styles.iconCircleBtnActive : {}) }}
        >
          <Filter size={17} />
          {hasActiveFilters && <span style={styles.iconCircleDot} />}
        </button>
        <button
          onClick={() => setShowNotifPanel(true)}
          aria-label="Notifications"
          style={styles.iconCircleBtn}
        >
          <Bell size={17} />
        </button>
      </div>

      {myActiveRides.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 24px 14px" }}>
          {myActiveRides.map((r) => (
            <div
              key={r.id}
              onClick={() => setSelectedRide(r)}
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderRadius: 12,
                cursor: "pointer", background: r.status === "en_cours" ? "rgba(255,180,58,0.14)" : "rgba(59,208,122,0.12)",
                border: `1px solid ${r.status === "en_cours" ? "#FFB43A" : "#3BD07A"}`,
              }}
            >
              <Car size={18} color={r.status === "en_cours" ? "#FFB43A" : "#3BD07A"} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: 0.2, color: r.status === "en_cours" ? "var(--accent-text)" : "var(--positive-text)" }}>
                  {r.status === "en_cours" ? "COURSE EN COURS" : "TA COURSE À PRENDRE EN CHARGE"}
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {cardLocality(r.depart)} → {cardLocality(r.arrivee)}
                </div>
              </div>
              <ChevronRight size={18} color="#8A9099" />
            </div>
          ))}
        </div>
      )}

      {showFiltersPanel && (
        <div style={styles.modalOverlay} onClick={() => setShowFiltersPanel(false)}>
          <div style={{ ...styles.modalCard, maxWidth: 340 }} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>Filtres</h2>
              <button onClick={() => setShowFiltersPanel(false)} style={styles.iconBtn}><X size={16} /></button>
            </div>

            <div style={styles.sectionLabel}>Date</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 6 }}>
              <button
                onClick={() => setDateFilter(dateFilter === todayKey(0) ? "" : todayKey(0))}
                style={{ ...styles.togglePill, borderColor: dateFilter === todayKey(0) ? "#FFB43A" : "var(--border-outline)", background: dateFilter === todayKey(0) ? "#FFB43A" : "transparent", color: dateFilter === todayKey(0) ? "#1A1206" : "var(--text-tertiary)" }}
              >
                Aujourd'hui
              </button>
              <button
                onClick={() => setDateFilter(dateFilter === todayKey(1) ? "" : todayKey(1))}
                style={{ ...styles.togglePill, borderColor: dateFilter === todayKey(1) ? "#FFB43A" : "var(--border-outline)", background: dateFilter === todayKey(1) ? "#FFB43A" : "transparent", color: dateFilter === todayKey(1) ? "#1A1206" : "var(--text-tertiary)" }}
              >
                Demain
              </button>
              <button
                onClick={() => setDateFilter(dateFilter === "week" ? "" : "week")}
                style={{ ...styles.togglePill, borderColor: dateFilter === "week" ? "#FFB43A" : "var(--border-outline)", background: dateFilter === "week" ? "#FFB43A" : "transparent", color: dateFilter === "week" ? "#1A1206" : "var(--text-tertiary)" }}
              >
                Cette semaine
              </button>
              <label style={styles.fieldLabel}>
                Autre date (courses futures ou passées)
                <input
                  type="date"
                  lang="fr-FR"
                  value={dateFilter}
                  onChange={(e) => { setDateFilter(e.target.value); }}
                  style={styles.input}
                />
              </label>
              {dateFilter && (
                <button onClick={() => setDateFilter("")} style={styles.btnGhost}>
                  Effacer le filtre de date
                </button>
              )}
            </div>

            <div style={styles.sectionDivider} />
            <div style={styles.sectionLabel}>Rayon</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 6 }}>
              <p style={{ color: "var(--text-muted)", fontSize: 12.5, margin: "0 0 2px" }}>
                Ne montrer que les courses dans ce rayon autour de toi (nécessite d'être "en service").
              </p>
              {["15", "30", "50", "100", "all"].map((v) => (
                <button
                  key={v}
                  onClick={() => updateRadiusFilter(v)}
                  style={{
                    ...styles.togglePill, width: "100%", justifyContent: "flex-start",
                    borderColor: radiusFilter === v ? "#FFB43A" : "var(--border-outline)",
                    color: radiusFilter === v ? "#1A1206" : "var(--text-tertiary)",
                    background: radiusFilter === v ? "#FFB43A" : "transparent",
                  }}
                >
                  {v === "all" ? "Toute distance" : `Rayon de ${v} km`}
                </button>
              ))}
            </div>

            <div style={styles.sectionDivider} />
            <div style={styles.sectionLabel}>Vue</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {viewTabs.map((t) => (
                <button
                  key={t.id}
                  onClick={() => { setFilter(filter === t.id ? "dispo" : t.id); setShowFiltersPanel(false); }}
                  style={{
                    ...styles.togglePill, width: "100%", justifyContent: "flex-start", gap: 8,
                    borderColor: filter === t.id ? "#FFB43A" : "var(--border-outline)",
                    color: filter === t.id ? "#1A1206" : "var(--text-tertiary)",
                    background: filter === t.id ? "#FFB43A" : "transparent",
                  }}
                >
                  <t.icon size={14} /> {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {showNotifPanel && (
        <div style={styles.modalOverlay} onClick={() => setShowNotifPanel(false)}>
          <div style={{ ...styles.modalCard, maxWidth: 320 }} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={{ ...styles.modalTitle, display: "flex", alignItems: "center", gap: 8 }}><Bell size={18} /> Notifications</h2>
              <button onClick={() => setShowNotifPanel(false)} style={styles.iconBtn}><X size={16} /></button>
            </div>
            <p style={{ color: "var(--text-muted)", fontSize: 13.5, lineHeight: 1.5 }}>
              Rien pour l'instant — cet espace accueillera bientôt les notifications de l'appli.
            </p>
          </div>
        </div>
      )}

      {!myPos && (
        <div style={styles.hintBanner}>
          Mets-toi en service pour trier les courses par proximité et profiter
          de la priorité "plus proche".
        </div>
      )}

      {error && (
        <div style={styles.errorBanner}>
          {error}
          <button onClick={() => setError("")} style={{ background: "none", border: "none", cursor: "pointer" }}>
            <X size={14} color="#F2F4F7" />
          </button>
        </div>
      )}

      {showForm && (
        <div style={styles.wizardOverlay}>
          <form
            onSubmit={handlePost}
            onKeyDown={(e) => {
              // Empêche la soumission implicite du navigateur (touche Entrée, ou "OK"/"Terminé"
              // du clavier mobile sur un champ heure/date) qui publierait la course en sautant
              // les étapes suivantes du parcours — seul le bouton "Publier" doit soumettre.
              if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
                e.preventDefault();
              }
            }}
            style={styles.wizardForm}
          >
            <div style={styles.wizardHeader}>
              <button
                type="button"
                onClick={() => {
                  if (formStep === 1) {
                    setShowForm(false);
                    setEditingId(null);
                    setForm(emptyForm);
                    editOriginalTarifInputs.current = null;
                  } else {
                    setFormStep(formStep - 1);
                  }
                }}
                style={styles.wizardNavBtn}
                aria-label={formStep === 1 ? "Fermer" : "Étape précédente"}
              >
                {formStep === 1 ? <X size={20} /> : <ChevronLeft size={20} />}
              </button>
              <div style={{ flex: 1 }}>
                <div style={styles.wizardStepLabel}>Étape {formStep}/4</div>
                <div style={styles.wizardStepDots}>
                  {[1, 2, 3, 4].map((s) => (
                    <span key={s} style={{ ...styles.wizardStepDot, ...(s <= formStep ? styles.wizardStepDotActive : {}) }} />
                  ))}
                </div>
              </div>
              <button
                type="button"
                onClick={() => { setShowForm(false); setEditingId(null); setForm(emptyForm); editOriginalTarifInputs.current = null; }}
                style={styles.wizardNavBtn}
                aria-label="Annuler"
              >
                <X size={20} />
              </button>
            </div>

            <div style={styles.wizardBody} ref={wizBodyRef}>
              {formStep === 1 && (
                <>
                  <h2 style={styles.wizardTitle}>Quel type de course ?</h2>
                  <p style={styles.wizardSubtitle}>Choisis la catégorie, puis renseigne le trajet.</p>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 24 }}>
                    {TYPES.map((t) => (
                      <button
                        type="button"
                        key={t.id}
                        onClick={() => setForm({ ...form, type: t.id })}
                        style={{
                          display: "flex", flexDirection: "column", alignItems: "center", gap: 7,
                          background: form.type === t.id ? tintBg(t.color, 0.12) : "var(--surface-card)",
                          border: `1.5px solid ${form.type === t.id ? t.color : "var(--border-subtle)"}`,
                          borderRadius: 13, padding: "12px 5px", cursor: "pointer", textAlign: "center", minHeight: 82,
                          position: "relative",
                        }}
                      >
                        {form.type === t.id && (
                          <Check size={13} color={t.color} style={{ position: "absolute", top: 6, right: 6 }} />
                        )}
                        <span style={{
                          width: 32, height: 32, borderRadius: 9, flexShrink: 0,
                          background: tintBg(t.color, 0.15),
                          display: "flex", alignItems: "center", justifyContent: "center",
                        }}>
                          <t.icon size={17} color={t.color} />
                        </span>
                        <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.2 }}>{t.label}</span>
                      </button>
                    ))}
                  </div>

                  <div style={styles.formLabel}>Trajet</div>
                  <div style={styles.routeCard}>
                    <div style={{ position: "relative" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "20px 46px 20px 16px", borderBottom: "1px solid var(--border-subtle)" }}>
                        <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#FFB43A", flexShrink: 0 }} />
                        <input
                          style={{ ...styles.routeRowInput, fontSize: 17.5, fontWeight: 700 }}
                          placeholder="Adresse de départ"
                          value={form.depart}
                          onChange={(e) => {
                            setForm({ ...form, depart: e.target.value });
                            setActiveField("depart");
                            setSuggestionActiveIndex(-1);
                            searchAddress(e.target.value, setDepartSuggestions);
                          }}
                          onFocus={() => { setActiveField("depart"); setSuggestionActiveIndex(-1); }}
                          onBlur={() => setTimeout(() => setActiveField((f) => (f === "depart" ? null : f)), 120)}
                          onKeyDown={(e) => handleAddressKeyDown("depart", e)}
                          required
                        />
                      </div>
                      {activeField === "depart" && searchingAddress && form.depart.trim().length >= 3 && (
                        <div style={styles.suggestionBox}>
                          <div style={{ ...styles.suggestionItem, color: "var(--text-faint)", cursor: "default" }}>Recherche…</div>
                        </div>
                      )}
                      {activeField === "depart" && !searchingAddress && suggestionListFor("depart").length > 0 && (
                        <div style={styles.suggestionBox}>
                          {form.depart.trim().length < 3 && (
                            <div style={{ ...styles.suggestionItem, color: "var(--text-faint)", cursor: "default", minHeight: "auto", padding: "8px 14px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: "1px solid var(--border-subtle)" }}>
                              Adresses récentes
                            </div>
                          )}
                          {suggestionListFor("depart").map((s, i) => {
                            const isRecent = !!s.recent;
                            const label = isRecent ? s.address : shortAddress(s);
                            const dist = isRecent ? null : suggestionDistanceLabel(positions[driverName], s);
                            const Icon = isRecent ? Clock : isMedicalPoi(s) ? Stethoscope : MapPin;
                            return (
                              <div
                                key={isRecent ? `recent-${s.address}` : s.place_id}
                                style={{ ...styles.suggestionItem, background: i === suggestionActiveIndex ? "var(--border-subtle)" : undefined }}
                                onMouseDown={(e) => { e.preventDefault(); pickAddressSuggestion("depart", s); }}
                                onMouseEnter={() => setSuggestionActiveIndex(i)}
                              >
                                <Icon size={13} style={{ marginRight: 6, flexShrink: 0 }} />
                                <span style={{ flex: 1 }}>{label}</span>
                                {dist && <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 8, flexShrink: 0 }}>{dist}</span>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <div style={{ position: "relative" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "20px 46px 20px 16px" }}>
                        <span style={{ width: 11, height: 11, borderRadius: 3, background: "var(--text-faint)", flexShrink: 0 }} />
                        <input
                          style={{ ...styles.routeRowInput, fontSize: 17.5, fontWeight: 700 }}
                          placeholder="Adresse d'arrivée"
                          value={form.arrivee}
                          onChange={(e) => {
                            setForm({ ...form, arrivee: e.target.value });
                            setActiveField("arrivee");
                            setSuggestionActiveIndex(-1);
                            searchAddress(e.target.value, setArriveeSuggestions, debounceRefArrivee);
                          }}
                          onFocus={() => { setActiveField("arrivee"); setSuggestionActiveIndex(-1); }}
                          onBlur={() => setTimeout(() => setActiveField((f) => (f === "arrivee" ? null : f)), 120)}
                          onKeyDown={(e) => handleAddressKeyDown("arrivee", e)}
                          required
                        />
                      </div>
                      {activeField === "arrivee" && searchingAddress && form.arrivee.trim().length >= 3 && (
                        <div style={styles.suggestionBox}>
                          <div style={{ ...styles.suggestionItem, color: "var(--text-faint)", cursor: "default" }}>Recherche…</div>
                        </div>
                      )}
                      {activeField === "arrivee" && !searchingAddress && suggestionListFor("arrivee").length > 0 && (
                        <div style={styles.suggestionBox}>
                          {form.arrivee.trim().length < 3 && (
                            <div style={{ ...styles.suggestionItem, color: "var(--text-faint)", cursor: "default", minHeight: "auto", padding: "8px 14px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: "1px solid var(--border-subtle)" }}>
                              Adresses récentes
                            </div>
                          )}
                          {suggestionListFor("arrivee").map((s, i) => {
                            const isRecent = !!s.recent;
                            const label = isRecent ? s.address : shortAddress(s);
                            const dist = isRecent ? null : suggestionDistanceLabel(positions[driverName], s);
                            const Icon = isRecent ? Clock : isMedicalPoi(s) ? Stethoscope : MapPin;
                            return (
                              <div
                                key={isRecent ? `recent-${s.address}` : s.place_id}
                                style={{ ...styles.suggestionItem, background: i === suggestionActiveIndex ? "var(--border-subtle)" : undefined }}
                                onMouseDown={(e) => { e.preventDefault(); pickAddressSuggestion("arrivee", s); }}
                                onMouseEnter={() => setSuggestionActiveIndex(i)}
                              >
                                <Icon size={13} style={{ marginRight: 6, flexShrink: 0 }} />
                                <span style={{ flex: 1 }}>{label}</span>
                                {dist && <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 8, flexShrink: 0 }}>{dist}</span>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <button type="button" onClick={swapDepartArrivee} style={styles.swapBtn} aria-label="Inverser départ et arrivée" title="Inverser départ et arrivée">
                      ⇅
                    </button>
                  </div>
                </>
              )}

              {formStep === 2 && (
                <>
                  <h2 style={styles.wizardTitle}>Aller, retour ou aller-retour ?</h2>
                  <p style={styles.wizardSubtitle}>Précise ensuite quand a lieu la prise en charge.</p>

                  <div style={{ ...styles.formRow, marginBottom: form.trajet === "allerRetour" ? 16 : 26 }}>
                    {TRAJET_TYPES.map((t) => (
                      <button
                        type="button"
                        key={t.id}
                        onClick={() => setForm({ ...form, trajet: t.id })}
                        style={{
                          ...styles.typeChip, flex: 1,
                          color: form.trajet === t.id ? "#1A1206" : "var(--text-tertiary)",
                          background: form.trajet === t.id ? "#FFB43A" : "var(--surface-tile)",
                        }}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                  {form.trajet === "allerRetour" && (
                    <label style={{ ...styles.formLabel, marginBottom: 26 }}>
                      Heure de prise en charge retour (optionnel)
                      <input style={styles.input} type="time" value={form.heureRetour}
                        onChange={(e) => setForm({ ...form, heureRetour: e.target.value })} />
                    </label>
                  )}

                  <div style={styles.wizardSectionTitle}>Quand a lieu la prise en charge ?</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div>
                      <button
                        type="button"
                        onClick={() => { setPickupMode("now"); setForm({ ...form, date: todayKey(0), heure: timePlusMinutes(0) }); }}
                        style={{ ...styles.wizardModeBtn, ...(pickupMode === "now" ? styles.wizardModeBtnActive : {}) }}
                      >
                        Maintenant (patient prêt)
                      </button>
                      {pickupMode === "now" && (
                        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "8px 2px 0" }}>
                          Prise en charge immédiate — {form.heure}.
                        </p>
                      )}
                    </div>
                    <div>
                      <button
                        type="button"
                        onClick={() => { setPickupMode("time"); setForm((f) => ({ ...f, date: f.date || todayKey(0) })); }}
                        style={{ ...styles.wizardModeBtn, ...(pickupMode === "time" ? styles.wizardModeBtnActive : {}) }}
                      >
                        Choisir l'heure
                      </button>
                      {pickupMode === "time" && (
                        <input
                          style={{ ...styles.input, width: "100%", marginTop: 10 }}
                          type="time" value={form.heure}
                          onChange={(e) => setForm({ ...form, heure: e.target.value })}
                          required autoFocus
                        />
                      )}
                    </div>
                    <div>
                      <button
                        type="button"
                        onClick={() => setPickupMode("datetime")}
                        style={{ ...styles.wizardModeBtn, ...(pickupMode === "datetime" ? styles.wizardModeBtnActive : {}) }}
                      >
                        Date et heure
                      </button>
                      {pickupMode === "datetime" && (
                        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                          <input style={{ ...styles.input, flex: 1 }} type="date" lang="fr-FR" value={form.date}
                            onChange={(e) => setForm({ ...form, date: e.target.value })} required />
                          <input style={{ ...styles.input, flex: 1 }} type="time" value={form.heure}
                            onChange={(e) => setForm({ ...form, heure: e.target.value })} required />
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Publication express : départ, arrivée et heure suffisent. Le reste
                      (patient, notes, pièces jointes) est facultatif et se complète après
                      via "Modifier" si besoin. Pas en mode modification. */}
                  {!editingId && form.heure && (
                    <div style={styles.expressBox}>
                      <div style={{ fontSize: 14, color: "var(--text-tertiary)", marginBottom: 10 }}>
                        Pressé ? Publie tout de suite — patient, notes et documents sont facultatifs.
                        {form.tarif && !calculatingTarif && <> Tarif calculé : <strong style={{ color: "var(--text-primary)" }}>{form.tarif} €</strong>.</>}
                      </div>
                      <button
                        type="button"
                        disabled={calculatingTarif}
                        onClick={submitRide}
                        style={{ ...styles.btnPrimaryAction, opacity: calculatingTarif ? 0.6 : 1 }}
                      >
                        <Send size={18} /> {calculatingTarif ? "Calcul du tarif…" : "Publier maintenant"}
                      </button>
                    </div>
                  )}
                </>
              )}

              {formStep === 3 && (
                <>
                  <h2 style={styles.wizardTitle}>Détails de la course</h2>
                  <p style={styles.wizardSubtitle}>Renseigne le patient et les pièces jointes si besoin.</p>

                  <label style={styles.formLabel}>
                    Nom de la personne transportée (optionnel)
                    <input style={styles.input} placeholder="Ex: Jean Dupont" value={form.patient}
                      onChange={(e) => setForm({ ...form, patient: e.target.value })} />
                  </label>
                  <label style={{ ...styles.formLabel, marginTop: 14 }}>
                    Téléphone patient (optionnel)
                    <input style={styles.input} placeholder="Ex: 06 12 34 56 78" value={form.patientTel}
                      onChange={(e) => setForm({ ...form, patientTel: e.target.value })} />
                  </label>
                  <label style={{ ...styles.formLabel, marginTop: 14 }}>
                    Notes
                    <textarea style={{ ...styles.input, width: "100%", minHeight: 60 }}
                      placeholder="Brancard, fauteuil roulant, code d'accès..." value={form.notes}
                      onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                  </label>

                  <div style={{ ...styles.formRow, marginTop: 16 }}>
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, urgent: !form.urgent })}
                      style={{
                        ...styles.togglePill,
                        borderColor: form.urgent ? "#E5484D" : "var(--border-outline)",
                        color: form.urgent ? "#fff" : "var(--text-tertiary)",
                        background: form.urgent ? "#E5484D" : "transparent",
                      }}
                    >
                      <Siren size={17} /> Urgent
                    </button>
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, tpmr: !form.tpmr })}
                      style={{
                        ...styles.togglePill,
                        borderColor: form.tpmr ? "#8FB3F5" : "var(--border-outline)",
                        color: form.tpmr ? "#fff" : "var(--text-tertiary)",
                        background: form.tpmr ? "#8FB3F5" : "transparent",
                      }}
                    >
                      TPMR
                    </button>
                  </div>

                  <div style={styles.sectionDivider} />
                  <div style={{ ...styles.sectionLabel, marginTop: 18 }}>Pièces jointes</div>

                  <div style={{ ...styles.formLabel, marginTop: 10 }}>
                    Photo du bon de transport (optionnel)
                    <input
                      ref={photoInputRef}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={handlePhotoChange}
                      style={{ display: "none" }}
                    />
                    <input
                      ref={photoLibraryInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handlePhotoChange}
                      style={{ display: "none" }}
                    />
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button type="button" onClick={() => photoInputRef.current?.click()} style={{ ...styles.btnGhost, flex: 1 }}>
                        {form.photo ? "Reprendre une photo" : "Prendre une photo"}
                      </button>
                      <button type="button" onClick={() => photoLibraryInputRef.current?.click()} style={{ ...styles.btnGhost, flex: 1 }}>
                        Photothèque
                      </button>
                    </div>
                  </div>
                  {form.photo && (
                    <div style={{ position: "relative", display: "inline-block", marginTop: 8 }}>
                      <img src={form.photo} alt="Bon de transport" style={styles.photoPreview} />
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, photo: null })}
                        style={styles.photoRemoveBtn}
                        title="Retirer la photo"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}
                  <label style={{ ...styles.formLabel, marginTop: 14 }}>
                    Bon de transport en PDF (optionnel — visible seulement une fois la course prise)
                    <input
                      ref={documentInputRef}
                      type="file"
                      accept="application/pdf"
                      onChange={handleDocumentChange}
                      style={{ display: "none" }}
                    />
                    <button type="button" onClick={() => documentInputRef.current?.click()} style={styles.btnGhost}>
                      {form.document ? "Changer le PDF" : "Joindre un PDF"}
                    </button>
                  </label>
                  {form.document && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-muted)", marginTop: 8 }}>
                      <FileText size={14} /> {form.documentName || "bon-de-transport.pdf"}
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, document: null, documentName: "" })}
                        style={styles.iconBtn}
                        title="Retirer le PDF"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  )}
                </>
              )}

              {formStep === 4 && (
                <>
                  <h2 style={styles.wizardTitle}>Résumé et confirmation</h2>
                  <p style={styles.wizardSubtitle}>Vérifie les informations avant de publier.</p>
                  {editingId && editOriginalRideRef.current && editOriginalRideRef.current.status !== "disponible" && (
                    <div style={styles.pendingBanner}>
                      Cette course est déjà acceptée : le chauffeur sera prévenu de tes modifications et pourra la relâcher si elles ne lui conviennent pas.
                    </div>
                  )}

                  <div style={styles.wizardSummaryCard}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                      <span style={{ ...styles.typeTag, background: tintBg(typeMeta(form.type).color, 0.12), color: typeMeta(form.type).color }}>
                        {(() => { const Icon = typeMeta(form.type).icon; return <Icon size={12} style={{ marginRight: 4 }} />; })()}
                        {typeMeta(form.type).label}
                      </span>
                      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{trajetLabel(form.trajet)}</span>
                    </div>
                    <div style={{ display: "flex", gap: 14, marginBottom: 14 }}>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 10, flexShrink: 0, padding: "5px 0" }}>
                        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#FFB43A", flexShrink: 0 }} />
                        <span style={{ flex: 1, width: 2, minHeight: 20, background: "var(--border-outline)", margin: "4px 0", borderRadius: 1 }} />
                        <span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--text-faint)", flexShrink: 0 }} />
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 18, flex: 1, minWidth: 0 }}>
                        <span style={{ fontWeight: 700, fontSize: 16.5, color: "var(--text-primary)" }}>{form.depart || "—"}</span>
                        <span style={{ fontWeight: 600, fontSize: 16.5, color: "var(--text-tertiary)" }}>{form.arrivee || "—"}</span>
                      </div>
                    </div>
                    <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 14 }}>
                      {formatRideDate(form.date)} à {form.heure || "—"}
                      {form.trajet === "allerRetour" && form.heureRetour && ` · retour ${form.heureRetour}`}
                    </div>

                    {form.type === "taxi" ? (
                      <>
                        <label style={styles.checkboxRow}>
                          <input type="checkbox" checked={form.majorationNuitWeekend}
                            onChange={(e) => setForm({ ...form, majorationNuitWeekend: e.target.checked })} />
                          Nuit/dimanche/férié (+50 %) — détecté automatiquement
                        </label>
                        <label style={{ ...styles.checkboxRow, marginTop: 8 }} title="Marseille, Paris, Nice, Toulouse, Lyon, Strasbourg, Montpellier, Rennes, Bordeaux, Lille, Grenoble, Nantes, départements 92/93/94, ou CMCO/Clinique du Ried (Schiltigheim) et UGECAM (Illkirch) — coche-la toi-même pour un autre établissement limitrophe non détecté">
                          <input type="checkbox" checked={form.grandeVille}
                            onChange={(e) => setForm({ ...form, grandeVille: e.target.checked })} />
                          Forfait grande ville (+15 €) — détecté automatiquement
                        </label>
                        <label style={{ ...styles.checkboxRow, marginTop: 8 }} title="Hospitalisation, chimio, radiothérapie, dialyse... dont l'aller ou le retour se fait à vide">
                          <input type="checkbox" checked={form.retourAVide}
                            onChange={(e) => setForm({ ...form, retourAVide: e.target.checked })} />
                          Retour à vide (hospitalisation/dialyse)
                        </label>
                        <div style={{ padding: "18px 16px", borderRadius: 14, background: "var(--surface-tile)", display: "flex", alignItems: "center", justifyContent: "center", marginTop: 12 }}>
                          <span style={{ fontFamily: "'Manrope', sans-serif", fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em", color: "var(--text-primary)" }}>
                            {calculatingTarif ? "…" : form.tarif ? `${form.tarif} €` : "—"}
                          </span>
                        </div>
                        <div style={{ textAlign: "center", marginTop: 8 }}>
                          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, fontWeight: 600, color: calculatingTarif ? "var(--accent-text)" : "var(--text-muted)" }}>
                            {calculatingTarif ? "calcul en cours…" : "grille CPAM · calculé automatiquement"}
                          </span>
                        </div>
                      </>
                    ) : (
                      <label style={styles.formLabel}>
                        Tarif estimé (€)
                        <input style={{ ...styles.input, width: "100%" }} placeholder="Ex: 65" value={form.tarif}
                          onChange={(e) => setForm({ ...form, tarif: e.target.value })} />
                      </label>
                    )}
                  </div>
                </>
              )}
            </div>

            <div style={styles.wizardFooter}>
              {formStep < 4 ? (
                <>
                  <button
                    type="button"
                    onClick={() => { setShowForm(false); setEditingId(null); setForm(emptyForm); editOriginalTarifInputs.current = null; }}
                    style={{ ...styles.btnGhost, minHeight: 52, fontSize: 15 }}
                  >
                    Annuler
                  </button>
                  {(() => {
                    const isBlocked = formStep === 1 ? (!form.depart || !form.arrivee) : formStep === 2 ? !form.heure : false;
                    return (
                      <button
                        type="button"
                        disabled={isBlocked}
                        onClick={() => {
                          const next = formStep + 1;
                          if (next === 4) step3EnteredAtRef.current = Date.now();
                          setFormStep(next);
                        }}
                        style={{
                          ...styles.btnPrimary, flex: 1, minHeight: 52, fontSize: 16, justifyContent: "center",
                          opacity: isBlocked ? 0.5 : 1,
                          cursor: isBlocked ? "not-allowed" : "pointer",
                        }}
                      >
                        Continuer
                      </button>
                    );
                  })()}
                </>
              ) : (
                <>
                  <button type="button" onClick={() => setFormStep(3)} style={{ ...styles.btnGhost, minHeight: 52, fontSize: 15 }}>
                    Retour
                  </button>
                  <button type="submit" style={{ ...styles.btnPrimary, flex: 1, minHeight: 52, fontSize: 16, justifyContent: "center" }}>
                    {editingId ? "Enregistrer les modifications" : "Publier la course"}
                  </button>
                </>
              )}
            </div>
          </form>
        </div>
      )}

      {filter === "carte" ? (
        <main style={{ padding: "0 24px" }}>
          <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 6 }}>
            {mapDrivers.length === 0
              ? "Aucun chauffeur ne partage sa position pour l'instant."
              : `${mapDrivers.length} chauffeur${mapDrivers.length > 1 ? "s" : ""} visible${mapDrivers.length > 1 ? "s" : ""} (position partagée il y a moins de 15 min)${radiusFilter !== "all" && myPosForMap ? `, dans un rayon de ${radiusFilter} km` : ""}.`}
          </p>
          <p style={{ color: "var(--text-faint)", fontSize: 12, marginBottom: 12, display: "flex", gap: 14, alignItems: "center" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "#3BD07A", display: "inline-block" }} /> Libre</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "#E5484D", display: "inline-block" }} /> En course</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "#FFB43A", display: "inline-block" }} /> Toi</span>
          </p>
          <div ref={mapContainerRef} style={styles.mapContainer} />
        </main>
      ) : (
      <main style={styles.board}>
        {visibleRides.length === 0 ? (
          <div style={styles.emptyState}>
            <div style={{ ...styles.emptyIcon, position: "relative", background: filter === "dispo" ? "rgba(59,208,122,0.08)" : "var(--border-subtle)" }}>
              {filter === "dispo" && (
                <>
                  <span className="rp-radar-ring" />
                  <span className="rp-radar-ring" />
                  <span className="rp-radar-ring" />
                </>
              )}
              <Car size={32} color={filter === "dispo" ? "#3BD07A" : "var(--border-outline)"} style={{ position: "relative" }} />
            </div>
            <p style={styles.emptyTitle}>
              {filter === "dispo" ? "Aucune course disponible pour l'instant" : "Rien à afficher ici"}
            </p>
            <p style={styles.emptySub}>
              {filter === "dispo"
                ? "Le réseau s'enrichit au fil des courses postées par les chauffeurs. Reviens bientôt, ou poste la première."
                : "Change d'onglet ou de filtre de date pour voir d'autres courses."}
              {(filter === "dispo" || filter === "toutes") && radiusFilter !== "all" && myPos && (
                <> Essaie aussi d'élargir le rayon de recherche ci-dessus.</>
              )}
            </p>
          </div>
        ) : (
          visibleRides.map((r) => {
            const meta = typeMeta(r.type);
            const mine = r.postedBy === driverName;
            const takenByMe = r.takenBy === driverName;
            const pendingByMe = r.pendingBy === driverName;
            const pendingRemainingMs = r.pendingSince ? CLAIM_CONFIRM_WINDOW_MS - (Date.now() - r.pendingSince) : 0;
            const priorityDrivers = priorityDriversFor(r);
            const withinWindow = Date.now() < priorityWindowEndsAt(r);
            const remainingMs = priorityWindowEndsAt(r) - Date.now();
            const remainingLabel = remainingMs > 0 ? `${Math.ceil(remainingMs / 1000)}s` : null;
            const iAmPriority = priorityDrivers.some((d) => d.name === driverName);
            const isPriorityLocked =
              r.status === "disponible" && priorityDrivers.length > 0 && withinWindow && !iAmPriority && !mine;
            const timing = rideTimingBadge(r);

            return (
              <div
                key={r.id}
                style={{ ...styles.card, cursor: "pointer" }}
                onClick={() => setSelectedRide(r)}
              >
                {r.urgent && (
                  <div className="rp-beacon-pulse" style={styles.urgentBadge}>
                    <Siren size={12} style={{ marginRight: 4 }} />
                    URGENT
                  </div>
                )}
                <div style={styles.cardHeader}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ ...styles.typeTag, background: tintBg(meta.color, 0.12), color: meta.color }}>
                      <meta.icon size={12} style={{ marginRight: 4 }} />
                      {meta.label}
                    </span>
                    {r.tpmr && (
                      <span style={styles.tpmrBadge} title="Transport de personne à mobilité réduite">TPMR</span>
                    )}
                  </div>
                  <span style={{
                    ...styles.statusTag,
                    color: statusColor(r.status), background: tintBg(statusColor(r.status), 0.14),
                  }}>
                    {r.status === "disponible" ? "Disponible"
                      : r.status === "en_attente" ? `En attente (${r.pendingBy})`
                      : r.status === "en_cours" ? `En cours (${r.takenBy})`
                      : r.status === "terminee" ? "Terminée"
                      : `Prise par ${r.takenBy}`}
                  </span>
                </div>

                {timing && (
                  <div
                    className={timing.pulse ? "rp-beacon-pulse" : undefined}
                    style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 20, fontSize: 12.5, fontWeight: 800, background: timing.bg, color: timing.color, marginBottom: 10 }}
                  >
                    <Clock size={12} /> {timing.label}
                  </div>
                )}

                {r.photo && <img src={r.photo} alt="Bon de transport" style={styles.cardThumb} />}

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
                  <div style={{ display: "flex", gap: 10, flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 8, flexShrink: 0, padding: "4px 0" }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#FFB43A", flexShrink: 0 }} />
                      <span style={{ flex: 1, width: 2, minHeight: 16, background: "var(--border-outline)", margin: "3px 0", borderRadius: 1 }} />
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--text-faint)", flexShrink: 0 }} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 14, minWidth: 0, flex: 1 }}>
                      <span style={{ fontWeight: 700, fontSize: 15, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cardLocality(r.depart)}</span>
                      <span style={{ fontWeight: 600, fontSize: 15, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cardLocality(r.arrivee)}</span>
                    </div>
                  </div>
                  {r.tarif && <span style={styles.tarifTag}>{r.tarif} €</span>}
                </div>

                <div style={styles.metaRow}>
                  <span style={styles.metaItem}><Clock size={13} /> Prise en charge : {formatRideDate(r.date)} à {r.heure} — {trajetLabel(r.trajet)}</span>
                  {r.heureRetour && <span style={styles.metaItem}>Retour : {r.heureRetour}</span>}
                  {r.calcDistanceKm != null && (
                    <span style={styles.metaItem}>
                      ({r.calcDistanceKm} km {r.calcIsRoadDistance ? "réels (route)" : "à vol d'oiseau"})
                    </span>
                  )}
                  {r.patient && <span style={styles.metaItem}>Patient : {r.patient}</span>}
                  {r.patientTel && (
                    <a
                      href={`tel:${r.patientTel.replace(/\s/g, "")}`}
                      onClick={(e) => e.stopPropagation()}
                      style={{ ...styles.metaItem, color: "var(--accent-text)", textDecoration: "underline" }}
                    >
                      <Phone size={12} /> {r.patientTel}
                    </a>
                  )}
                  {r._dist != null && (
                    <span style={{ ...styles.metaItem, color: "var(--accent-text)", fontWeight: 600 }}>
                      <Navigation size={12} /> À {r._dist.toFixed(1)} km de vous · ~{Math.round((r._dist / AVG_SPEED_KMH) * 60)} min
                    </span>
                  )}
                </div>

                {r.notes && <p style={styles.notes}>{r.notes}</p>}

                {isPriorityLocked && (
                  <div style={styles.priorityBanner}>
                    <Timer size={13} style={{ marginRight: 6 }} />
                    {priorityDrivers.length === 1
                      ? `Priorité à ${priorityDrivers[0].name}${priorityDrivers[0].dist != null ? ` (${priorityDrivers[0].dist.toFixed(1)} km)` : ""}`
                      : `Priorité aux ${priorityDrivers.length} chauffeurs les plus proches`}
                    {" "}— ouvert à tous dans {remainingLabel}
                  </div>
                )}

                {r.status === "disponible" && withinWindow && iAmPriority && !mine && (
                  <div style={styles.priorityBanner}>
                    <Timer size={13} style={{ marginRight: 6 }} />
                    {priorityDrivers.length === 1
                      ? `Tu es le plus proche — priorité pendant ${remainingLabel}`
                      : `Tu fais partie des ${priorityDrivers.length} plus proches — premier arrivé, premier servi (${remainingLabel})`}
                  </div>
                )}

                {renderModifBanner(r, { compact: true })}
                {r.status === "en_attente" && mine && (
                  <div style={styles.pendingBanner}>
                    <strong>{r.pendingBy}</strong> veut prendre cette course — confirmation automatique dans{" "}
                    {Math.max(0, Math.ceil(pendingRemainingMs / 1000))}s
                  </div>
                )}
                {r.status === "en_attente" && pendingByMe && (
                  <div style={styles.pendingBanner}>
                    En attente de confirmation de {r.postedBy}… ({Math.max(0, Math.ceil(pendingRemainingMs / 1000))}s)
                  </div>
                )}

                <div style={styles.cardFooter}>
                  <span style={styles.postedBy}>Posté par {r.postedBy} · {formatPostedAt(r.createdAt)}</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    {r.status === "disponible" && !mine && !isPriorityLocked && (
                      awaitingServerPriority(r) ? renderAwaitingClaimBtn(styles.btnClaim) : (
                        <button onClick={(e) => { e.stopPropagation(); claim(r); }} style={styles.btnClaim}>
                          <Check size={14} style={{ marginRight: 4 }} />
                          Je la prends
                        </button>
                      )
                    )}
                    {r.status === "en_attente" && mine && (
                      <>
                        <button onClick={(e) => { e.stopPropagation(); confirmClaim(r); }} style={styles.btnClaim}>
                          Confirmer
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); refuseClaim(r.id); }} style={styles.btnGhost}>
                          Refuser
                        </button>
                      </>
                    )}
                    {r.status === "en_attente" && pendingByMe && (
                      <button onClick={(e) => { e.stopPropagation(); cancelMyClaim(r.id); }} style={styles.btnGhost}>
                        Annuler ma demande
                      </button>
                    )}
                    {r.status === "prise" && takenByMe && (
                      <>
                        <button onClick={(e) => { e.stopPropagation(); startRide(r.id); }} style={styles.btnClaim}>
                          <Car size={14} style={{ marginRight: 4 }} /> Commencer
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); release(r.id); }} style={styles.btnGhost}>Relâcher</button>
                      </>
                    )}
                    {r.status === "en_cours" && takenByMe && (
                      <button onClick={(e) => { e.stopPropagation(); markDone(r.id); }} style={styles.btnClaim}>
                        <Check size={14} style={{ marginRight: 4 }} /> Terminer
                      </button>
                    )}
                    {(mine || isAdmin) && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm("Supprimer définitivement cette course ?")) remove(r.id);
                        }}
                        style={styles.iconBtn}
                        title="Supprimer"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </main>
      )}

      {selectedRide && (() => {
        // Dérivé de la liste live plutôt que figé sur l'instantané passé à
        // setSelectedRide, pour que la fenêtre reflète en direct les
        // changements de statut (ex. confirmation d'une demande en attente).
        const r = rides.find((x) => x.id === selectedRide.id) || selectedRide;
        const meta = typeMeta(r.type);
        const mine = r.postedBy === driverName;
        const takenByMe = r.takenBy === driverName;
        const pendingByMe = r.pendingBy === driverName;
        const pendingRemainingMs = r.pendingSince ? CLAIM_CONFIRM_WINDOW_MS - (Date.now() - r.pendingSince) : 0;
        const priorityDrivers = priorityDriversFor(r);
        const withinWindow = Date.now() < priorityWindowEndsAt(r);
        const iAmPriority = priorityDrivers.some((d) => d.name === driverName);
        const isPriorityLocked =
          r.status === "disponible" && priorityDrivers.length > 0 && withinWindow && !iAmPriority && !mine;
        const dist = myPos ? distanceKm(myPos, ridePickupCoords(r)) : null;
        const timing = rideTimingBadge(r);
        return (
          <div style={styles.modalOverlay} onClick={() => setSelectedRide(null)}>
            <div style={styles.modalCard} onClick={(e) => e.stopPropagation()}>
              <div style={styles.modalHeader}>
                <span style={{ ...styles.typeTag, background: tintBg(meta.color, 0.12), color: meta.color }}>
                  <meta.icon size={12} style={{ marginRight: 4 }} />
                  {meta.label}
                </span>
                <button onClick={() => setSelectedRide(null)} style={styles.iconBtn}>
                  <X size={16} />
                </button>
              </div>

              {timing && (
                <div
                  className={timing.pulse ? "rp-beacon-pulse" : undefined}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 20, fontSize: 13, fontWeight: 800, background: timing.bg, color: timing.color, marginBottom: 12 }}
                >
                  <Clock size={13} /> {timing.label}
                </div>
              )}

              {r.urgent && (
                <div className="rp-beacon-pulse" style={{ ...styles.urgentBadge, position: "static", display: "inline-flex", marginBottom: 12 }}>
                  <Siren size={12} style={{ marginRight: 4 }} />
                  URGENT
                </div>
              )}

              <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-subtle)", borderRadius: 14, marginBottom: 18, padding: "14px 14px", display: "flex", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 9, flexShrink: 0, padding: "5px 0" }}>
                  <span style={{ width: 9, height: 9, borderRadius: "50%", background: "#FFB43A", flexShrink: 0 }} />
                  <span style={{ flex: 1, width: 2, minHeight: 26, background: "var(--border-outline)", margin: "4px 0", borderRadius: 1 }} />
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: "var(--text-faint)", flexShrink: 0 }} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 20, flex: 1, minWidth: 0 }}>
                  {/* Adresse complète sur plusieurs lignes si besoin : le chauffeur doit pouvoir
                      la lire en entier, les boutons Waze/Maps restent alignés sur la 1re ligne. */}
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                    <span style={{ fontWeight: 700, fontSize: 15.5, lineHeight: 1.35, color: "var(--text-primary)", overflowWrap: "anywhere", minWidth: 0, paddingTop: 6 }}>{r.depart}</span>
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      <a href={wazeUrl(r.departLat, r.departLng, r.depart)} target="_blank" rel="noopener noreferrer" style={{ ...styles.navIconBtn, background: "#05C8F7" }} aria-label="Waze vers le départ" title="Waze">W</a>
                      <a href={googleMapsUrl(r.departLat, r.departLng, r.depart)} target="_blank" rel="noopener noreferrer" style={{ ...styles.navIconBtn, background: "#4285F4" }} aria-label="Maps vers le départ" title="Maps">M</a>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                    <span style={{ fontWeight: 600, fontSize: 15.5, lineHeight: 1.35, color: "var(--text-tertiary)", overflowWrap: "anywhere", minWidth: 0, paddingTop: 6 }}>{r.arrivee}</span>
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      <a href={wazeUrl(r.arriveeLat, r.arriveeLng, r.arrivee)} target="_blank" rel="noopener noreferrer" style={{ ...styles.navIconBtn, background: "#05C8F7" }} aria-label="Waze vers l'arrivée" title="Waze">W</a>
                      <a href={googleMapsUrl(r.arriveeLat, r.arriveeLng, r.arrivee)} target="_blank" rel="noopener noreferrer" style={{ ...styles.navIconBtn, background: "#4285F4" }} aria-label="Maps vers l'arrivée" title="Maps">M</a>
                    </div>
                  </div>
                </div>
              </div>

              <div style={styles.modalGrid}>
                <div style={styles.modalRow}>
                  <Clock size={16} color="#FFB43A" />
                  <span>Prise en charge {formatRideDate(r.date)} à {r.heure} — {trajetLabel(r.trajet)}</span>
                </div>
                {r.heureRetour && (
                  <div style={styles.modalRow}>
                    <Clock size={16} color="#8A9099" />
                    <span>Retour prévu à {r.heureRetour}</span>
                  </div>
                )}
                {r.tarif && (
                  <div style={styles.modalRow}>
                    <span className="rp-meter" style={{ fontSize: 28 }}>{r.tarif} €</span>
                  </div>
                )}
                {r.calcDistanceKm != null && (
                  <div style={styles.modalRow}>
                    <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
                      Distance {r.calcIsRoadDistance ? "routière réelle" : "estimée (à vol d'oiseau)"} : {r.calcDistanceKm} km
                    </span>
                  </div>
                )}
                {r.patient && (
                  <div style={styles.modalRow}>
                    <User size={16} color="#8A9099" />
                    <span>Patient : {r.patient}</span>
                  </div>
                )}
                {r.patientTel && (
                  <a href={`tel:${r.patientTel.replace(/\s/g, "")}`} style={styles.callBtn}>
                    <span style={styles.callBtnIcon}><Phone size={16} color="#fff" /></span>
                    <span style={styles.callBtnText}>
                      <span style={styles.callBtnLabel}>Appeler le patient</span>
                      <span style={styles.callBtnSub}>{r.patientTel}</span>
                    </span>
                  </a>
                )}
                {r.tpmr && (
                  <div style={styles.modalRow}>
                    <span style={styles.tpmrBadge}>TPMR</span>
                    <span>Mobilité réduite</span>
                  </div>
                )}
                {dist != null && (
                  <div style={styles.modalRow}>
                    <Navigation size={16} color="#FFB43A" />
                    <span>{dist.toFixed(1)} km de toi</span>
                  </div>
                )}
                <div style={styles.modalRow}>
                  <span style={{
                    ...styles.statusTag,
                    color: statusColor(r.status), background: tintBg(statusColor(r.status), 0.14),
                  }}>
                    {r.status === "disponible" ? "Disponible"
                      : r.status === "en_attente" ? `En attente de confirmation (${r.pendingBy})`
                      : r.status === "en_cours" ? `En cours (${r.takenBy})`
                      : r.status === "terminee" ? "Terminée"
                      : `Prise par ${r.takenBy}`}
                  </span>
                </div>
                <div style={styles.modalRow}>
                  <span style={{ color: "var(--text-faint)", fontSize: 13 }}>Posté par {r.postedBy} · publiée le {formatPostedAt(r.createdAt)}</span>
                </div>
                {!mine && profiles[r.postedBy]?.phone && (
                  <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                    <a href={`tel:${profiles[r.postedBy].phone.replace(/\s/g, "")}`} style={{ ...styles.callBtn, flex: 1 }}>
                      <span style={styles.callBtnIcon}><Phone size={16} color="#fff" /></span>
                      <span style={styles.callBtnText}>
                        <span style={styles.callBtnLabel}>Appeler {r.postedBy}</span>
                        <span style={styles.callBtnSub}>a posté cette course</span>
                      </span>
                    </a>
                    <a href={`sms:${profiles[r.postedBy].phone.replace(/\s/g, "")}`} style={styles.smsIconBtn} aria-label="Envoyer un SMS" title="SMS">
                      <MessageCircle size={18} />
                    </a>
                  </div>
                )}
                {(mine || takenByMe || pendingByMe) && (
                  <button
                    onClick={() => setChatRideId(r.id)}
                    style={{ ...styles.btnPrimaryAction, marginTop: 4 }}
                  >
                    <MessageCircle size={16} /> Discuter dans l'appli
                  </button>
                )}
              </div>

              {r.notes && (
                <div style={{ ...styles.notes, marginTop: 12 }}>
                  <strong>Notes :</strong> {r.notes}
                </div>
              )}

              {r.photo && (
                <a href={r.photo} download={`bon-transport-${r.id}.jpg`}>
                  <img src={r.photo} alt="Bon de transport" style={styles.modalPhoto} />
                </a>
              )}

              {r.document && (mine || takenByMe || pendingByMe) && (
                <button
                  type="button"
                  onClick={() => openPdfDocument(r.document, r.documentName || `bon-transport-${r.id}.pdf`)}
                  style={{
                    ...styles.contactBtn, display: "block", width: "100%", marginTop: 10,
                    textAlign: "center", border: "none", cursor: "pointer",
                  }}
                >
                  <FileText size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> Ouvrir le bon de transport (PDF)
                </button>
              )}
              {r.document && !mine && !takenByMe && !pendingByMe && (
                <p style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 10, display: "flex", alignItems: "center", gap: 5 }}>
                  <FileText size={12} /> Un bon de transport est joint — accessible une fois la course prise.
                </p>
              )}

              {isPriorityLocked && (
                <div style={styles.priorityBanner}>
                  <Timer size={13} style={{ marginRight: 6 }} />
                  {priorityDrivers.length === 1
                    ? `Priorité à ${priorityDrivers[0].name}${priorityDrivers[0].dist != null ? ` (${priorityDrivers[0].dist.toFixed(1)} km)` : ""}`
                    : `Priorité aux ${priorityDrivers.length} chauffeurs les plus proches`}
                </div>
              )}

              {r.status === "disponible" && withinWindow && iAmPriority && !mine && (
                <div style={styles.priorityBanner}>
                  <Timer size={13} style={{ marginRight: 6 }} />
                  {priorityDrivers.length === 1
                    ? "Tu es le plus proche — tu es prioritaire sur cette course."
                    : `Tu fais partie des ${priorityDrivers.length} plus proches — le premier qui accepte l'obtient.`}
                </div>
              )}

              {renderModifBanner(r)}
              {r.status === "en_attente" && mine && (
                <div style={styles.pendingBanner}>
                  <strong>{r.pendingBy}</strong> veut prendre cette course — confirmation automatique dans{" "}
                  {Math.max(0, Math.ceil(pendingRemainingMs / 1000))}s
                </div>
              )}
              {r.status === "en_attente" && pendingByMe && (
                <div style={styles.pendingBanner}>
                  En attente de confirmation de {r.postedBy}… ({Math.max(0, Math.ceil(pendingRemainingMs / 1000))}s)
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border-outline)" }}>
                {r.status === "disponible" && !mine && !isPriorityLocked && (
                  awaitingServerPriority(r) ? renderAwaitingClaimBtn(styles.btnPrimaryAction) : (
                    <button onClick={() => claim(r)} style={styles.btnPrimaryAction}>
                      <Check size={16} /> Je la prends
                    </button>
                  )
                )}
                {r.status === "en_attente" && mine && (
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => { confirmClaim(r); setSelectedRide(null); }} style={{ ...styles.btnPrimaryAction, width: "auto", flex: 1 }}>
                      Confirmer
                    </button>
                    <button onClick={() => { refuseClaim(r.id); setSelectedRide(null); }} style={styles.btnSecondaryAction}>
                      Refuser
                    </button>
                  </div>
                )}
                {r.status === "en_attente" && pendingByMe && (
                  <button onClick={() => { cancelMyClaim(r.id); setSelectedRide(null); }} style={styles.btnSecondaryAction}>
                    Annuler ma demande
                  </button>
                )}
                {r.status === "prise" && takenByMe && (
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => { startRide(r.id); setSelectedRide(null); }} style={{ ...styles.btnPrimaryAction, width: "auto", flex: 1 }}>
                      <Car size={16} /> Commencer
                    </button>
                    <button onClick={() => { release(r.id); setSelectedRide(null); }} style={styles.btnSecondaryAction}>
                      Relâcher
                    </button>
                  </div>
                )}
                {r.status === "en_cours" && takenByMe && (
                  <button onClick={() => { markDone(r.id); setSelectedRide(null); }} style={styles.btnPrimaryAction}>
                    <Check size={16} /> Terminer
                  </button>
                )}

                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <button onClick={() => duplicateRide(r)} style={styles.btnUtilityAction}>
                    <Copy size={14} /> Dupliquer
                  </button>
                  {mine && ["disponible", "en_attente", "prise", "en_cours"].includes(r.status) && (
                    <button onClick={() => startEdit(r)} style={styles.btnUtilityAction}>
                      <Pencil size={14} /> Modifier
                    </button>
                  )}
                  {(mine || isAdmin) && (
                    <button
                      onClick={() => {
                        if (window.confirm("Supprimer définitivement cette course ?")) {
                          remove(r.id);
                          setSelectedRide(null);
                        }
                      }}
                      style={{ ...styles.btnUtilityAction, color: "#E5484D", borderColor: "#E5484D" }}
                    >
                      <Trash2 size={14} /> Supprimer
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      <div className="rp-bottom-spacer" />

      <nav className="rp-bottom-nav" style={styles.bottomNav}>
        <button
          onClick={() => setFilter("dispo")}
          style={{ ...styles.bottomNavBtn, color: filter === "dispo" ? "var(--accent-text)" : "var(--text-muted)", position: "relative" }}
        >
          <Home size={22} />
          {newRidesBadge > 0 && (
            <span style={styles.navBadge}>{newRidesBadge > 9 ? "9+" : newRidesBadge}</span>
          )}
          <span style={styles.bottomNavLabel}>Accueil</span>
        </button>
        <button
          onClick={() => setShowMyCoursesPanel(true)}
          style={{ ...styles.bottomNavBtn, color: "var(--text-muted)" }}
        >
          <Car size={22} />
          <span style={styles.bottomNavLabel}>Courses</span>
        </button>
        {/* Emplacement réservé au bouton + flottant, pour qu'il ne recouvre aucun onglet. */}
        <div style={styles.bottomNavFabSlot} aria-hidden="true" />
        <button onClick={() => setShowMessagesPanel(true)} style={{ ...styles.bottomNavBtn, color: "var(--text-muted)", position: "relative" }}>
          <MessageCircle size={22} />
          {totalUnreadMessages > 0 && (
            <span style={styles.navBadge}>{totalUnreadMessages > 9 ? "9+" : totalUnreadMessages}</span>
          )}
          <span style={styles.bottomNavLabel}>Messages</span>
        </button>
        <button onClick={() => setShowAccountPanel(true)} style={{ ...styles.bottomNavBtn, color: "var(--text-muted)" }}>
          <User size={22} />
          <span style={styles.bottomNavLabel}>Compte</span>
        </button>
      </nav>
      <button
        onClick={() => {
          if (showForm) {
            setShowForm(false);
            setEditingId(null);
            setForm(emptyForm);
            editOriginalTarifInputs.current = null;
          } else {
            setEditingId(null);
            setForm(emptyForm);
            editOriginalTarifInputs.current = null;
            setFormStep(1);
            setPickupMode(null);
            setShowForm(true);
          }
        }}
        className="rp-fab-floating"
        style={styles.bottomNavFabFloating}
        aria-label={showForm ? "Fermer le formulaire" : "Poster une course"}
      >
        {showForm ? <X size={26} color="#1A1206" /> : <Plus size={26} color="#1A1206" />}
      </button>

      {showAccountPanel && (
        <div style={styles.wizardOverlay}>
          <div style={styles.fullPageHeader}>
            {accountSubPanel ? (
              <button onClick={() => setAccountSubPanel(null)} style={styles.wizardNavBtn} aria-label="Retour">
                <ChevronLeft size={20} />
              </button>
            ) : (
              <span style={{ width: 38 }} />
            )}
            <h2 style={styles.fullPageTitle}>
              {accountSubPanel === "profile" ? "Modifier mon profil"
                : accountSubPanel === "settings" ? "Réglages"
                : accountSubPanel === "company" ? "Ma société"
                : accountSubPanel === "dashboard" ? "Tableau de bord"
                : accountSubPanel === "support" ? "Aide & réclamations"
                : driverName}
            </h2>
            <button onClick={() => { setShowAccountPanel(false); setAccountSubPanel(null); }} style={styles.wizardNavBtn} aria-label="Fermer">
              <X size={20} />
            </button>
          </div>
          <div style={styles.wizardBody}>

            {!accountSubPanel && (
              <>
                <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>{user?.email}</p>
                <div style={styles.gainsCard}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <span style={styles.gainsLabel}>Gains {earningsLabel}</span>
                    <span style={styles.gainsAmount}>{myEarnings.toFixed(2)} €</span>
                  </div>
                  <span style={styles.gainsCount}>
                    {myTakenRides.length} course{myTakenRides.length > 1 ? "s" : ""}<br />reprise{myTakenRides.length > 1 ? "s" : ""}
                  </span>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
                  <button onClick={() => setAccountSubPanel("profile")} style={styles.categoryBtn}>
                    <span style={styles.categoryBtnLeft}><User size={16} /> Modifier mon profil</span>
                    <span style={{ color: "var(--text-faint)" }}>›</span>
                  </button>
                  <button onClick={() => setAccountSubPanel("settings")} style={styles.categoryBtn}>
                    <span style={styles.categoryBtnLeft}><Settings size={16} /> Réglages (service, notifications)</span>
                    <span style={{ color: "var(--text-faint)" }}>›</span>
                  </button>
                  <button onClick={() => setAccountSubPanel("company")} style={styles.categoryBtn}>
                    <span style={styles.categoryBtnLeft}><Building2 size={16} /> Ma société</span>
                    <span style={{ color: "var(--text-faint)" }}>›</span>
                  </button>
                  <button onClick={() => setAccountSubPanel("dashboard")} style={styles.categoryBtn}>
                    <span style={styles.categoryBtnLeft}><LayoutDashboard size={16} /> Tableau de bord</span>
                    <span style={{ color: "var(--text-faint)" }}>›</span>
                  </button>
                  <button onClick={() => setAccountSubPanel("support")} style={styles.categoryBtn}>
                    <span style={styles.categoryBtnLeft}><LifeBuoy size={16} /> Aide & réclamations</span>
                    <span style={{ color: "var(--text-faint)" }}>›</span>
                  </button>
                  {isAdmin && (
                    <button
                      onClick={() => { setShowAdminPanel(true); setShowAccountPanel(false); }}
                      style={{ ...styles.categoryBtn, borderColor: "#FFB43A", color: "var(--accent-text)" }}
                    >
                      <span style={styles.categoryBtnLeft}><Shield size={16} /> Administration</span>
                      <span>›</span>
                    </button>
                  )}
                  <button
                    onClick={() => logOut()}
                    style={{ ...styles.categoryBtn, borderColor: "#E5484D", color: "#E5484D" }}
                  >
                    <span style={styles.categoryBtnLeft}><LogOut size={16} /> Se déconnecter</span>
                  </button>
                </div>
              </>
            )}

            {accountSubPanel === "profile" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <label style={styles.fieldLabel}>
                  Pseudo
                  <input style={{ ...styles.input, opacity: 0.6 }} value={driverName} disabled />
                  <span style={{ color: "var(--text-faint)", fontSize: 12, fontWeight: 400 }}>
                    Fixe — il sert d'identifiant technique pour tes courses et messages. Contacte l'administrateur si tu as vraiment besoin d'en changer.
                  </span>
                </label>

                <label style={styles.fieldLabel}>
                  Adresse email de connexion
                  <span style={{ color: "var(--text-muted)", fontSize: 13, fontWeight: 400 }}>Actuelle : {user?.email}</span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      type="email"
                      placeholder="Nouvelle adresse email"
                      value={newEmailInput}
                      onChange={(e) => setNewEmailInput(e.target.value)}
                      style={{ ...styles.input, flex: 1 }}
                    />
                    <button type="button" onClick={handleEmailChange} style={styles.btnGhost}>
                      Changer
                    </button>
                  </div>
                  {emailChangeStatus && (
                    <span style={{ fontSize: 12.5, color: emailChangeStatus.ok ? "var(--positive-text)" : "#E5484D" }}>
                      {emailChangeStatus.text}
                    </span>
                  )}
                </label>

                <label style={styles.fieldLabel}>
                  Ton numéro de téléphone (pour que les autres te contactent)
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      type="tel"
                      placeholder="Ex: 06 12 34 56 78"
                      value={phoneInput || profiles[driverName]?.phone || ""}
                      onChange={(e) => setPhoneInput(e.target.value)}
                      style={{ ...styles.input, flex: 1 }}
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        const val = phoneInput || profiles[driverName]?.phone || "";
                        try {
                          await setDriverPhone(driverName, val);
                          setError("");
                        } catch (e) {
                          setError("Échec de l'enregistrement du numéro.");
                        }
                      }}
                      style={styles.btnGhost}
                    >
                      Enregistrer
                    </button>
                  </div>
                </label>

                <label style={styles.fieldLabel}>
                  Ta commune de rattachement
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      placeholder="Ex: Haguenau"
                      value={communeInput}
                      onChange={(e) => setCommuneInput(e.target.value)}
                      style={{ ...styles.input, flex: 1 }}
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await updateProfileFields(driverName, { commune: communeInput.trim() });
                          setError("");
                        } catch (e) {
                          setError("Échec de l'enregistrement de la commune.");
                        }
                      }}
                      style={styles.btnGhost}
                    >
                      Enregistrer
                    </button>
                  </div>
                </label>

                <label style={styles.fieldLabel}>
                  Numéro de licence taxi
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      placeholder="Numéro de licence"
                      value={licenseInput}
                      onChange={(e) => setLicenseInput(e.target.value)}
                      style={{ ...styles.input, flex: 1 }}
                    />
                    <button type="button" onClick={handleLicenseChange} style={styles.btnGhost}>
                      Enregistrer
                    </button>
                  </div>
                  {licenseChangeStatus && (
                    <span style={{ fontSize: 12.5, color: licenseChangeStatus.ok ? "var(--positive-text)" : "#E5484D" }}>
                      {licenseChangeStatus.text}
                    </span>
                  )}
                </label>

                <label style={styles.fieldLabel}>
                  Ton département de licence (taxi conventionné)
                  <select
                    value={driverDept}
                    onChange={(e) => updateDriverDept(e.target.value)}
                    style={styles.input}
                  >
                    {DEPARTMENT_KM_RATES.map(([code, name, rate]) => (
                      <option key={code} value={code}>
                        {code} — {name} ({rate.toFixed(2)} €/km)
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            {accountSubPanel === "settings" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={styles.myCoursesSectionTitle}>Affichage</div>
                <div style={{ display: "flex", gap: 4, background: "var(--surface-card)", border: "1px solid var(--border-subtle)", borderRadius: 12, padding: 4, marginBottom: 14 }}>
                  {[
                    { id: "auto", label: "Automatique" },
                    { id: "light", label: "Clair" },
                    { id: "dark", label: "Sombre" },
                  ].map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setTheme(t.id)}
                      style={{
                        flex: 1, border: "none", borderRadius: 9, minHeight: 44, fontSize: 14.5, fontWeight: 700, cursor: "pointer",
                        background: theme === t.id ? "#FFB43A" : "transparent",
                        color: theme === t.id ? "#1A1206" : "var(--text-tertiary)",
                      }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "-8px 2px 14px" }}>
                  « Automatique » suit le réglage clair/sombre du téléphone.
                </p>
                <div style={styles.myCoursesSectionTitle}>Service et notifications</div>
                <button
                  onClick={() => {
                    sharePosition();
                  }}
                  style={{
                    ...styles.btnGhost,
                    borderColor: myPosStatus === "ok" ? "#3BD07A" : "var(--border-outline)",
                    color: myPosStatus === "ok" ? "var(--positive-text)" : "var(--text-primary)",
                    textAlign: "left",
                  }}
                >
                  <Navigation size={14} style={{ marginRight: 8 }} />
                  {myPosStatus === "ok" ? "En service — toucher pour se mettre hors service" : "Se mettre en service"}
                </button>
                {notifPermission !== "unsupported" && (
                  <button
                    onClick={requestNotifPermission}
                    disabled={notifPermission === "granted"}
                    style={{
                      ...styles.btnGhost,
                      borderColor: notifPermission === "granted" ? "#3BD07A" : "var(--border-outline)",
                      color: notifPermission === "granted" ? "var(--positive-text)" : "var(--text-primary)",
                      textAlign: "left",
                    }}
                  >
                    <Siren size={14} style={{ marginRight: 8 }} />
                    {notifPermission === "granted"
                      ? "Notifications activées"
                      : notifPermission === "denied"
                      ? "Notifications bloquées (à réactiver dans les réglages du navigateur)"
                      : "Activer les notifications"}
                  </button>
                )}
              </div>
            )}

            {accountSubPanel === "company" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <label style={styles.fieldLabel}>
                  Nom de la société
                  <input
                    placeholder="Ex: Taxi Dupont SARL"
                    value={companyInput.companyName}
                    onChange={(e) => setCompanyInput({ ...companyInput, companyName: e.target.value })}
                    style={styles.input}
                  />
                </label>
                <label style={styles.fieldLabel}>
                  Numéro SIRET
                  <input
                    placeholder="14 chiffres"
                    value={companyInput.siret}
                    onChange={(e) => setCompanyInput({ ...companyInput, siret: e.target.value })}
                    style={styles.input}
                  />
                </label>
                <label style={styles.fieldLabel}>
                  Adresse de la société
                  <textarea
                    placeholder="Adresse complète"
                    value={companyInput.companyAddress}
                    onChange={(e) => setCompanyInput({ ...companyInput, companyAddress: e.target.value })}
                    style={{ ...styles.input, minHeight: 60 }}
                  />
                </label>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await updateProfileFields(driverName, companyInput);
                      setError("");
                    } catch (e) {
                      setError("Échec de l'enregistrement des informations société.");
                    }
                  }}
                  style={styles.btnPrimary}
                >
                  Enregistrer
                </button>
              </div>
            )}

            {accountSubPanel === "dashboard" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
                  Résumé {earningsLabel} — change le filtre de date depuis l'accueil pour changer la période.
                </p>
                <div style={styles.gainsCard}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <span style={styles.gainsLabel}>Courses déposées</span>
                    <span style={styles.gainsAmount}>{myPostedValue.toFixed(2)} €</span>
                  </div>
                  <span style={styles.gainsCount}>
                    {myPostedRides.length} course{myPostedRides.length > 1 ? "s" : ""}<br />postée{myPostedRides.length > 1 ? "s" : ""}
                  </span>
                </div>
                <div style={styles.gainsCard}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <span style={styles.gainsLabel}>Courses prises</span>
                    <span style={styles.gainsAmount}>{myEarnings.toFixed(2)} €</span>
                  </div>
                  <span style={styles.gainsCount}>
                    {myTakenRides.length} course{myTakenRides.length > 1 ? "s" : ""}<br />reprise{myTakenRides.length > 1 ? "s" : ""}
                  </span>
                </div>
              </div>
            )}

            {accountSubPanel === "support" && (() => {
              const adminEntry = Object.entries(profiles).find(([, p]) => p.email === ADMIN_EMAIL);
              const adminPhone = adminEntry?.[1]?.phone || null;
              const mailSubject = encodeURIComponent("Réclamation / support RoulePartner");
              const mailBody = encodeURIComponent(`Chauffeur : ${driverName}\n\nDécris ton problème ici :\n`);
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
                    Un souci avec une course, un chauffeur, ou l'application ? Précise ton pseudo et,
                    si besoin, la course concernée — ça aide à traiter la demande plus vite.
                  </p>
                  <a
                    href={`mailto:${ADMIN_EMAIL}?subject=${mailSubject}&body=${mailBody}`}
                    style={{ ...styles.categoryBtn, textDecoration: "none" }}
                  >
                    <span style={styles.categoryBtnLeft}><Mail size={16} /> Envoyer un email</span>
                    <span style={{ color: "var(--text-faint)" }}>›</span>
                  </a>
                  {adminPhone ? (
                    <a
                      href={`sms:${adminPhone.replace(/\s/g, "")}`}
                      style={{ ...styles.categoryBtn, textDecoration: "none" }}
                    >
                      <span style={styles.categoryBtnLeft}><MessageCircle size={16} /> Envoyer un SMS</span>
                      <span style={{ color: "var(--text-faint)" }}>›</span>
                    </a>
                  ) : (
                    <p style={{ color: "var(--text-faint)", fontSize: 12 }}>
                      Numéro de l'administrateur non renseigné pour l'instant — passe par email.
                    </p>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      )}


      {showAdminPanel && isAdmin && (
        <div style={styles.modalOverlay} onClick={() => setShowAdminPanel(false)}>
          <div
            style={{ ...styles.modalCard, maxWidth: 500, maxHeight: "80vh" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={styles.modalHeader}>
              <h2 style={{ ...styles.modalTitle, display: "flex", alignItems: "center", gap: 8 }}><Shield size={18} /> Administration</h2>
              <button onClick={() => setShowAdminPanel(false)} style={styles.iconBtn}>
                <X size={16} />
              </button>
            </div>
            <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 6 }}>
              {adminDriverNames.length} chauffeur{adminDriverNames.length > 1 ? "s" : ""} inscrit{adminDriverNames.length > 1 ? "s" : ""}.
              Bannir un chauffeur le déconnecte immédiatement et l'empêche de se reconnecter.
            </p>
            <p style={{ color: authSync?.error ? "#E5484D" : "var(--text-faint)", fontSize: 12, marginBottom: 16 }}>
              {authSync === "loading" ? "Synchronisation avec Firebase…"
                : authSync?.error ? `Synchro Firebase impossible : ${authSync.error}`
                : authSync?.removed?.length > 0 ? `Synchronisé avec Firebase — retiré${authSync.removed.length > 1 ? "s" : ""} : ${authSync.removed.join(", ")}.`
                : authSync ? "Synchronisé avec Firebase." : ""}
            </p>
            <div style={{ marginBottom: 16 }}>
              <button
                onClick={async () => {
                  setEmailRepairStatus("loading");
                  try {
                    const res = await backfillProfileEmails();
                    setEmailRepairStatus(res);
                  } catch (e) {
                    setEmailRepairStatus({ error: e.message || "Échec" });
                  }
                }}
                disabled={emailRepairStatus === "loading"}
                style={{ ...styles.btnGhost, fontSize: 12.5, padding: "8px 12px" }}
              >
                {emailRepairStatus === "loading" ? "Réparation en cours…" : "Réparer les emails manquants"}
              </button>
              {emailRepairStatus && emailRepairStatus !== "loading" && (
                <p style={{ color: emailRepairStatus.error ? "#E5484D" : "var(--text-muted)", fontSize: 12, marginTop: 6 }}>
                  {emailRepairStatus.error
                    ? `Erreur : ${emailRepairStatus.error}`
                    : `${emailRepairStatus.updated} profil(s) complété(s) sur ${emailRepairStatus.checked} vérifié(s). ${emailRepairStatus.authUserCount} compte(s) Firebase Auth trouvé(s).${emailRepairStatus.authError ? ` Erreur Auth : ${emailRepairStatus.authError}` : ""}`}
                </p>
              )}
              {emailRepairStatus?.missing?.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "0 0 6px" }}>
                    Toujours sans email — choisis le bon compte ci-dessous si tu le reconnais :
                  </p>
                  {emailRepairStatus.missing.map((name) => {
                    const candidates = emailRepairStatus.suggestions?.[name] || [];
                    return (
                      <div key={name} style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 700 }}>{name}</div>
                        {candidates.length === 0 ? (
                          <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>Aucun compte Auth ressemblant trouvé.</div>
                        ) : (
                          candidates.map((c) => (
                            <button
                              key={c.email}
                              onClick={async () => {
                                await assignProfileEmail(name, c.email);
                                setEmailRepairStatus((prev) => ({
                                  ...prev,
                                  missing: prev.missing.filter((n) => n !== name),
                                }));
                              }}
                              style={{ ...styles.btnGhost, fontSize: 11.5, padding: "4px 8px", marginRight: 6, marginTop: 3 }}
                            >
                              {c.email}{c.displayName ? ` (${c.displayName})` : " (sans nom)"}
                            </button>
                          ))
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[...adminDriverNames]
                .sort((a, b) => a.localeCompare(b))
                .map((name) => {
                  const p = profiles[name] || {};
                  const isOnline = positions[name]?.updatedAt && Date.now() - positions[name].updatedAt < 15 * 60 * 1000;
                  return (
                  <div
                    key={name}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      background: "var(--surface-card)", border: "1px solid var(--border-strong)", borderRadius: 8, padding: "10px 12px",
                      opacity: p.deleted ? 0.5 : 1,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>
                        {name} {name === driverName && "(toi)"}{" "}
                        <span style={{ fontSize: 11, fontWeight: 600, color: isOnline ? "var(--positive-text)" : "var(--text-faint)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: isOnline ? "#3BD07A" : "var(--text-faint)", display: "inline-block" }} />
                          {isOnline ? "en ligne" : "hors ligne"}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-faint)" }}>
                        {p.email || "email inconnu"} {p.phone && `· ${p.phone}`}
                        {p.licenseNumber && ` · Licence ${p.licenseNumber}`}
                        {p.commune && ` · ${p.commune}`}
                      </div>
                      {p.deleted ? (
                        <div style={{ fontSize: 12, color: "#E5484D", marginTop: 2 }}>Compte supprimé</div>
                      ) : p.banned && (
                        <div style={{ fontSize: 12, color: "#E5484D", marginTop: 2 }}>
                          Banni {p.bannedReason && `— ${p.bannedReason}`}
                        </div>
                      )}
                    </div>
                    {name !== driverName && (
                      <div style={{ display: "flex", gap: 6 }}>
                        {p.deleted ? (
                          <button
                            onClick={() => restoreDriverAccount(name)}
                            style={{ ...styles.btnGhost, borderColor: "#3BD07A", color: "var(--positive-text)", fontSize: 12, padding: "6px 10px" }}
                          >
                            Restaurer
                          </button>
                        ) : (
                          <>
                            <button
                              onClick={async () => {
                                if (p.banned) {
                                  await setDriverBanned(name, false);
                                } else {
                                  setBanTarget(name);
                                  setBanReason("");
                                }
                              }}
                              style={{
                                ...styles.btnGhost,
                                borderColor: p.banned ? "#3BD07A" : "#E5484D",
                                color: p.banned ? "var(--positive-text)" : "#E5484D",
                                fontSize: 12, padding: "6px 10px",
                              }}
                            >
                              {p.banned ? "Réactiver" : "Bannir"}
                            </button>
                            <button
                              onClick={() => setDeleteTarget(name)}
                              style={{ ...styles.btnGhost, borderColor: "#E5484D", color: "#E5484D", fontSize: 12, padding: "6px 10px" }}
                            >
                              Supprimer
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  );
                })}
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div style={styles.modalOverlay} onClick={() => setDeleteTarget(null)}>
          <div style={{ ...styles.modalCard, maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>Supprimer {deleteTarget}</h2>
              <button onClick={() => setDeleteTarget(null)} style={styles.iconBtn}>
                <X size={16} />
              </button>
            </div>
            <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 12 }}>
              Son téléphone et sa commune seront effacés, sa position retirée de la carte, et il ne pourra
              plus jamais se reconnecter tant que tu n'auras pas cliqué "Restaurer". Ses courses passées
              restent visibles dans l'historique.
            </p>
            <div style={styles.modalActions}>
              <button onClick={() => setDeleteTarget(null)} style={styles.btnGhost}>
                Annuler
              </button>
              <button
                onClick={async () => {
                  await deleteDriverAccount(deleteTarget);
                  setDeleteTarget(null);
                }}
                style={{ ...styles.btnPrimary, background: "#E5484D" }}
              >
                Supprimer définitivement
              </button>
            </div>
          </div>
        </div>
      )}

      {banTarget && (
        <div style={styles.modalOverlay} onClick={() => setBanTarget(null)}>
          <div style={{ ...styles.modalCard, maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>Bannir {banTarget}</h2>
              <button onClick={() => setBanTarget(null)} style={styles.iconBtn}>
                <X size={16} />
              </button>
            </div>
            <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 12 }}>
              Ce chauffeur sera déconnecté immédiatement et ne pourra plus se reconnecter tant que tu ne le réactives pas.
            </p>
            <label style={styles.fieldLabel}>
              Raison (optionnel, visible par toi seulement)
              <textarea
                value={banReason}
                onChange={(e) => setBanReason(e.target.value)}
                placeholder="Ex : comportement inapproprié, licence invalide…"
                style={{ ...styles.input, minHeight: 70, width: "100%" }}
              />
            </label>
            <div style={styles.modalActions}>
              <button onClick={() => setBanTarget(null)} style={styles.btnGhost}>
                Annuler
              </button>
              <button
                onClick={async () => {
                  await setDriverBanned(banTarget, true, banReason);
                  setBanTarget(null);
                }}
                style={{ ...styles.btnPrimary, background: "#E5484D" }}
              >
                Confirmer le bannissement
              </button>
            </div>
          </div>
        </div>
      )}

      {showMyCoursesPanel && (
        <div style={styles.wizardOverlay}>
          <div style={styles.fullPageHeader}>
            <span style={{ width: 38 }} />
            <h2 style={styles.fullPageTitle}>Mes courses</h2>
            <button onClick={() => setShowMyCoursesPanel(false)} style={styles.wizardNavBtn} aria-label="Fermer">
              <X size={20} />
            </button>
          </div>
          <div style={styles.wizardBody}>
            <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
              {[
                { id: "liste", label: "Liste", icon: List },
                { id: "calendrier", label: "Calendrier", icon: CalendarDays },
              ].map((t) => (
                <button
                  key={t.id}
                  onClick={() => setMyCoursesView(t.id)}
                  style={{
                    flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                    borderRadius: 10, padding: "11px 0", fontSize: 14, fontWeight: 700, cursor: "pointer",
                    border: myCoursesView === t.id ? "1.5px solid #FFB43A" : "1.5px solid var(--border-subtle)",
                    background: myCoursesView === t.id ? "rgba(255,180,58,0.12)" : "transparent",
                    color: myCoursesView === t.id ? "var(--accent-text)" : "var(--text-tertiary)",
                  }}
                >
                  <t.icon size={16} /> {t.label}
                </button>
              ))}
            </div>

            {myCoursesView === "calendrier" ? renderMyCoursesCalendar() : (<>
            <div style={{ ...styles.myCoursesSectionTitle, color: MY_TAKEN_COLOR }}>
              <Car size={13} /> Courses prises ({myTakenRides.length})
            </div>
            {myTakenRides.length === 0 ? (
              <p style={{ color: "var(--text-faint)", fontSize: 13, marginBottom: 26 }}>
                Aucune course prise pour l'instant — les courses que tu prends à d'autres chauffeurs apparaîtront ici.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 26 }}>
                {myTakenRides.map((r) => renderMyCourseCard(r))}
              </div>
            )}

            <div style={{ ...styles.myCoursesSectionTitle, color: MY_POSTED_COLOR }}>
              <Send size={13} /> Courses données ({myPostedRides.length})
            </div>
            {myPostedRides.length === 0 ? (
              <p style={{ color: "var(--text-faint)", fontSize: 13 }}>
                Aucune course donnée pour l'instant — les courses que tu postes toi-même apparaîtront ici.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {myPostedRides.map((r) => renderMyCourseCard(r))}
              </div>
            )}
            </>)}
          </div>
        </div>
      )}

      {showMessagesPanel && (
        <div style={styles.wizardOverlay}>
          <div style={{ ...styles.fullPageHeader, paddingTop: "calc(env(safe-area-inset-top, 0px) + 16px)" }}>
            <span style={{ width: 38 }} />
            <h2 style={{ ...styles.fullPageTitle, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <MessageCircle size={18} /> Messages
              {totalUnreadMessages > 0 && (
                <span style={{ ...styles.navBadge, position: "static", fontSize: 11, height: 18, minWidth: 18, borderRadius: 9 }}>
                  {totalUnreadMessages > 9 ? "9+" : totalUnreadMessages}
                </span>
              )}
            </h2>
            <button onClick={() => setShowMessagesPanel(false)} style={styles.wizardNavBtn} aria-label="Fermer">
              <X size={20} />
            </button>
          </div>
          <div style={{ ...styles.wizardBody, padding: "8px 0 calc(env(safe-area-inset-bottom, 0px) + 20px)" }}>
            {conversations.length === 0 ? (
              <div style={{ textAlign: "center", padding: "56px 32px", color: "var(--text-muted)" }}>
                <div style={styles.chatEmptyIcon}><MessageCircle size={26} /></div>
                <div style={{ fontWeight: 800, fontSize: 16, color: "var(--text-primary)", marginBottom: 6 }}>Aucune conversation</div>
                <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>
                  Elles apparaissent ici dès qu'une course que tu as postée ou prise a un message.
                </div>
              </div>
            ) : (
              conversations.map((c) => {
                const unread = c.unread > 0;
                return (
                  <button
                    key={c.rideId}
                    onClick={() => { setChatRideId(c.rideId); setShowMessagesPanel(false); }}
                    style={styles.chatListRow}
                  >
                    <div style={styles.chatAvatar}>{chatInitials(c.otherParty)}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                        <span style={{ flex: 1, minWidth: 0, fontWeight: 800, fontSize: 15, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {c.otherParty || "?"}
                        </span>
                        <span className="rp-meter" style={{ fontSize: 11.5, flexShrink: 0, color: unread ? "var(--accent-text)" : "var(--text-faint)", fontWeight: unread ? 800 : 600 }}>
                          {chatListTime(c.last.createdAt)}
                        </span>
                      </div>
                      {c.ride && (
                        <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-muted)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden" }}>
                          <MapPin size={11} style={{ flexShrink: 0 }} />
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{c.ride.depart} → {c.ride.arrivee}</span>
                        </div>
                      )}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                        <span style={{
                          flex: 1, minWidth: 0, fontSize: 13.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                          color: unread ? "var(--text-primary)" : "var(--text-muted)", fontWeight: unread ? 700 : 500,
                        }}>
                          {c.last.senderName === driverName ? "Toi : " : ""}{c.last.text}
                        </span>
                        {unread && (
                          <span style={{ ...styles.navBadge, position: "static", flexShrink: 0, background: "#FFB43A", color: "#1A1206", border: "none", height: 20, minWidth: 20, borderRadius: 10, fontSize: 11 }}>
                            {c.unread > 9 ? "9+" : c.unread}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}

      {chatRideId && (() => {
        const chatRide = rides.find((r) => r.id === chatRideId);
        const otherParty = chatRide
          ? (chatRide.postedBy === driverName ? chatRide.takenBy || chatRide.pendingBy : chatRide.postedBy)
          : null;
        const otherPhone = otherParty ? profiles[otherParty]?.phone : null;
        const canSend = chatInput.trim().length > 0;
        return (
        <div style={{
          ...styles.wizardOverlay,
          // Calé sur la zone visible : le clavier ne recouvre plus la saisie.
          ...(chatViewport ? { bottom: "auto", top: chatViewport.top, height: chatViewport.height } : {}),
        }}>
          <div style={styles.chatHeader}>
            <button onClick={() => setChatRideId(null)} style={styles.chatHeaderBtn} aria-label="Retour">
              <ChevronLeft size={24} />
            </button>
            <div style={{ ...styles.chatAvatar, width: 40, height: 40, fontSize: 14 }}>{chatInitials(otherParty)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 16, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {otherParty || "Discussion"}
              </div>
              {chatRide && (
                <div style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {chatRide.date ? `${formatRideDate(chatRide.date)}${chatRide.heure ? ` · ${chatRide.heure}` : ""} · ` : ""}
                  {chatRide.depart} → {chatRide.arrivee}
                </div>
              )}
            </div>
            {otherPhone && (
              <a href={`tel:${otherPhone.replace(/\s/g, "")}`} style={{ ...styles.chatHeaderBtn, color: "#3BD07A", background: "rgba(59,208,122,0.12)" }} aria-label={`Appeler ${otherParty}`}>
                <Phone size={19} />
              </a>
            )}
          </div>

          <div ref={chatScrollRef} style={styles.chatScroll}>
            {chatMessages.length === 0 && (
              <div style={{ margin: "auto", textAlign: "center", padding: "0 24px", color: "var(--text-muted)" }}>
                <div style={styles.chatEmptyIcon}><MessageCircle size={26} /></div>
                <div style={{ fontWeight: 800, fontSize: 15, color: "var(--text-primary)", marginBottom: 4 }}>Démarre la discussion</div>
                <div style={{ fontSize: 13 }}>Écris un message ou choisis une réponse rapide ci-dessous.</div>
              </div>
            )}
            {chatMessages.map((m, i) => {
              const isMe = m.senderName === driverName;
              const prev = chatMessages[i - 1];
              const next = chatMessages[i + 1];
              const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
              const joinPrev = !newDay && prev.senderName === m.senderName && m.createdAt - prev.createdAt < CHAT_GROUP_GAP_MS;
              const joinNext = next && next.senderName === m.senderName && next.createdAt - m.createdAt < CHAT_GROUP_GAP_MS
                && new Date(next.createdAt).toDateString() === new Date(m.createdAt).toDateString();
              const r = 18, tight = 5;
              const radius = isMe
                ? `${r}px ${joinPrev ? tight : r}px ${joinNext ? tight : r}px ${r}px`
                : `${joinPrev ? tight : r}px ${r}px ${r}px ${joinNext ? tight : r}px`;
              return (
                <React.Fragment key={m.id}>
                  {newDay && (
                    <div style={styles.chatDaySep}><span style={styles.chatDayPill}>{chatDayLabel(m.createdAt)}</span></div>
                  )}
                  <div style={{
                    alignSelf: isMe ? "flex-end" : "flex-start",
                    maxWidth: "80%",
                    marginTop: joinPrev ? 2 : 10,
                    background: isMe ? "#FFB43A" : "var(--surface-tile)",
                    color: isMe ? "#1A1206" : "var(--text-primary)",
                    padding: "9px 13px 6px",
                    borderRadius: radius,
                    fontSize: 15,
                    fontWeight: 500,
                    lineHeight: 1.4,
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}>
                    {m.text}
                    <span style={{ display: "block", textAlign: "right", fontSize: 10.5, marginTop: 2, opacity: isMe ? 0.6 : 0.55, fontWeight: 600 }}>
                      {chatTime(m.createdAt)}
                    </span>
                  </div>
                </React.Fragment>
              );
            })}
          </div>

          <div style={styles.chatComposer}>
            <div style={styles.chatQuickRow}>
              {CHAT_QUICK_REPLIES.map((q) => (
                <button key={q} onClick={() => handleSendMessage(q)} style={styles.chatQuickChip}>{q}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", padding: "0 12px" }}>
              <textarea
                ref={chatInputRef}
                rows={1}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } }}
                placeholder="Écrire un message…"
                style={styles.chatInput}
              />
              <button
                onClick={() => handleSendMessage()}
                disabled={!canSend}
                aria-label="Envoyer"
                style={{
                  ...styles.chatSendBtn,
                  background: canSend ? "#FFB43A" : "var(--surface-tile)",
                  color: canSend ? "#1A1206" : "var(--text-faint)",
                  cursor: canSend ? "pointer" : "default",
                }}
              >
                <Send size={18} />
              </button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}
