import { listWalletAddresses } from './_lib/cloud-store.js';
import { syncWallet } from './_lib/sync-wallet.js';

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return send(res, 401, { ok: false, error: 'Unauthorized' });
  }

  try {
    const addresses = (await listWalletAddresses()).slice(0, 50);
    const results = [];

    for (const address of addresses) {
      try {
        const data = await syncWallet(address, { force: true });
        results.push({ address, ok: true, updatedAt: data.updatedAt });
      } catch (error) {
        console.error('cron wallet', address, error);
        results.push({ address, ok: false, error: error?.message || 'Errore' });
      }
    }

    return send(res, 200, {
      ok: true,
      checked: addresses.length,
      succeeded: results.filter((row) => row.ok).length,
      failed: results.filter((row) => !row.ok).length,
      results,
    });
  } catch (error) {
    console.error('cron sync', error);
    return send(res, 500, { ok: false, error: error?.message || 'Errore cron' });
  }
}
