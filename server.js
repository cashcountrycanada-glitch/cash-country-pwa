const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// CORS pour accès depuis l'iPhone
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Libs locales React/Babel avec cache long
app.use('/libs', (req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  next();
}, express.static(path.join(ROOT, 'public/libs')));

// Fichiers statiques (sw-studio.js, manifest.json, recorder-worklet.js, env_config.js)
app.use(express.static(ROOT, {
  index: false, // on gère / manuellement
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('sw-studio.js')) {
      // Service worker : pas de cache pour qu'il se mette à jour
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Service-Worker-Allowed', '/');
    }
  }
}));

// Route principale → index-pwa.html
app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'index-pwa.html'));
});

// API songs — retourne le songs.json local (snapshot)
app.get('/api/songs', (req, res) => {
  const songsPath = path.join(ROOT, 'cashcountry-data/json/songs.json');
  if (fs.existsSync(songsPath)) {
    try {
      const songs = JSON.parse(fs.readFileSync(songsPath, 'utf8'));
      res.json(songs);
    } catch (e) {
      res.json([]);
    }
  } else {
    res.json([]);
  }
});

// API local-ip — retourne null (pas de Mac connecté)
// La PWA l'utilise juste pour savoir si le Mac est dispo
app.get('/api/local-ip', (req, res) => {
  res.json({
    ip: null,
    port: null,
    url: null,
    httpsUrl: null,
    studioUrl: null
  });
});

// HEAD /api/songs — ping pour tester la connexion
app.head('/api/songs', (req, res) => {
  res.sendStatus(200);
});

// Toute autre route → index-pwa.html (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT, 'index-pwa.html'));
});

app.listen(PORT, () => {
  console.log(`Cash Country Studio Mobile — serveur démarré sur port ${PORT}`);
});
