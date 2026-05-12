#!/usr/bin/env node
/**
 * build.js — Assembleur PWA Cash Country Studio Mobile
 * 
 * Lit chaque module source .ts/.tsx depuis src/
 * Les injecte dans index-pwa.html via JSON.stringify (échappement parfait)
 * Génère index-pwa.html final prêt pour Railway
 * 
 * Usage: node build.js
 */

const fs   = require('fs');
const path = require('path');

const SRC_DIR      = path.join(__dirname, 'src');
const TEMPLATE     = path.join(__dirname, 'index-pwa.template.html');
const OUTPUT       = path.join(__dirname, 'index-pwa.html');
const SW_SRC       = path.join(__dirname, 'sw-studio.js');

// Ordre des modules (important — les imports doivent être résolus dans l'ordre)
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

function build() {
  console.log('🔨 Build PWA Cash Country Studio Mobile');
  console.log('─'.repeat(50));

  // 1. Lire le template HTML
  if (!fs.existsSync(TEMPLATE)) {
    console.error('❌ index-pwa.template.html introuvable');
    process.exit(1);
  }
  let html = fs.readFileSync(TEMPLATE, 'utf8');

  // 2. Construire le bloc __INLINE_MODULES__
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
    // JSON.stringify gère TOUT l'échappement correctement
    const escaped = JSON.stringify(source);
    entries.push(`  ${JSON.stringify(modKey)}: ${escaped}`);
    console.log(`  ✅ ${modKey} (${(source.length/1024).toFixed(1)} Ko)`);
  }

  const modulesBlock = `window.__INLINE_MODULES__ = {\n${entries.join(',\n')}\n};`;

  // 3. Remplacer le placeholder dans le template
  const PLACEHOLDER = '/* %%INLINE_MODULES%% */';
  if (!html.includes(PLACEHOLDER)) {
    console.error(`❌ Placeholder "${PLACEHOLDER}" introuvable dans le template`);
    process.exit(1);
  }
  html = html.replace(PLACEHOLDER, modulesBlock);

  // 4. Bump version SW dans le HTML (timestamp pour forcer rechargement)
  const ts = Date.now();
  html = html.replace(/BUILD_TIMESTAMP/g, ts.toString());

  // 5. Écrire le résultat
  fs.writeFileSync(OUTPUT, html, 'utf8');

  console.log('─'.repeat(50));
  if (errors > 0) {
    console.log(`⚠️  Build terminé avec ${errors} module(s) manquant(s)`);
  } else {
    console.log(`✅ index-pwa.html généré (${(fs.statSync(OUTPUT).size/1024).toFixed(0)} Ko)`);
  }
  console.log(`📦 Prêt pour Railway: git add . && git commit -m "build" && git push`);
}

build();
