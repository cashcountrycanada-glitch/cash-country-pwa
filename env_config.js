// CONFIGURATION SÉCURISÉE DU KERNEL S6 - Emmanuel & Bernard
window.process = window.process || { env: {} };

// ─── GEMINI API KEYS ────────────────────────────────────────────────────────
// Ajouter / retirer des clés ici librement.
// Le système les utilise toutes automatiquement en rotation.
// Laisser key: '' pour désactiver une entrée sans la supprimer.

window.GEMINI_KEYS = {
  1:  { key: "AIzaSyBQ4B9wAFa5wJthnqoO__eY_mGLIeIsxWI", label: "Clé 1" },
  2:  { key: "AIzaSyAeOnTFxAw11l6IZQADzMfe2ZGApj0EVMs", label: "Clé 2" },
  3:  { key: "AIzaSyCf2HaXoTyVVxU5rDa1iOVCyrT9NDklClw", label: "Clé 3" },
  4:  { key: "AIzaSyAsRKoSbAqJCJvJnvAwg77QCnjtTGKcc5g", label: "Clé 4" },
  5:  { key: "AIzaSyBY5RmhOR7qJ4dBGs24GVMUNjU1N41uGPg", label: "Clé 5" },
  6:  { key: "AIzaSyAIHxZbJ_rPfo_KrKqfy00CQ9yFW5NEA-Y", label: "Clé 6" },
  7:  { key: "AIzaSyAyiV6zkL_1uolKHsoMQ6AYTh60kqeABg0", label: "Clé 7" },
8:  { key: "AIzaSyAUSyW0XabQ030ji-_BdbUJrA3E2ElMcAk", label: "Clé 8" },
9:  { key: "AIzaSyD_YeE3x400sLRwYQ7hBgOWx-OspRbnjMo", label: "Clé 9" },
10:  { key: "AIzaSyCuxVgymLaCF8oQ4NFC5IMg1rEo4kYKy1E", label: "Clé 10" },
11:  { key: "AIzaSyD044gHZeocjuhR3HCAOzdaa9TRiZ7yn4w", label: "Clé 11" },
12:  { key: "AIzaSyCeKz6TOKuzZlp5gxQiRBrYllyt29wHqWc", label: "Clé 12" },
13:  { key: "AIzaSyCwHwdp71F_iwhwyC9gtnCdVzQEa_bkUuI", label: "Clé 13" },
14:  { key: "AIzaSyCnyFFdj9ZLMnu_FwZSC4eITtfV01f7dP0", label: "Clé 14" },
15:  { key: "AIzaSyDgnm9YnZUKmFffptZXtF5sDfptrS3AGjI", label: "Clé 15" },
16:  { key: "AIzaSyDDFyDUZ49VY1Zl626B9IssK5MCbfhjfc8", label: "Clé 16" },
17:  { key: "AIzaSyBVgZ0DDgSSHoW_dkrTDdWUq5A7hFC1aeI", label: "Clé 17" },
18:  { key: "AIzaSyDASmRa1_4E4lRWugcNNS-v4JY4nHgwsA8", label: "Clé 18" },
19:  { key: "AIzaSyCRGa7Enji8rc2iwrufRcHHQmsIt4I48Ms", label: "Clé 19" },
 20: { key: "AIzaSyAA787pFwrlsWlqQ4r5pXJVyvG0-xkXk4g", label: "Clé 20" },
};

// Clé active par défaut — mémorisée dans localStorage entre les sessions
window.GEMINI_ACTIVE_KEY = parseInt(localStorage.getItem('gemini_active_key') || '1');
window.process.env.API_KEY = window.GEMINI_KEYS[window.GEMINI_ACTIVE_KEY]?.key || '';

// Fonction globale appelée par le switcher Topbar et ai.ts
window.switchGeminiKey = function(keyNum) {
  if (!window.GEMINI_KEYS[keyNum]?.key) return;
  window.GEMINI_ACTIVE_KEY = keyNum;
  window.process.env.API_KEY = window.GEMINI_KEYS[keyNum].key;
  localStorage.setItem('gemini_active_key', String(keyNum));
  window.dispatchEvent(new CustomEvent('gemini-key-changed', { detail: { keyNum } }));
};

// ─── OPENROUTER (Qwen3) ─────────────────────────────────────────────────────
window.process.env.OPENROUTER_API_KEY = "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";

// ─── MAC BASE URL ───────────────────────────────────────────────────────────
// URL de base du Mac Cash Country Live pour télécharger les stems.
// Exemple : "https://192.168.1.10:8443"
// Vide = pas de Mac configuré → le bouton vert demande la saisie.
// Peut être surchargé par l'utilisateur via localStorage('cc_mac_url').
window.__CC_MAC_URL = (function() {
  const stored = localStorage.getItem('cc_mac_url');
  if (stored && stored.startsWith('http')) {
    const clean = stored.replace(/\/$/, '');
    // Aussi exposer la version HTTP pour les téléchargements (pas besoin SSL)
    window.__CC_MAC_HTTP_URL = clean.replace('https://', 'http://').replace(':8443', ':8080');
    return clean;
  }
  return '';
})();

// ─── LOG ────────────────────────────────────────────────────────────────────
const _activeKey = window.GEMINI_KEYS[window.GEMINI_ACTIVE_KEY];
const _totalKeys = Object.values(window.GEMINI_KEYS).filter(k => k.key).length;
console.log(
  `%c [S6_CONFIG] ${_totalKeys} clé(s) Gemini — Active: ${_activeKey?.label} `,
  `background: #ef4444; color: #fff; font-weight: bold;`
);
