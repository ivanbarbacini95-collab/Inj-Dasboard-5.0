import { emptyWallet, readWallet, writeWallet } from './cloud-store.js';
import {
  fetchSenderTransactions,
  fetchWalletSnapshot,
  parseRewardWithdrawals,
  parseStakingChanges,
} from './injective.js';

const MAX_REWARDS = 5000;
const MAX_GROWTH = 10000;

function n(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeReward(row) {
  const timestamp = row?.timestamp || new Date(n(row?.t) || Date.now()).toISOString();
  const hash = String(row?.hash || '');
  const validator = String(row?.validator || '');
  const amount = n(row?.amount);
  const id = String(row?.id || (hash ? `${hash}:${validator || amount}` : `${timestamp}:${amount}:${validator}`));
  return {
    id,
    hash,
    timestamp,
    t: Date.parse(timestamp) || n(row?.t) || Date.now(),
    amount,
    validator,
    height: String(row?.height || ''),
  };
}

function mergeRewards(...groups) {
  const unique = new Map();
  groups.flat().map(normalizeReward).filter((row) => row.amount > 0 && row.t > 0).forEach((row) => {
    const key = row.id || `${row.hash}:${row.validator || row.amount}`;
    const previous = unique.get(key);
    if (!previous || row.amount > previous.amount) unique.set(key, row);
  });
  return [...unique.values()].sort((a, b) => b.t - a.t).slice(0, MAX_REWARDS);
}

function normalizeGrowth(row) {
  const t = n(row?.t) || Date.parse(row?.timestamp || '') || Date.now();
  const staked = n(row?.staked);
  const delta = n(row?.delta ?? row?.amount);
  const type = String(row?.type || row?.kind || 'stake');
  const hash = String(row?.hash || '');
  const id = String(row?.id || (hash ? `${hash}:${type}:${t}` : `${t}:${staked}:${type}`));
  return {
    id,
    t,
    timestamp: row?.timestamp || new Date(t).toISOString(),
    staked,
    delta,
    amount: n(row?.amount || Math.abs(delta)),
    type,
    hash,
    height: String(row?.height || ''),
    source: String(row?.source || 'cloud'),
  };
}

function mergeGrowth(...groups) {
  const unique = new Map();
  groups.flat().map(normalizeGrowth).filter((row) => row.t > 0 && Number.isFinite(row.staked)).forEach((row) => {
    const key = row.id || `${row.t}:${row.staked}:${row.type}`;
    unique.set(key, row);
  });
  const ordered = [...unique.values()].sort((a, b) => a.t - b.t);
  const collapsed = [];
  for (const row of ordered) {
    const index = collapsed.findIndex((previous) =>
      Math.abs(previous.t - row.t) <= 5 * 60 * 1000
      && Math.abs(previous.staked - row.staked) <= 0.000001
    );
    if (index < 0) {
      collapsed.push(row);
      continue;
    }
    const previous = collapsed[index];
    const rowPriority = row.source === 'chain' || row.hash ? 2 : row.source === 'cloud' ? 1 : 0;
    const previousPriority = previous.source === 'chain' || previous.hash ? 2 : previous.source === 'cloud' ? 1 : 0;
    if (rowPriority >= previousPriority) collapsed[index] = row;
  }
  return collapsed.sort((a, b) => a.t - b.t).slice(-MAX_GROWTH);
}

function classifyStakeChange(change, rewards, usedRewardIds) {
  if (change.delta <= 0) return change.kind === 'unstake' ? 'unstake' : change.kind;
  const candidate = rewards
    .filter((reward) => !usedRewardIds.has(reward.id) && reward.t <= change.t && change.t - reward.t <= 90 * 60 * 1000)
    .sort((a, b) => Math.abs(a.amount - change.delta) - Math.abs(b.amount - change.delta))[0];
  if (!candidate) return change.kind === 'restake' ? 'restake' : 'stake';
  const tolerance = Math.max(0.005, candidate.amount * 0.4);
  if (Math.abs(candidate.amount - change.delta) <= tolerance) {
    usedRewardIds.add(candidate.id);
    return 'compound';
  }
  return change.kind === 'restake' ? 'restake' : 'stake';
}

function applyStakingChanges(data, changes, newRewards, currentSnapshot) {
  let growth = mergeGrowth(data.stakingGrowth || []);
  const seen = new Set(growth.map((row) => row.id));

  if (!growth.length) {
    growth.push(normalizeGrowth({
      id: `baseline:${data.createdAt}`,
      t: data.createdAt,
      staked: n(data.snapshot?.staked ?? currentSnapshot.staked),
      delta: 0,
      type: 'baseline',
      source: 'cloud',
    }));
  }

  let runningStaked = n(data.snapshot?.staked);
  if (!data.snapshot) runningStaked = n(growth.at(-1)?.staked ?? currentSnapshot.staked);
  const usedRewardIds = new Set();

  for (const change of changes) {
    if (seen.has(change.id)) continue;
    runningStaked = Math.max(0, runningStaked + n(change.delta));
    const type = classifyStakeChange(change, newRewards, usedRewardIds);
    const point = normalizeGrowth({
      ...change,
      staked: runningStaked,
      type,
      amount: Math.abs(change.delta),
      source: 'chain',
    });
    growth.push(point);
    seen.add(point.id);
  }

  const mismatch = n(currentSnapshot.staked) - runningStaked;
  if (Math.abs(mismatch) > 0.000001) {
    const last = growth.at(-1);
    const duplicate = last && Math.abs(n(last.staked) - n(currentSnapshot.staked)) <= 0.000001;
    if (!duplicate) {
      growth.push(normalizeGrowth({
        id: `reconcile:${currentSnapshot.t}:${currentSnapshot.staked}`,
        t: currentSnapshot.t,
        staked: currentSnapshot.staked,
        delta: mismatch,
        type: mismatch > 0 ? 'stake' : 'unstake',
        amount: Math.abs(mismatch),
        source: 'snapshot',
      }));
    }
  }

  return mergeGrowth(growth);
}

function isConflict(error) {
  return error?.name === 'BlobPreconditionFailedError'
    || String(error?.message || '').toLowerCase().includes('precondition');
}

export async function syncWallet(address, {
  localRewardHistory = [],
  localGrowth = [],
  force = false,
} = {}) {
  const snapshot = await fetchWalletSnapshot(address);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { data: stored, etag } = await readWallet(address);
    const data = stored || emptyWallet(address);
    data.rewardHistory = mergeRewards(data.rewardHistory || [], localRewardHistory || []);
    data.stakingGrowth = mergeGrowth(data.stakingGrowth || [], localGrowth || []);

    const stale = Date.now() - n(data.lastChainSync) > 30_000;
    if (!force && !stale && stored) return data;

    const initialWithoutGrowth = !data.stakingGrowth.length;
    const afterHeight = n(data.lastProcessedHeight);
    const txBatch = await fetchSenderTransactions(address, {
      afterHeight,
      maxPages: afterHeight ? 5 : 10,
      pageSize: 100,
    });

    const rewardRows = [];
    const stakingChanges = [];
    for (const row of txBatch.rows) {
      rewardRows.push(...parseRewardWithdrawals(row.tx, row.response, address));
      stakingChanges.push(...parseStakingChanges(row.tx, row.response, address));
    }

    data.rewardHistory = mergeRewards(data.rewardHistory, rewardRows);

    let applicableChanges = stakingChanges;
    if (!afterHeight) {
      const lastLocalTime = n(data.stakingGrowth.at(-1)?.t);
      applicableChanges = lastLocalTime
        ? stakingChanges.filter((row) => row.t > lastLocalTime)
        : [];
    }

    if (initialWithoutGrowth) {
      data.createdAt = Math.min(n(data.createdAt) || snapshot.t, snapshot.t);
      data.snapshot = snapshot;
      data.stakingGrowth = mergeGrowth([{
        id: `baseline:${snapshot.t}`,
        t: snapshot.t,
        staked: snapshot.staked,
        delta: 0,
        type: 'baseline',
        source: 'cloud',
      }]);
    } else {
      data.stakingGrowth = applyStakingChanges(data, applicableChanges, rewardRows, snapshot);
      data.snapshot = snapshot;
    }

    data.lastProcessedHeight = Math.max(afterHeight, n(txBatch.highestHeight));
    data.lastChainSync = Date.now();
    data.updatedAt = Date.now();
    data.version = 1;

    try {
      await writeWallet(address, data, etag);
      return data;
    } catch (error) {
      if (!isConflict(error) || attempt === 3) throw error;
    }
  }

  throw new Error('Sincronizzazione cloud non riuscita');
}

export async function readCloudWallet(address) {
  const { data } = await readWallet(address);
  return data;
}
