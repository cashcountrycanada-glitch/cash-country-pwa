# Cash Country Studio Mobile — PWA Server

Serveur minimal pour bootstrapper la PWA iOS quand le Mac est éteint.

## Ce que ce serveur fait
- Sert `index-pwa.html` (l'app complète Studio Mobile)
- Sert les libs React/Babel/Lucide localement
- Retourne `songs.json` via `/api/songs`
- Répond au ping `/api/local-ip` (sans Mac connecté)

## Ce qu'il ne fait PAS
- Pas de médias MP3/MP4 (restent sur le Mac)
- Pas d'upload d'enregistrements (reste sur le Mac)

## Déploiement Railway
1. Push ce repo sur GitHub
2. railway.app → New Project → Deploy from GitHub
3. C'est tout.

---

## ⚠️ Règles d'architecture — À NE JAMAIS CONFONDRE

### Cache SW (Service Worker) = CODE SEULEMENT
- Le cache SW (`sw-studio.js`) met en cache les fichiers de l'app : HTML, JS, CSS, libs
- Il ne touche JAMAIS aux fichiers audio
- `CACHE_NAME = 'studio-vXXX'` → versioning du code app uniquement

### IndexedDB = STEMS AUDIO (stockage permanent)
- Les stems instrumentaux et vocaux sont stockés dans **IndexedDB** via `StudioOfflineDB`
- Clés : `inst_<songId>` et `vocal_<songId>`
- Ce stockage est **permanent** : persiste même Mac fermé, app relancée, PWA mise à jour
- `studioOfflineDB.saveAudio()` / `studioOfflineDB.getAudio()` / `studioOfflineDB.hasAudio()`

### Conséquences pour RecordScreen
- Le bouton **Écouter** doit être actif si `instCached || vocalCached` — PAS seulement si `instUrl || vocalGuideUrl`
- Le bouton **Enregistrer** est toujours actif dès que les stems sont en IndexedDB
- `instCached = true` signifie que le blob est dans IndexedDB et valide (size > 1000 bytes)
- `instUrl` est une blob URL créée depuis IndexedDB — elle peut être null si le blob est corrompu, mais `instCached` reste la source de vérité

### Ordre de vérification dans useStudioAudio
1. Lire blob depuis IndexedDB
2. Vérifier `blob.size >= 1000` (blob valide)
3. Seulement si valide → `URL.createObjectURL()` → setter `instUrl` / `vocalGuideUrl`
4. Seulement si valide → setter `instCached = true` / `vocalCached = true`
- Ne jamais setter l'URL ou `cached = true` avant la vérification de taille

### Import manuel — type MIME
- Garder le type MIME **original** du fichier (`file.type`)
- Ne JAMAIS forcer `audio/mp4` sur un fichier FLAC — le contenu et le type seraient incohérents → décodage qui plante silencieusement
- iOS Safari supporte FLAC, WAV, MP3, M4A nativement — pas besoin de conversion
- Si `file.type` est vide, deviner depuis l'extension du nom de fichier
