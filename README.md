# Injective Terminal v7.5.0 — Cloud History

Questa versione rende persistenti e condivisi tra dispositivi:

- **Storico Reward**: prelievi reward letti direttamente dalla blockchain.
- **Crescita staking**: un punto per ogni nuova variazione di staking rilevata on-chain, inclusi compound, nuovi stake e unstake.
- **Sincronizzazione per indirizzo**: tutti i dispositivi che aprono lo stesso indirizzo ricevono gli stessi punti.
- **Aggiornamento a pagina chiusa**: un Vercel Cron Job interroga la blockchain ogni minuto.

## Pubblicazione corretta

GitHub ospita il codice, mentre **Vercel deve effettuare il deploy** perché GitHub Pages da solo non può eseguire API, database o processi a pagina chiusa.

1. Carica l'intera cartella nel repository GitHub, inclusi `api`, `package.json` e `vercel.json`.
2. In Vercel importa o ricollega quel repository.
3. Nel progetto Vercel apri **Storage → Create Database → Blob**.
4. Crea un archivio **Private** e collegalo a Production. Vercel aggiungerà `BLOB_READ_WRITE_TOKEN`.
5. In **Settings → Environment Variables** aggiungi `CRON_SECRET` con una stringa casuale lunga.
6. Esegui un nuovo deploy in Production.
7. Controlla `/api/health`: deve restituire `blobConfigured: true`.
8. Apri un wallet nella dashboard e premi **Sincronizza cloud** una volta. I dati locali già presenti verranno migrati.

## Come funziona

- Al primo accesso il browser invia al server i punti locali già esistenti.
- Il server fonde i punti senza duplicati e li salva in Vercel Blob in `wallets/<indirizzo>.json`.
- Il Cron Job `/api/cron-sync` continua a controllare gli indirizzi registrati anche quando nessun browser è aperto.
- Quando la dashboard viene aperta su un altro dispositivo, scarica e fonde automaticamente gli stessi dati cloud.
- In assenza del backend Vercel la dashboard continua a funzionare in modalità locale, ma non può registrare eventi mentre è chiusa.

## Frequenza

Il file `vercel.json` usa `* * * * *`, quindi un controllo ogni minuto. È adatto al piano Vercel Pro. Per ridurre le operazioni Blob puoi cambiarlo in `*/5 * * * *`.
