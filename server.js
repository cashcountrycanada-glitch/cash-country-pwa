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

// ── Libs locales — routes EXPLICITES (évite le wildcard SPA) ─────────────────
// Servi avec bon Content-Type JS garanti — plus fiable qu'express.static
const LIBS = {
  'babel.min.js':          'application/javascript',
  'react.esm.js':          'application/javascript',
  'react-dom.esm.js':      'application/javascript',
  'react-dom-client.esm.js': 'application/javascript',
  'lucide-react.esm.js':   'application/javascript',
  'scheduler.esm.js':      'application/javascript',
};

Object.entries(LIBS).forEach(([filename, mime]) => {
  app.get(`/libs/${filename}`, (req, res) => {
    const filePath = path.join(ROOT, 'public', 'libs', filename);
    if (!fs.existsSync(filePath)) {
      console.error(`[LIBS] ❌ Fichier manquant: ${filePath}`);
      return res.status(404).json({ error: `${filename} not found`, path: filePath });
    }
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Served-By', 'explicit-route');
    res.sendFile(filePath);
  });
});

// Diagnostic — liste les libs disponibles
app.get('/libs/', (req, res) => {
  const libsDir = path.join(ROOT, 'public', 'libs');
  const exists = fs.existsSync(libsDir);
  const files = exists ? fs.readdirSync(libsDir) : [];
  res.json({ libsDir, exists, files });
});

// Fichiers statiques (sw-studio.js, manifest.json, recorder-worklet.js, env_config.js)
app.use(express.static(ROOT, {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('sw-studio.js')) {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Service-Worker-Allowed', '/');
    }
  }
}));

// Route principale → index-pwa.html
app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'index-pwa.html'));
});

// API songs
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

// ── Stems audio — redirige vers GitHub Releases ─────────────────────────────
// Les FLAC/WAV sont stockés comme assets dans une GitHub Release (tag: stems-v1).
// Railway ne stocke rien — il redirige simplement vers l'URL GitHub publique.
// Pour ajouter/mettre à jour des stems : GitHub → Releases → stems-v1 → Edit → upload
const GITHUB_STEMS_BASE = process.env.GITHUB_STEMS_URL ||
  'https://github.com/cashcountrycanada-glitch/cash-country-pwa/releases/download/stems-v1';

app.get('/api/media/:filename', (req, res) => {
  // Décoder d'abord (les espaces arrivent comme %20)
  const filename = decodeURIComponent(req.params.filename);
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  // GitHub Releases transforme les noms de fichiers :
  //   1. Espaces → points
  //   2. Accents retirés (œ→oe, é→e, è→e, à→a, etc.)
  const githubFilename = filename
    .replace(/ /g, '.')
    .normalize('NFD')                    // décompose les accents (é → e + ´)
    .replace(/[\u0300-\u036f]/g, '')    // supprime les diacritiques
    .replace(/œ/gi, 'oe')               // œ non couvert par NFD
    .replace(/æ/gi, 'ae');              // æ non couvert par NFD
  const url = `${GITHUB_STEMS_BASE}/${encodeURIComponent(githubFilename)}`;
  console.log(`[MEDIA] → redirect: "${filename}" → "${githubFilename}"`);
  res.redirect(302, url);
});

// Diagnostic
app.get('/api/media', (req, res) => {
  res.json({ mode: 'github-releases', base: GITHUB_STEMS_BASE });
});

// API local-ip
app.get('/api/local-ip', (req, res) => {
  res.json({ ip: null, port: null, url: null, httpsUrl: null, studioUrl: null });
});

// HEAD /api/songs — ping
app.head('/api/songs', (req, res) => {
  res.sendStatus(200);
});

// Toute autre route → index-pwa.html (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT, 'index-pwa.html'));
});

app.listen(PORT, () => {
  // Diagnostic au démarrage — vérifie que les libs sont bien là
  const libsDir = path.join(ROOT, 'public', 'libs');
  const libsExist = fs.existsSync(libsDir);
  const libFiles = libsExist ? fs.readdirSync(libsDir) : [];
  console.log(`Cash Country Studio Mobile — port ${PORT}`);
  console.log(`[LIBS] Dossier: ${libsDir}`);
  console.log(`[LIBS] Fichiers: ${libsExist ? libFiles.join(', ') : '❌ DOSSIER MANQUANT'}`);
  if (!libsExist || !libFiles.includes('babel.min.js')) {
    console.error('[LIBS] ❌ CRITIQUE: babel.min.js absent — la PWA ne fonctionnera pas');
    console.error('[LIBS] Vérifier que public/libs/ est commité dans le repo GitHub');
  }
});
