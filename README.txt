INJECTIVE TERMINAL v7.5.0 — CLOUD HISTORY

Questa release rende persistenti e sincronizzati per indirizzo:
- Storico Reward on-chain.
- Crescita staking con tutti i nuovi punti di stake, compound e unstake.
- Recupero degli eventi avvenuti mentre la pagina è chiusa.
- Sincronizzazione automatica tra dispositivi.

PUBBLICAZIONE OBBLIGATORIA TRAMITE VERCEL COLLEGATO A GITHUB
GitHub Pages da solo non può eseguire API, archivio cloud o cron a pagina chiusa.

1. Carica l'intera cartella nel repository GitHub, inclusi api, package.json e vercel.json.
2. Collega il repository al progetto Vercel.
3. In Vercel crea Storage > Blob > Private e collegalo a Production.
4. Aggiungi CRON_SECRET nelle Environment Variables.
5. Esegui un nuovo deploy Production.
6. Apri /api/health e verifica blobConfigured: true.
7. Apri la dashboard e premi Sincronizza cloud una volta per ogni wallet già esistente.

Il cron configurato in vercel.json controlla gli indirizzi ogni minuto.
