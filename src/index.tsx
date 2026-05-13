import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import StudioMobile from './components/StudioMobile';

// Sur Railway, App.tsx et AudienceMode n'existent pas - on détecte le mode ICI
// pour ne jamais importer App (qui causait MODULE_OFFLINE sur Railway).
const _rh = window.location.hash.replace('#','').trim();
const _rp = new URLSearchParams(window.location.search);
const _isStudio   = _rh === 'studio'   || _rp.get('mode') === 'studio';
const _isAudience = _rh === 'audience' || _rp.get('mode') === 'audience';

// Wrapper qui charge les songs depuis /api/songs pour StudioMobile
function StudioMobileWithSongs() {
  const [songs, setSongs] = useState<any[]>([]);
  useEffect(() => {
    fetch('/api/songs').then(r => r.ok ? r.json() : []).then(s => {
      if (Array.isArray(s)) setSongs(s);
    }).catch(() => {});
  }, []);
  return <StudioMobile songs={songs} />;
}

const rootElement = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);

  root.render(
    <React.StrictMode>
      <StudioMobileWithSongs />
    </React.StrictMode>
  );
}