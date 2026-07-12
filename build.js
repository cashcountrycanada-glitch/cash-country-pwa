#!/usr/bin/env node
/**
 * build.js — Assembleur PWA Cash Country Studio Mobile
 *
 * À chaque build :
 *   - Incrémente version.json (build++)
 *   - Bump BUILD_VERSION dans StudioMobile.tsx  (ex: v7.6.1)
 *   - Bump CACHE name dans sw-studio.js         (ex: studio-v95)
 *   - Injecte tous les modules dans index-pwa.html
 *
 * Usage: node build.js
 */

const fs   = require('fs');
const path = require('path');

const SRC_DIR      = path.join(__dirname, 'src');
const TEMPLATE     = path.join(__dirname, 'index-pwa.template.html');
const OUTPUT       = path.join(__dirname, 'index-pwa.html');
const VERSION_FILE = path.join(__dirname, 'version.json');
const SW_FILE      = path.join(__dirname, 'sw-studio.js');
const STUDIO_FILE  = path.join(__dirname, 'src/components/StudioMobile.tsx');

// ── 1. Lire et incrémenter la version ────────────────────────────────────────
let ver = { app: '7.6.0', sw: 94, build: 0 };
if (fs.existsSync(VERSION_FILE)) {
  try { ver = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')); } catch {}
}
ver.build = (ver.build || 0) + 1;

// Incrémenter le patch de app (ex: 7.6.0 → 7.6.1)
const parts = ver.app.split('.').map(Number);
parts[2] = (parts[2] || 0) + 1;
ver.app = parts.join('.');

// Incrémenter le numéro SW
ver.sw = (ver.sw || 94) + 1;

fs.writeFileSync(VERSION_FILE, JSON.stringify(ver, null, 2), 'utf8');

const APP_VERSION = `v${ver.app}`;
const SW_VERSION  = ver.sw;
const CACHE_NAME  = `studio-v${SW_VERSION}`;

console.log('🔨 Build PWA Cash Country Studio Mobile');
console.log(`   App  : ${APP_VERSION}  |  SW cache : ${CACHE_NAME}  |  Build #${ver.build}`);
console.log('─'.repeat(50));

// ── 2. Bump BUILD_VERSION dans StudioMobile.tsx ──────────────────────────────
if (fs.existsSync(STUDIO_FILE)) {
  let studio = fs.readFileSync(STUDIO_FILE, 'utf8');
  studio = studio.replace(
    /const BUILD_VERSION\s*=\s*'[^']*'/,
    `const BUILD_VERSION = '${APP_VERSION}'`
  );
  fs.writeFileSync(STUDIO_FILE, studio, 'utf8');
  console.log(`  🏷  StudioMobile.tsx → BUILD_VERSION = '${APP_VERSION}'`);
}

// ── 3. Bump CACHE dans sw-studio.js ──────────────────────────────────────────
if (fs.existsSync(SW_FILE)) {
  let sw = fs.readFileSync(SW_FILE, 'utf8');
  sw = sw.replace(
    /const CACHE\s*=\s*'studio-v\d+[^']*'/,
    `const CACHE = '${CACHE_NAME}'`
  );
  fs.writeFileSync(SW_FILE, sw, 'utf8');
  console.log(`  🏷  sw-studio.js     → CACHE = '${CACHE_NAME}'`);
}

// ── 4. Lire le template HTML ──────────────────────────────────────────────────
if (!fs.existsSync(TEMPLATE)) {
  console.error('❌ index-pwa.template.html introuvable');
  process.exit(1);
}
let html = fs.readFileSync(TEMPLATE, 'utf8');

// ── 5. Ordre des modules ──────────────────────────────────────────────────────
const MODULE_ORDER = [
  'index.tsx',
  'types.ts',
  'services/StudioOfflineDB.ts',
  'services/StudioService.ts',
  'components/StudioMobile.tsx',
  'components/StudioMobile/studio.types.ts',
  'components/StudioMobile/useStudioAudio.ts',
  'components/StudioMobile/useStudioOffline.ts',
  'components/StudioMobile/useStudioRecorder.ts',
  'components/StudioMobile/RecordScreen.tsx',
  'components/StudioMobile/VUMeter.tsx',
  'components/StudioMobile/MixerScreen.tsx',
  'components/StudioMobile/TrackCard.tsx',
  'components/StudioMobile/WaveformBar.tsx',
  'components/StudioMobile/RecordingsList.tsx',
  'components/StudioMobile/RecordingCard.tsx',
  'components/StudioMobile/CompEditor.tsx',
  'components/StudioMobile/MasteringEngine.tsx',
  'components/StudioMobile/SongSelector.tsx',
];

// ── 6. Construire le bloc __INLINE_MODULES__ ──────────────────────────────────
const entries = [];
let errors = 0;

for (const modKey of MODULE_ORDER) {
  const srcPath = path.join(SRC_DIR, modKey);
  if (!fs.existsSync(srcPath)) {
    console.warn(`  ⚠️  Manquant: ${modKey}`);
    errors++;
    continue;
  }
  const source = fs.readFileSync(srcPath, 'utf8');
  const escaped = JSON.stringify(source).replace(
    /\\u([dD][89aAbB][0-9a-fA-F]{2})\\u([dD][c-fC-F][0-9a-fA-F]{2})/g,
    (_, high, low) => String.fromCodePoint(
      ((parseInt(high, 16) - 0xD800) << 10) + (parseInt(low, 16) - 0xDC00) + 0x10000
    )
  );
  entries.push(`  ${JSON.stringify(modKey)}: ${escaped}`);
  console.log(`  ✅ ${modKey} (${(source.length/1024).toFixed(1)} Ko)`);
}

const modulesBlock = `window.__INLINE_MODULES__ = {\n${entries.join(',\n')}\n};`;

// ── 7. Remplacer les placeholders ─────────────────────────────────────────────
const PLACEHOLDER = '/* %%INLINE_MODULES%% */';
if (!html.includes(PLACEHOLDER)) {
  console.error(`❌ Placeholder "${PLACEHOLDER}" introuvable dans le template`);
  process.exit(1);
}
html = html.replace(PLACEHOLDER, modulesBlock);
html = html.replace(/BUILD_TIMESTAMP/g, Date.now().toString());

// ── 8. Écrire le résultat ────────────────────────────────────────────────────
fs.writeFileSync(OUTPUT, html, 'utf8');

console.log('─'.repeat(50));
if (errors > 0) {
  console.log(`⚠️  Build terminé avec ${errors} module(s) manquant(s)`);
} else {
  console.log(`✅ index-pwa.html généré (${(fs.statSync(OUTPUT).size/1024).toFixed(0)} Ko)`);
}
console.log(`📦 Prêt: git add -A && git commit -m "${APP_VERSION} build#${ver.build}" && git push`);
