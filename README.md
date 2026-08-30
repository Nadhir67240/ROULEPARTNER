# RoulePartner

Appli de partage de courses taxi / transport médical entre chauffeurs, avec
géolocalisation et priorité au chauffeur le plus proche.

Ce guide t'emmène de zéro jusqu'à une icône fonctionnelle sur ton téléphone.
Compte environ 30-40 min la première fois, tout est gratuit pour ce volume
d'usage.

---

## Étape 1 — Créer la base de données (Firebase)

1. Va sur https://console.firebase.google.com et connecte-toi avec un compte
   Google.
2. Clique **Ajouter un projet**, donne-lui un nom (ex: `roulepartner`), et
   laisse Google Analytics désactivé (pas utile ici).
3. Une fois le projet créé, dans le menu de gauche : **Créer une base de
   données** → choisis **Firestore Database**.
   - Démarre en **mode production** (les règles de sécurité, on les ajuste
     à l'étape 3).
   - Choisis une région proche (ex: `eur3 (europe-west)`).
4. Toujours dans la console, clique l'icône **⚙️ Paramètres du projet**, puis
   descends jusqu'à **Vos applications** → clique l'icône **Web `</>`**.
   - Donne un surnom à l'appli (ex: `roulepartner-web`), pas besoin
     d'hébergement Firebase.
   - Firebase t'affiche un bloc de config avec des valeurs comme
     `apiKey`, `projectId`, etc.

5. Ouvre le fichier `src/firebase.js` de ce projet et remplace les
   `"REPLACE_ME"` par tes vraies valeurs.

## Étape 2 — Sécuriser l'accès (règles Firestore)

Dans la console Firebase → Firestore Database → onglet **Règles**, remplace
le contenu par :

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rides/{rideId} {
      allow read, write: if true;
    }
    match /positions/{driverId} {
      allow read, write: if true;
    }
  }
}
```

⚠️ Ces règles sont ouvertes (n'importe qui avec le lien peut lire/écrire) —
suffisant pour démarrer entre chauffeurs de confiance. Si tu veux la
verrouiller plus tard (mot de passe, comptes), dis-le-moi, on ajoutera
l'authentification Firebase.

Clique **Publier**.

## Étape 3 — Installer les dépendances et tester en local

Il te faut Node.js installé (https://nodejs.org, version LTS). Ensuite,
dans un terminal, à l'intérieur du dossier du projet :

```bash
npm install
npm run dev
```

Ça ouvre l'appli sur `http://localhost:5173`. Teste qu'elle fonctionne
(pose une course, partage ta position) avant de déployer.

## Étape 4 — Mettre en ligne (Vercel)

1. Va sur https://vercel.com et crée un compte gratuit (tu peux te connecter
   avec GitHub, Google...).
2. Le plus simple sans passer par GitHub : installe la CLI Vercel puis
   déploie directement depuis le dossier :

```bash
npm install -g vercel
npm run build
vercel --prod
```

3. Réponds aux quelques questions (nom du projet, dossier `dist` détecté
   automatiquement). Vercel te donne une adresse du style
   `https://roulepartner.vercel.app`.

(Alternative sans ligne de commande : va sur https://app.netlify.com/drop et
glisse-dépose le dossier `dist/` généré par `npm run build` — tu obtiens un
lien tout de suite.)

## Étape 5 — Ajouter l'icône sur ton téléphone

**Android (Chrome)**
1. Ouvre le lien de ton appli dans Chrome.
2. Menu ⋮ en haut à droite → **Ajouter à l'écran d'accueil**.

**iPhone (Safari)**
1. Ouvre le lien dans Safari (pas Chrome — sur iPhone ça ne marche que dans
   Safari).
2. Bouton de partage (le carré avec la flèche) → **Sur l'écran d'accueil**.

Tu as maintenant une icône RoulePartner qui s'ouvre en plein écran comme une
vraie appli.

## Étape 6 — Partager avec les autres chauffeurs

Envoie-leur simplement le lien Vercel/Netlify par SMS ou WhatsApp — ils font
la même manip "Ajouter à l'écran d'accueil" chacun de leur côté. Tout le
monde voit le même tableau de courses en temps réel.

---

## Pour aller plus loin

- **Nom de domaine perso** (ex: `roulepartner.fr`) : Vercel/Netlify permettent
  d'en brancher un si tu en achètes un (~10€/an chez OVH, Gandi...).
- **Notifications push** quand une course urgente proche apparaît :
  possible avec Firebase Cloud Messaging, mais demande un peu plus de
  configuration — dis-moi si tu veux qu'on l'ajoute.
- **Comptes/mot de passe** pour verrouiller l'accès aux seuls chauffeurs
  autorisés : Firebase Authentication s'ajoute assez simplement.
