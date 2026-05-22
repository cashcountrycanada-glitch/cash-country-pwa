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

// ── Stems audio (FLAC / WAV / MP4) stockés dans public/media/ via Git LFS ──
// Route: GET /api/media/:filename
// Ces fichiers sont trackés par Git LFS et déployés automatiquement sur Railway.
const MEDIA_DIR = path.join(ROOT, 'public', 'media');
const AUDIO_MIME = {
  '.flac': 'audio/flac',
  '.wav':  'audio/wav',
  '.mp3':  'audio/mpeg',
  '.mp4':  'audio/mp4',
  '.m4a':  'audio/mp4',
  '.aac':  'audio/aac',
  '.ogg':  'audio/ogg',
  '.webm': 'audio/webm',
};
app.get('/api/media/:filename', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  // Sécurité : interdire les chemins relatifs
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(MEDIA_DIR, filename);
  if (!fs.existsSync(filePath)) {
    console.warn(`[MEDIA] ❌ Fichier introuvable: ${filePath}`);
    return res.status(404).json({ error: 'File not found', filename });
  }
  const ext = path.extname(filename).toLowerCase();
  const mime = AUDIO_MIME[ext] || 'application/octet-stream';
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    // Support Range requests pour iOS (seekable audio)
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end   = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = (end - start) + 1;
    const stream = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': chunkSize,
      'Content-Type':   mime,
      'Cache-Control':  'public, max-age=3600',
    });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type':   mime,
      'Accept-Ranges':  'bytes',
      'Cache-Control':  'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// Diagnostic — liste les médias disponibles
app.get('/api/media', (req, res) => {
  const exists = fs.existsSync(MEDIA_DIR);
  const files  = exists ? fs.readdirSync(MEDIA_DIR) : [];
  res.json({ mediaDir: MEDIA_DIR, exists, count: files.length, files });
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
