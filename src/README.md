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
