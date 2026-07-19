import { readCloudWallet, syncWallet } from './_lib/sync-wallet.js';
import { validAddress } from './_lib/injective.js';

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 750_000) throw new Error('Payload troppo grande');
  }
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    res.end();
    return;
  }

  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.VERCEL_OIDC_TOKEN) {
      return send(res, 503, { ok: false, error: 'Archivio Vercel Blob non configurato' });
    }

    if (req.method === 'GET') {
      const address = String(req.query?.address || '').trim().toLowerCase();
      if (!validAddress(address)) return send(res, 400, { ok: false, error: 'Indirizzo Injective non valido' });
      const force = String(req.query?.sync || '') === '1';
      let data = await readCloudWallet(address);
      if (force || !data || Date.now() - Number(data.lastChainSync || 0) > 45_000) {
        data = await syncWallet(address, { force: true });
      }
      return send(res, 200, { ok: true, data });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const address = String(body?.address || '').trim().toLowerCase();
      if (!validAddress(address)) return send(res, 400, { ok: false, error: 'Indirizzo Injective non valido' });
      const localRewardHistory = Array.isArray(body?.rewardHistory) ? body.rewardHistory.slice(0, 5000) : [];
      const localGrowth = Array.isArray(body?.stakingGrowth) ? body.stakingGrowth.slice(-10000) : [];
      const data = await syncWallet(address, {
        localRewardHistory,
        localGrowth,
        force: true,
      });
      return send(res, 200, { ok: true, data });
    }

    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return send(res, 405, { ok: false, error: 'Metodo non consentito' });
  } catch (error) {
    console.error('cloud sync', error);
    return send(res, 500, { ok: false, error: error?.message || 'Errore cloud' });
  }
}
