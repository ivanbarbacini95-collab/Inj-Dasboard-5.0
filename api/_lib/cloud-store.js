import { get, list, put } from '@vercel/blob';

const ACCESS = 'private';
const PREFIX = 'wallets/';

export function walletPath(address) {
  return `${PREFIX}${String(address || '').trim().toLowerCase()}.json`;
}

export function emptyWallet(address) {
  const now = Date.now();
  return {
    version: 1,
    address: String(address || '').trim().toLowerCase(),
    createdAt: now,
    updatedAt: now,
    lastChainSync: 0,
    lastProcessedHeight: 0,
    snapshot: null,
    rewardHistory: [],
    stakingGrowth: [],
  };
}

export async function readWallet(address) {
  const pathname = walletPath(address);
  const result = await get(pathname, { access: ACCESS });
  if (!result?.stream) return { data: null, etag: null };
  const data = await new Response(result.stream).json();
  return { data, etag: result.blob?.etag || null };
}

export async function writeWallet(address, data, etag = null) {
  const options = {
    access: ACCESS,
    allowOverwrite: true,
    contentType: 'application/json; charset=utf-8',
    cacheControlMaxAge: 60,
  };
  if (etag) options.ifMatch = etag;
  return put(walletPath(address), JSON.stringify(data), options);
}

export async function listWalletAddresses() {
  const addresses = [];
  let cursor;
  do {
    const page = await list({ prefix: PREFIX, limit: 1000, cursor });
    for (const blob of page.blobs || []) {
      const match = blob.pathname.match(/^wallets\/(inj1[0-9a-z]+)\.json$/i);
      if (match) addresses.push(match[1].toLowerCase());
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return [...new Set(addresses)];
}
