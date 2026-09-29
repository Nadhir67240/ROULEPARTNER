# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

RoulePartner is a French-language PWA for taxi / VSL (medical transport) drivers to share
rides with each other in real time, with geolocation-based priority dispatch. Backend is
entirely Firebase (Firestore + Auth + Cloud Functions + Cloud Messaging); frontend is a
single-page React app deployed as a static build (Vercel/Netlify, per README.md).

## Commands

```bash
npm install
npm run dev       # Vite dev server, http://localhost:5173
npm run build     # production build to dist/
npm run preview   # serve the production build locally
```

There is no test suite and no linter configured in this repo.

Cloud Functions live under `functions/` as a separate npm package (its own
`node_modules`/`package-lock.json`, no build/test scripts). Deploy with the Firebase CLI:

```bash
firebase deploy --only functions
```

Frontend deploy (per README.md) is `npm run build` followed by `vercel --prod`, or a manual
drag-and-drop of `dist/` to Netlify. `dist/` is checked in as a build artifact in this repo
snapshot — regenerate it with `npm run build` rather than hand-editing.

## Architecture

**Monolithic single-component frontend.** Nearly all app logic — auth screens, the ride
board, filters, the ride form and taxi-fare calculator, the driver map, chat, account/admin
panels — lives in one `App()` function in `src/App.jsx` (~3,700 lines, one big set of
`useState` hooks, no router, no component splitting, no context). When making a change,
search `App.jsx` for the relevant state/handler rather than expecting a dedicated file per
feature.

**`src/firebase.js`** is the only module that talks to Firebase and is the single source of
truth for backend calls (Firestore reads/writes, Auth, FCM token registration). It exports
plain async functions (`addRide`, `claimRide`, `listenRides`, `signUp`, `sendMessage`, etc.)
that `App.jsx` calls directly — there is no separate data layer/store.

**Firestore collections** (all accessed via `src/firebase.js`): `rides`, `positions`
(live driver GPS, keyed by driver name), `profiles` (keyed by driver display name),
`messages` (per-ride chat), `licenses` (taxi license numbers reserved as doc IDs to enforce
uniqueness at signup), `fcmTokens`. Driver **display name**, not UID, is used as the primary
key/identity across collections (profiles, positions, chat participants, ban/delete logic).

Firestore security rules live in `firestore.rules` (referenced by `firebase.json`) and are
deployed from the repo with `firebase deploy --only firestore:rules` — the live ruleset was
verified identical to the repo file on 2026-09-29. `scripts/test-regles.mjs` tests the ride
rules against the emulators (`firebase emulators:start --config firebase.sim.json --only
auth,firestore --project demo-roulepartner`). Rule changes must stay in sync with the ride
writes in `src/firebase.js` / `src/App.jsx` (e.g. `pendingAt` server timestamp on claims).

**Priority dispatch logic is duplicated** between the client and the Cloud Function and must
stay in sync manually:
- `src/App.jsx`: `PRIORITY_WINDOW_MS`, `PRIORITY_TIE_KM`, `PRIORITY_MAX_DRIVERS`,
  `computePriorityDrivers()` — used for the in-app "priority" UI/sound alert.
- `functions/index.js`: `PRIORITY_WINDOW_MS`, `PRIORITY_RADIUS_KM`, `PRIORITY_MAX_DRIVERS`,
  `computePriorityDrivers()` — used for push notifications (`notifyNewRide`), which fires on
  ride creation, waits out the priority window server-side, then re-checks the ride is still
  `disponible` before opening the notification to everyone else.

The admin user is identified by a hardcoded `ADMIN_EMAIL` constant duplicated in
`src/App.jsx`, `functions/index.js`, and referenced in a comment in `src/firebase.js`. If it
ever changes, update all three.

**Ride lifecycle** (`status` field): `disponible` → `en_attente` (claim pending confirmation,
via `claimRide`'s Firestore transaction to avoid double-claims) → `en_cours` → `terminee`.
Completed rides older than `AUTO_PURGE_DAYS` are purged client-side (there's no scheduled
server-side job for this — see the comment in `App.jsx` near the purge effect).

**Service worker**: `public/firebase-messaging-sw.js` is the one actually served/deployed
(Vite copies `public/` verbatim; it must live there for FCM to find it at
`/firebase-messaging-sw.js`). The `firebase-messaging-sw.js` at the repo root is a stale,
out-of-date duplicate — don't edit it expecting it to take effect.

**`index.js.js` at the repo root is dead code**, not the Cloud Functions entry point — the
deployed function source is `functions/index.js` (per `firebase.json`'s `"source": "functions"`).
Don't confuse the two; they've diverged (the root file is an older take on the same
notification logic).

**PWA config** (manifest, icons, service-worker registration strategy) lives in
`vite.config.js` via `vite-plugin-pwa`, separate from the FCM service worker above.

**Taxi fare calculator**: `computeTaxiConventionneTarif()` and the `DEPARTMENT_KM_RATES` /
`TAXI_*` constants near the top of `App.jsx` encode French "taxi conventionné" pricing rules
(per-department km rates, night/weekend/TPMR surcharges, empty-return surcharge). These are
domain/regulatory constants, not arbitrary config — treat changes to them as business-logic
changes requiring confirmation, not cleanup.

**Language**: all UI text, most code comments, and several data values (ride status strings,
etc.) are in French. Match this when adding UI copy or comments.
