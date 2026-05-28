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
  const filename = decodeURIComponent(req.params.filename);
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  // GitHub Releases transforme les noms : espaces→points, accents retirés,
  // apostrophes ('' `) → point, virgules → supprimées
  const githubFilename = filename
    .replace(/[''`]/g, '.')
    .replace(/,/g, '')
    .replace(/ /g, '.')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/œ/gi, 'oe')
    .replace(/æ/gi, 'ae');
  const githubUrl = `${GITHUB_STEMS_BASE}/${encodeURIComponent(githubFilename)}`;
  console.log(`[MEDIA] proxy: "${filename}" → "${githubFilename}"`);

  // PROXY au lieu de redirect — iOS bloque les redirects 302 cross-origin sur <audio>
  const https = require('https');
  https.get(githubUrl, (githubRes) => {
    // GitHub redirige vers release-assets.githubusercontent.com — suivre la redirection
    if (githubRes.statusCode === 302 && githubRes.headers.location) {
      https.get(githubRes.headers.location, (assetRes) => {
        const mime = filename.toLowerCase().endsWith('.flac') ? 'audio/flac'
          : filename.toLowerCase().endsWith('.wav') ? 'audio/wav'
          : 'audio/mpeg';
        res.setHeader('Content-Type', mime);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        if (assetRes.headers['content-length']) {
          res.setHeader('Content-Length', assetRes.headers['content-length']);
        }
        res.status(200);
        assetRes.pipe(res);
        assetRes.on('error', () => res.end());
      }).on('error', (e) => {
        console.error('[MEDIA] asset error:', e.message);
        res.status(502).json({ error: 'Asset fetch failed' });
      });
    } else if (githubRes.statusCode === 404) {
      console.warn(`[MEDIA] 404: ${githubFilename}`);
      res.status(404).json({ error: 'File not found', filename: githubFilename });
    } else {
      res.status(githubRes.statusCode || 500).json({ error: 'Unexpected response' });
    }
  }).on('error', (e) => {
    console.error('[MEDIA] github error:', e.message);
    res.status(502).json({ error: 'GitHub fetch failed' });
  });
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

// ── Upload enregistrement → GitHub Releases ─────────────────────────────────
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'cashcountrycanada-glitch';
const GITHUB_REPO  = process.env.GITHUB_REPO  || 'cash-country-pwa';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const REC_TAG      = 'recordings-v1';

// Récupérer ou créer le release recordings-v1
async function getOrCreateRecordingsRelease() {
  const https = require('https');
  const apiBase = `api.github.com`;

  const getRelease = () => new Promise((resolve, reject) => {
    const opts = {
      hostname: apiBase,
      path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/${REC_TAG}`,
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent': 'CashCountryPWA',
        'Accept': 'application/vnd.github.v3+json',
      }
    };
    https.get(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    }).on('error', reject);
  });

  const createRelease = () => new Promise((resolve, reject) => {
    const body = JSON.stringify({
      tag_name: REC_TAG,
      name: 'Enregistrements vocaux',
      body: 'Prises vocales Cash Country Studio Mobile',
      draft: false, prerelease: false
    });
    const opts = {
      hostname: apiBase,
      path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`,
      method: 'POST',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent': 'CashCountryPWA',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  const release = await getRelease();
  if (release && release.id) return release;
  return createRelease();
}

// POST /api/recordings/upload — reçoit un blob audio et l'upload sur GitHub Releases
app.post('/api/recordings/upload', (req, res) => {
  if (!GITHUB_TOKEN) {
    return res.status(503).json({ error: 'GITHUB_TOKEN non configuré sur Railway' });
  }

  const recId    = req.headers['x-recording-id']   || `rec_${Date.now()}`;
  const songTitle = req.headers['x-song-title']     || 'unknown';
  const takeSlot = req.headers['x-take-slot']       || 'A';
  const contentType = req.headers['content-type']   || 'audio/mp4';
  const ext = contentType.includes('wav') ? 'wav' : contentType.includes('mpeg') ? 'mp3' : 'm4a';
  const safeTitle = songTitle.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
  const fileName = `${safeTitle}_slot${takeSlot}_${recId}.${ext}`;

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    const audioBuffer = Buffer.concat(chunks);
    if (audioBuffer.length < 1000) {
      return res.status(400).json({ error: 'Fichier audio vide' });
    }

    try {
      const https = require('https');
      const release = await getOrCreateRecordingsRelease();
      if (!release || !release.upload_url) {
        return res.status(500).json({ error: 'Impossible de créer le release GitHub' });
      }

      // Extraire l'URL d'upload (format: https://uploads.github.com/...{?name,label})
      const uploadUrl = release.upload_url.replace('{?name,label}', '') +
        `?name=${encodeURIComponent(fileName)}`;
      const uploadHost = new URL(uploadUrl);

      await new Promise((resolve, reject) => {
        const opts = {
          hostname: uploadHost.hostname,
          path: uploadHost.pathname + uploadHost.search,
          method: 'POST',
          headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'User-Agent': 'CashCountryPWA',
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': contentType,
            'Content-Length': audioBuffer.length,
          }
        };
        const req2 = https.request(opts, res2 => {
          let data = '';
          res2.on('data', d => data += d);
          res2.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (result.browser_download_url) {
                console.log(`[REC] ✅ Uploadé: ${fileName} → ${result.browser_download_url}`);
                resolve(result);
              } else {
                reject(new Error(data.slice(0, 200)));
              }
            } catch { reject(new Error(data.slice(0, 200))); }
          });
        });
        req2.on('error', reject);
        req2.write(audioBuffer);
        req2.end();
      }).then(result => {
        res.json({ ok: true, url: (result as any).browser_download_url, fileName });
      }).catch(e => {
        res.status(500).json({ error: e.message });
      });

    } catch (e: any) {
      console.error('[REC] Upload error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });
});

// GET /api/recordings/list — liste les enregistrements sur GitHub Releases
app.get('/api/recordings/list', async (req, res) => {
  if (!GITHUB_TOKEN) return res.json({ recordings: [] });
  try {
    const https = require('https');
    const release = await getOrCreateRecordingsRelease();
    const assets = release?.assets || [];
    res.json({ recordings: assets.map((a: any) => ({
      id: a.name, url: a.browser_download_url,
      size: a.size, createdAt: a.created_at
    }))});
  } catch { res.json({ recordings: [] }); }
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
