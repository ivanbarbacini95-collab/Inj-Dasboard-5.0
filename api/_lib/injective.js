const INJ_DECIMALS = 1e18;
const ENDPOINTS = [
  'https://sentry.lcd.injective.network:443',
  'https://lcd.injective.network',
  'https://1rpc.io/inj-lcd',
];

export function validAddress(value) {
  return /^inj1[0-9a-z]{38,60}$/i.test(String(value || '').trim());
}

function n(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function fromWei(value) {
  return n(value) / INJ_DECIMALS;
}

async function fetchJson(url, timeout = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function lcd(path) {
  let lastError;
  for (const base of ENDPOINTS) {
    try {
      return await fetchJson(`${base}${path}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Injective LCD non disponibile');
}

function coinAmount(coins = [], denom = 'inj') {
  const coin = coins.find((item) => item?.denom === denom);
  return coin ? fromWei(coin.amount) : 0;
}

function delegatedAmount(data) {
  return (data?.delegation_responses || []).reduce(
    (sum, row) => sum + fromWei(row?.balance?.amount),
    0,
  );
}

function rewardAmount(data) {
  return (data?.total || [])
    .filter((coin) => coin?.denom === 'inj')
    .reduce((sum, coin) => sum + fromWei(coin.amount), 0);
}

export async function fetchWalletSnapshot(address) {
  const [bank, delegations, rewards] = await Promise.all([
    lcd(`/cosmos/bank/v1beta1/balances/${address}`),
    lcd(`/cosmos/staking/v1beta1/delegations/${address}`),
    lcd(`/cosmos/distribution/v1beta1/delegators/${address}/rewards`),
  ]);
  return {
    t: Date.now(),
    available: coinAmount(bank?.balances || []),
    staked: delegatedAmount(delegations),
    rewards: rewardAmount(rewards),
  };
}

function attributes(event) {
  const out = {};
  for (const attribute of event?.attributes || []) {
    const key = String(attribute?.key || '');
    if (key) out[key] = String(attribute?.value || '');
  }
  return out;
}

function injFromCoinString(value) {
  const matches = [...String(value || '').matchAll(/([0-9]+(?:\.[0-9]+)?)inj\b/g)];
  return matches.reduce((sum, match) => sum + fromWei(match[1]), 0);
}

function messages(tx) {
  return tx?.body?.messages || [];
}

function messageType(message) {
  return String(message?.['@type'] || message?.type_url || '');
}

function isWithdrawal(message, address) {
  return messageType(message).endsWith('MsgWithdrawDelegatorReward')
    && (!address || message?.delegator_address === address);
}

export function parseRewardWithdrawals(tx, response, address) {
  const withdrawalMessages = messages(tx).filter((message) => isWithdrawal(message, address));
  if (!withdrawalMessages.length || Number(response?.code || 0) !== 0) return [];

  const logEvents = (response?.logs || []).flatMap((log) => log?.events || []);
  const events = [...(response?.events || []), ...logEvents];
  const rewardEvents = events.filter((event) => String(event?.type || '') === 'withdraw_rewards');
  const timestamp = response?.timestamp || new Date().toISOString();
  const hash = String(response?.txhash || '');

  if (rewardEvents.length) {
    return rewardEvents.map((event, index) => {
      const attrs = attributes(event);
      return {
        id: `${hash}:reward:${index}`,
        hash,
        timestamp,
        t: Date.parse(timestamp) || Date.now(),
        amount: injFromCoinString(attrs.amount),
        validator: attrs.validator || withdrawalMessages[index]?.validator_address || '',
        height: String(response?.height || ''),
      };
    }).filter((row) => row.amount > 0);
  }

  const received = events
    .filter((event) => event?.type === 'coin_received')
    .map(attributes)
    .filter((attrs) => attrs.receiver === address)
    .reduce((sum, attrs) => sum + injFromCoinString(attrs.amount), 0);

  return received > 0 ? [{
    id: `${hash}:reward:0`,
    hash,
    timestamp,
    t: Date.parse(timestamp) || Date.now(),
    amount: received,
    validator: withdrawalMessages.length === 1 ? withdrawalMessages[0]?.validator_address || '' : '',
    height: String(response?.height || ''),
  }] : [];
}

function messageCoin(message) {
  return fromWei(message?.amount?.amount || message?.balance?.amount || 0);
}

export function parseStakingChanges(tx, response, address) {
  if (Number(response?.code || 0) !== 0) return [];
  const hash = String(response?.txhash || '');
  const timestamp = response?.timestamp || new Date().toISOString();
  const t = Date.parse(timestamp) || Date.now();
  const height = String(response?.height || '');
  const rows = [];

  messages(tx).forEach((message, index) => {
    const type = messageType(message);
    let delta = 0;
    let kind = '';

    if (type.endsWith('MsgDelegate') && message?.delegator_address === address) {
      delta = messageCoin(message);
      kind = 'stake';
    } else if (type.endsWith('MsgUndelegate') && message?.delegator_address === address) {
      delta = -messageCoin(message);
      kind = 'unstake';
    } else if (type.endsWith('MsgCancelUnbondingDelegation') && message?.delegator_address === address) {
      delta = messageCoin(message);
      kind = 'restake';
    }

    if (kind && Math.abs(delta) > 1e-12) {
      rows.push({
        id: `${hash}:staking:${index}`,
        hash,
        timestamp,
        t,
        height,
        delta,
        kind,
        validator: message?.validator_address || message?.validator_src_address || '',
      });
    }
  });

  return rows;
}

export async function fetchSenderTransactions(address, {
  afterHeight = 0,
  maxPages = 10,
  pageSize = 100,
} = {}) {
  const rows = [];
  let highestHeight = Number(afterHeight) || 0;
  let reachedOldHeight = false;

  for (let page = 0; page < maxPages && !reachedOldHeight; page += 1) {
    const offset = page * pageSize;
    const senderEvent = encodeURIComponent(`message.sender='${address}'`);
    const path = `/cosmos/tx/v1beta1/txs?events=${senderEvent}&pagination.limit=${pageSize}&pagination.offset=${offset}&pagination.count_total=true&order_by=ORDER_BY_DESC`;
    const data = await lcd(path);
    const txs = data?.txs || [];
    const responses = data?.tx_responses || [];
    if (!txs.length) break;

    for (let index = 0; index < txs.length; index += 1) {
      const response = responses[index] || {};
      const height = Number(response?.height || 0);
      highestHeight = Math.max(highestHeight, height);
      if (afterHeight && height <= afterHeight) {
        reachedOldHeight = true;
        continue;
      }
      rows.push({ tx: txs[index], response, height });
    }

    if (txs.length < pageSize) break;
  }

  rows.sort((a, b) => a.height - b.height || (Date.parse(a.response?.timestamp || '') - Date.parse(b.response?.timestamp || '')));
  return { rows, highestHeight };
}
