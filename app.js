'use strict';

const $ = (id) => document.getElementById(id);
const INJ_DECIMALS = 1e18;
const ENDPOINTS = [
  'https://sentry.lcd.injective.network:443',
  'https://lcd.injective.network',
  'https://1rpc.io/inj-lcd'
];
const state = { wallets:[], walletCache:{}, walletRefreshTimer:null, lastAccountUpdate:0, syncInterval:30000, timeframe:'1h', hover:{}, hoverTimers:{}, chartViews:{}, drag:{}, timeframeLoading:false, timeframeRequest:0, marketCandles:[], address:'', price:0, change:0, low:0, high:0, marketCap:0, marketRank:0, available:0, staked:0, rewards:0, apr:0, networkApr:0, communityTax:0, weightedCommission:0, validators:[], rewardHistory:[], rewardHistoryLoaded:false, rewardHistoryLoading:false, rewardHistoryNextKey:'', rewardHistorySyncedSession:false, rewardHistoryLastSync:0, endpoint:'', priceHistory:[], netWorthHistory:[], socket:null, accountTimer:null };

const HISTORY = { priceKey:'inj_price_history_v4', priceLimit:720, netWorthLimit:720, priceStep:60_000, netWorthStep:300_000 };
let marketUiFrame=0, marketUiTimer=0, lastDashboardPaint=0;

const storage = {
  get(key, fallback='') { try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, String(value)); } catch {} },
  getJSON(key, fallback=[]) { try { const raw=localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } },
  setJSON(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
};

function normalizeHistory(rows){
  if(!Array.isArray(rows)) return [];
  const now=Date.now();
  return rows.map((row,index)=>{
    if(typeof row==='number') return {t:now-(rows.length-index)*60_000,v:number(row)};
    return {t:number(row?.t),v:number(row?.v),synthetic:Boolean(row?.synthetic)};
  }).filter(row=>row.t>0&&Number.isFinite(row.v));
}
function mergeHistory(existing,incoming,limit){
  const map=new Map();
  [...normalizeHistory(existing),...normalizeHistory(incoming)].forEach(row=>map.set(Math.floor(row.t/60_000),row));
  return [...map.values()].sort((a,b)=>a.t-b.t).slice(-limit);
}
function sampleHistory(list,value,step,limit){
  const now=Date.now();
  const point={t:now,v:number(value)};
  const last=list.at(-1);
  if(last && now-last.t<step) list[list.length-1]=point; else list.push(point);
  if(list.length>limit) list.splice(0,list.length-limit);
}
function netWorthHistoryKey(address){ return `inj_networth_history_v4_${String(address||'').toLowerCase()}`; }
function savePriceHistory(){ storage.setJSON(HISTORY.priceKey,state.priceHistory); }
function saveNetWorthHistory(){ if(state.address) storage.setJSON(netWorthHistoryKey(state.address),state.netWorthHistory); }
function bootstrapNetWorthHistory(totalInj){
  if(state.netWorthHistory.length>=2 || !totalInj || state.priceHistory.length<2) return;
  const source=state.priceHistory.slice(-96);
  state.netWorthHistory=source.map(row=>({t:row.t,v:number(totalInj)*number(row.v),synthetic:true}));
}
function addRealNetWorthPoint(value){
  const now=Date.now();
  const real=state.netWorthHistory.filter(row=>!row.synthetic);
  sampleHistory(real,value,HISTORY.netWorthStep,HISTORY.netWorthLimit);
  const synthetic=state.netWorthHistory.filter(row=>row.synthetic && row.t < (real[0]?.t||now));
  state.netWorthHistory=[...synthetic,...real].sort((a,b)=>a.t-b.t).slice(-HISTORY.netWorthLimit);
}

function number(value){ const n=Number(value); return Number.isFinite(n)?n:0; }
function fromWei(value){ return number(value)/INJ_DECIMALS; }
function money(value){ return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(number(value)); }
function preciseMoney(value,digits=5){ return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:digits,maximumFractionDigits:digits}).format(number(value)); }
function compactUsd(value){ return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',notation:'compact',maximumFractionDigits:2}).format(number(value)); }
function rate(value){ const n=number(value); return n>1?n/1e18:n; }
function inj(value,digits=6){ return number(value).toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits}); }
function validAddress(value){ return /^inj1[0-9a-z]{38,60}$/i.test(String(value).trim()); }
const ROLLING_IDS=new Set([
  // Solo valori numerici semplici: niente testi composti, countdown o stringhe con più numeri.
  'priceUsd','marketPrice','priceChange','dayLow','dayHigh',
  'netWorthUsd','netWorthInj','portfolioNetWorth','portfolioTotalInj',
  'availableInj','availableUsd','stakedInj','stakedUsd','rewardsInj','rewardsUsd',
  'portfolioApr','portfolioRewards','portfolioRewardsUsd','aprValue','marketCapValue','commissionValue',
  'networkAprValue','portfolioDaily','dailyEstimate','reward1d','reward1w','reward1m','reward1y',
  'withdrawnTotalInj','withdrawnTotalUsd','withdrawalCount','lastWithdrawalInj'
]);
function numericFromText(value){
  const match=String(value).replace(/,/g,'').match(/[-+]?\d+(?:\.\d+)?/);
  return match?Number(match[0]):NaN;
}
function setText(id,value){
  const el=$(id); if(!el) return;
  const next=String(value);
  if(!ROLLING_IDS.has(id)){ el.textContent=next; return; }
  rollValue(id,next,numericFromText(next));
}
function renderStableNumber(el,text){
  el.classList.add('rolling-number');
  el.innerHTML='';
  for(const char of String(text)){
    const span=document.createElement('span');
    span.className=/\d/.test(char)?'roll-char roll-digit':'roll-char roll-symbol';
    span.textContent=char;
    el.appendChild(span);
  }
}
function rollValue(id,formatted,numericValue){
  const el=$(id); if(!el) return;
  const next=String(formatted);
  const previousText=el.dataset.rollText ?? el.textContent ?? '';
  const previousValue=Number(el.dataset.rollValue);
  const nextValue=Number(numericValue);
  if(previousText===next){
    el.dataset.rollText=next;
    if(Number.isFinite(nextValue)) el.dataset.rollValue=String(nextValue);
    return;
  }
  clearTimeout(el._rollTimer);
  el.classList.remove('roll-active');
  if(!previousText || previousText.includes('—') || previousText.length!==next.length || !Number.isFinite(previousValue) || !Number.isFinite(nextValue)){
    renderStableNumber(el,next);
    el.dataset.rollText=next;
    if(Number.isFinite(nextValue)) el.dataset.rollValue=String(nextValue);
    return;
  }
  const direction=nextValue>=previousValue?'up':'down';
  let animated=false;
  el.classList.add('rolling-number');
  el.innerHTML='';
  for(let i=0;i<next.length;i++){
    const oldChar=previousText[i];
    const newChar=next[i];
    const bothDigits=/\d/.test(oldChar) && /\d/.test(newChar);
    const isChangedDigit=bothDigits && oldChar!==newChar;
    if(!isChangedDigit){
      const fixed=document.createElement('span');
      fixed.className=bothDigits?'roll-char roll-digit':'roll-char roll-symbol';
      fixed.textContent=newChar;
      el.appendChild(fixed);
      continue;
    }
    animated=true;
    const slot=document.createElement('span');
    slot.className=`roll-slot roll-digit roll-${direction} roll-color-${direction}`;
    slot.dataset.finalChar=newChar;
    const oldSpan=document.createElement('span'); oldSpan.className='roll-old'; oldSpan.textContent=oldChar;
    const newSpan=document.createElement('span'); newSpan.className='roll-new'; newSpan.textContent=newChar;
    slot.append(oldSpan,newSpan);
    el.appendChild(slot);
  }
  el.dataset.rollText=next;
  el.dataset.rollValue=String(nextValue);
  if(!animated){ renderStableNumber(el,next); return; }
  requestAnimationFrame(()=>requestAnimationFrame(()=>el.classList.add('roll-active')));
  el._rollTimer=setTimeout(()=>{
    el.classList.remove('roll-active');
    for(const slot of el.querySelectorAll('.roll-slot')){
      const stable=document.createElement('span');
      stable.className='roll-char roll-digit';
      stable.textContent=slot.dataset.finalChar || '';
      slot.replaceWith(stable);
    }
  },460);
}
function toast(message){ const el=$('toast'); el.textContent=message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.remove('show'),1800); }
function status(mode,text){ const pill=$('statusPill'); pill.className=`status-pill ${mode}`; setText('statusText',text); }

async function json(url, timeout=9000){
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeout);
  try{ const response=await fetch(url,{cache:'no-store',signal:controller.signal}); if(!response.ok) throw new Error(`HTTP ${response.status}`); return await response.json(); }
  finally{ clearTimeout(timer); }
}
async function lcd(path){
  for(const base of ENDPOINTS){
    try{ const data=await json(base+path); state.endpoint=base; setText('endpointLabel',`API: ${new URL(base).hostname}`); return data; }
    catch(error){ console.warn('LCD fallback',base,error); }
  }
  throw new Error('Nessun endpoint Injective disponibile');
}

function findAmount(coins=[], denom='inj'){ const coin=coins.find(x=>x?.denom===denom); return coin?fromWei(coin.amount):0; }
function delegationRows(data){ return (data?.delegation_responses||[]).map(row=>({ operator:row?.delegation?.validator_address||'', amount:fromWei(row?.balance?.amount) })).filter(row=>row.operator&&row.amount>0); }
function parseDelegations(data){ return delegationRows(data).reduce((sum,row)=>sum+row.amount,0); }
function parseRewards(data){
  const total=data?.total || [];
  return total.filter(x=>x?.denom==='inj').reduce((sum,x)=>sum+fromWei(x.amount),0);
}

async function loadMarket(){
  try{
    const [ticker, coin] = await Promise.all([
      json('https://api.binance.com/api/v3/ticker/24hr?symbol=INJUSDT'),
      json('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=injective-protocol&sparkline=false') .catch(()=>null)
    ]);
    const market=Array.isArray(coin)?coin[0]:null;
    state.marketCap=number(market?.market_cap);
    state.marketRank=number(market?.market_cap_rank);
    updatePrice({ price:number(ticker.lastPrice), change:number(ticker.priceChangePercent), low:number(ticker.lowPrice), high:number(ticker.highPrice) });
    const klines=await json('https://api.binance.com/api/v3/klines?symbol=INJUSDT&interval=5m&limit=96');
    const marketHistory=(klines||[]).map(k=>({t:number(k[0]),v:number(k[4])})).filter(row=>row.t&&row.v);
    state.priceHistory=mergeHistory(state.priceHistory,marketHistory,HISTORY.priceLimit);
    savePriceHistory();
    drawAll();
  }catch(error){ console.warn(error); status('offline','Mercato non disponibile'); }
}

const TIMEFRAMES={
  '1min':{interval:'1s',limit:60,label:'1 MIN'},
  '1h':{interval:'1m',limit:60,label:'1H'},
  '1d':{interval:'5m',limit:288,label:'1D'},
  '1w':{interval:'1h',limit:168,label:'1W'},
  '1mo':{interval:'4h',limit:180,label:'1M'},
  '1y':{interval:'1d',limit:365,label:'1Y'},
  'all':{interval:'1w',limit:1000,label:'ALL'}
};
async function loadMarketTimeframe(tf=state.timeframe){
  const cfg=TIMEFRAMES[tf]||TIMEFRAMES['1h'];
  const requestId=++state.timeframeRequest;
  state.timeframe=tf;
  state.timeframeLoading=true;
  storage.set('inj_timeframe_v4',tf);
  document.querySelectorAll('#timeframeTabs button').forEach(b=>{
    b.classList.toggle('active',b.dataset.tf===tf);
    b.setAttribute('aria-pressed',b.dataset.tf===tf?'true':'false');
  });
  const cached=storage.getJSON(`inj_market_${tf}_v4`,[]);
  if(Array.isArray(cached)&&cached.length){
    state.marketCandles=cached;
    resetChartView('marketChart',state.marketCandles.length,tf);
    renderMarket(); drawAll();
  }
  try{
    const rows=await json(`https://api.binance.com/api/v3/klines?symbol=INJUSDT&interval=${cfg.interval}&limit=${cfg.limit}`);
    if(requestId!==state.timeframeRequest) return;
    state.marketCandles=(rows||[]).map(k=>({t:number(k[0]),o:number(k[1]),h:number(k[2]),l:number(k[3]),c:number(k[4]),v:number(k[5])})).filter(x=>x.t&&x.c);
    storage.setJSON(`inj_market_${tf}_v4`,state.marketCandles);
    resetChartView('marketChart',state.marketCandles.length,tf);
    renderMarket(); drawAll();
  }catch(error){
    if(requestId!==state.timeframeRequest) return;
    if(!state.marketCandles.length) state.marketCandles=cached;
    renderMarket(); drawAll(); toast('Dati timeframe non disponibili');
  }finally{
    if(requestId===state.timeframeRequest){
      state.timeframeLoading=false;
      document.querySelectorAll('#timeframeTabs button').forEach(b=>b.disabled=false);
    }
  }
}
function renderMarketPrice(){
  rollValue('marketPrice',preciseMoney(state.price,4),state.price);
  const change=$('marketChange');
  setText('marketChange',`${state.change>=0?'+':''}${state.change.toFixed(2)}% nelle 24h`);
  if(change) change.className=`inj-live-change ${state.change>0?'up':state.change<0?'down':''}`;
}
function renderMarket(){
  const rows=state.marketCandles||[]; const first=rows[0],last=rows.at(-1);
  renderMarketPrice();
  setText('ohlcOpen',first?preciseMoney(first.o,4):'—'); setText('ohlcHigh',rows.length?preciseMoney(Math.max(...rows.map(x=>x.h)),4):'—');
  setText('ohlcLow',rows.length?preciseMoney(Math.min(...rows.map(x=>x.l)),4):'—'); setText('ohlcClose',last?preciseMoney(last.c,4):'—');
  setText('ohlcVolume',rows.length?`${rows.reduce((a,x)=>a+x.v,0).toLocaleString('en-US',{maximumFractionDigits:0})} INJ`:'—');
}
function scheduleMarketUi(){
  renderMarketPrice();
  if(marketUiFrame||marketUiTimer) return;
  const elapsed=performance.now()-lastDashboardPaint;
  const paint=()=>{
    marketUiTimer=0;
    marketUiFrame=requestAnimationFrame((now)=>{
      marketUiFrame=0;
      lastDashboardPaint=now;
      render();
      renderMarket();
      drawAll();
    });
  };
  if(elapsed>=240) paint();
  else marketUiTimer=setTimeout(paint,240-elapsed);
}
function connectPriceSocket(){
  try{ state.socket?.close(); }catch{}
  try{
    const ws=new WebSocket('wss://stream.binance.com:9443/ws/injusdt@ticker'); state.socket=ws;
    ws.onopen=()=>status('online',state.address?'Online':'Prezzo live');
    ws.onmessage=(event)=>{ try{ const t=JSON.parse(event.data); updatePrice({price:number(t.c),change:number(t.P),low:number(t.l),high:number(t.h)}); }catch{} };
    ws.onerror=()=>status('offline','Connessione prezzo instabile');
    ws.onclose=()=>setTimeout(connectPriceSocket,4000);
  }catch{ setTimeout(connectPriceSocket,5000); }
}
function updateLiveMarketCandle(price){
  const rows=state.marketCandles; if(!rows.length||!price) return;
  const last=rows.at(-1); last.c=price; last.h=Math.max(number(last.h),price); last.l=Math.min(number(last.l)||price,price);
}
function updatePrice(next){ Object.assign(state,next); updateLiveMarketCandle(state.price); sampleHistory(state.priceHistory,state.price,HISTORY.priceStep,HISTORY.priceLimit); savePriceHistory(); scheduleMarketUi(); }

async function loadAccount(showFeedback=true){
  const address=state.address; if(!validAddress(address)){ if(showFeedback) toast('Inserisci un indirizzo Injective valido'); return; }
  status('','Aggiornamento wallet…');
  try{
    const [bank,delegations,rewards,annual,pool,distParams]=await Promise.all([
      lcd(`/cosmos/bank/v1beta1/balances/${address}`),
      lcd(`/cosmos/staking/v1beta1/delegations/${address}`),
      lcd(`/cosmos/distribution/v1beta1/delegators/${address}/rewards`),
      lcd('/cosmos/mint/v1beta1/annual_provisions'),
      lcd('/cosmos/staking/v1beta1/pool'),
      lcd('/cosmos/distribution/v1beta1/params').catch(()=>null)
    ]);
    if(address!==state.address) return;
    const rows=delegationRows(delegations);
    const validatorData=await Promise.all(rows.map(async row=>{
      try{
        const response=await lcd(`/cosmos/staking/v1beta1/validators/${row.operator}`);
        const validator=response?.validator||{};
        const commission=rate(validator?.commission?.commission_rates?.rate);
        return { ...row, moniker:validator?.description?.moniker||shortOperator(row.operator), commission, status:validator?.status||'' };
      }catch{
        return { ...row, moniker:shortOperator(row.operator), commission:0, status:'' };
      }
    }));
    if(address!==state.address) return;

    state.available=findAmount(bank?.balances||[]);
    state.staked=parseDelegations(delegations);
    state.rewards=parseRewards(rewards);
    state.validators=validatorData;
    state.lastAccountUpdate=Date.now();

    const annualBase=number(annual?.annual_provisions);
    const bondedBase=number(pool?.pool?.bonded_tokens);
    state.networkApr=bondedBase>0?(annualBase/bondedBase)*100:0;
    state.communityTax=rate(distParams?.params?.community_tax);
    const totalDelegated=validatorData.reduce((sum,v)=>sum+v.amount,0);
    state.weightedCommission=totalDelegated>0?validatorData.reduce((sum,v)=>sum+(v.amount*v.commission),0)/totalDelegated:0;

    const annualNet=validatorData.reduce((sum,v)=>{
      const validatorApr=(state.networkApr/100)*(1-state.communityTax)*(1-v.commission);
      return sum+(v.amount*validatorApr);
    },0);
    state.apr=state.staked>0?(annualNet/state.staked)*100:0;

    const nw=(state.available+state.staked+state.rewards)*state.price;
    bootstrapNetWorthHistory(state.available+state.staked+state.rewards);
    addRealNetWorthPoint(nw);
    saveNetWorthHistory();
    storage.set('inj_address',address); setText('lastUpdate',`Aggiornato ${new Date().toLocaleTimeString('it-IT')}`);
    state.walletCache[address.toLowerCase()]={total:state.available+state.staked+state.rewards,available:state.available,staked:state.staked,rewards:state.rewards,updated:Date.now(),status:'online'};
    saveWalletCollection(); renderWalletTabs();
    status('online','Online'); render(); drawAll(); if(!state.rewardHistoryLoading&&!state.rewardHistorySyncedSession) loadRewardHistory({showFeedback:false}); if(showFeedback) toast('Wallet aggiornato');
  }catch(error){ console.error(error); status('offline','Errore API Injective'); if(showFeedback) toast('Impossibile aggiornare il wallet'); }
}


function attrMap(event){
  const out={};
  for(const attr of event?.attributes||[]){
    const key=String(attr?.key||'');
    const value=String(attr?.value||'');
    if(key) out[key]=value;
  }
  return out;
}
function injFromCoinString(value){
  const text=String(value||'');
  const matches=[...text.matchAll(/([0-9]+(?:\.[0-9]+)?)inj\b/g)];
  return matches.reduce((sum,m)=>sum+fromWei(m[1]),0);
}
function rewardHistoryStorageKey(address=state.address){
  return `inj_reward_withdrawals_v58_${String(address||'').trim().toLowerCase()}`;
}
function normalizeRewardRow(row){
  const amount=number(row?.amount);
  const timestamp=row?.timestamp||new Date(number(row?.t)||Date.now()).toISOString();
  const hash=String(row?.hash||'');
  const validator=String(row?.validator||'');
  const height=String(row?.height||'');
  const id=String(row?.id||hash||`${timestamp}-${amount}-${validator}`);
  return {id,hash,timestamp,amount,validator,height};
}
function savedRewardHistory(address=state.address){
  return storage.getJSON(rewardHistoryStorageKey(address),[]).map(normalizeRewardRow).filter(row=>row.amount>0&&row.timestamp);
}
function persistRewardHistory(){
  if(!validAddress(state.address)) return;
  storage.setJSON(rewardHistoryStorageKey(),(state.rewardHistory||[]).slice(0,250));
}
function mergeRewardHistory(rows,{persist=true}={}){
  const unique=new Map();
  [...savedRewardHistory(),...(state.rewardHistory||[]),...(rows||[])].map(normalizeRewardRow).filter(row=>row.amount>0&&row.timestamp).forEach(row=>{
    const key=row.hash?`${row.hash}:${row.validator||row.amount}`:row.id;
    const previous=unique.get(key);
    if(!previous||row.amount>previous.amount) unique.set(key,row);
  });
  state.rewardHistory=[...unique.values()].sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp));
  if(persist) persistRewardHistory();
  renderRewardHistory();
}
function addRewardWithdrawal(row){
  const normalized=normalizeRewardRow(row);
  if(!(normalized.amount>0)) return false;
  mergeRewardHistory([normalized]);
  state.rewardHistoryLoaded=true;
  return true;
}
function txMessages(tx){ return tx?.body?.messages||[]; }
function isWithdrawMessage(message,address){
  const type=String(message?.['@type']||message?.type_url||'');
  return type.endsWith('MsgWithdrawDelegatorReward') && (!address || message?.delegator_address===address);
}
function parseWithdrawalTx(tx,response,address){
  const messages=txMessages(tx).filter(m=>isWithdrawMessage(m,address));
  if(!messages.length || Number(response?.code||0)!==0) return [];
  const logEvents=(response?.logs||[]).flatMap(log=>log?.events||[]);
  const events=[...(response?.events||[]),...logEvents];
  const rewardEvents=events.filter(e=>String(e?.type||'')==='withdraw_rewards');
  const timestamp=response?.timestamp||'';
  const hash=response?.txhash||'';
  if(rewardEvents.length){
    return rewardEvents.map((event,index)=>{
      const attrs=attrMap(event);
      return { id:`${hash}-${index}`, hash, timestamp, amount:injFromCoinString(attrs.amount), validator:attrs.validator||messages[index]?.validator_address||'', height:response?.height||'' };
    }).filter(x=>x.amount>0);
  }
  const received=events.filter(e=>e?.type==='coin_received').map(attrMap).filter(a=>a.receiver===address).reduce((sum,a)=>sum+injFromCoinString(a.amount),0);
  if(received<=0) return [];
  return [{ id:hash, hash, timestamp, amount:received, validator:messages.length===1?messages[0]?.validator_address:'', height:response?.height||'' }];
}
function validatorName(operator){
  const found=state.validators.find(v=>v.operator===operator);
  return found?.moniker||shortOperator(operator)||'Validator non disponibile';
}
async function loadRewardHistory({append=false,showFeedback=true}={}){
  if(!validAddress(state.address)){ if(showFeedback) toast('Carica prima un wallet'); return; }
  if(!append&&!state.rewardHistory.length) mergeRewardHistory(savedRewardHistory(),{persist:false});
  if(state.rewardHistoryLoading) return;
  state.rewardHistoryLoading=true; renderRewardHistory();
  try{
    const pageSize=100;
    let offset=append?number(state.rewardHistoryNextKey):0;
    let scanned=0;
    let total=0;
    const parsed=[];
    const maxPages=append?5:10;
    for(let page=0; page<maxPages; page++){
      const senderEvent=encodeURIComponent(`message.sender='${state.address}'`);
      const url=`/cosmos/tx/v1beta1/txs?events=${senderEvent}&pagination.limit=${pageSize}&pagination.offset=${offset}&pagination.count_total=true&order_by=ORDER_BY_DESC`;
      const data=await lcd(url);
      const txs=data?.txs||[];
      const responses=data?.tx_responses||[];
      total=number(data?.pagination?.total)||total;
      for(let i=0;i<txs.length;i++) parsed.push(...parseWithdrawalTx(txs[i],responses[i]||{},state.address));
      scanned+=txs.length;
      offset+=txs.length;
      setText('withdrawalRange',`Analizzate ${offset}${total?` di ${total}`:''} transazioni`);
      renderRewardHistory();
      if(txs.length<pageSize || (total&&offset>=total)) break;
    }
    const combined=append?[...state.rewardHistory,...parsed]:parsed;
    mergeRewardHistory(combined);
    state.rewardHistoryNextKey=(total&&offset<total)?String(offset):'';
    state.rewardHistoryLoaded=true;
    state.rewardHistorySyncedSession=true;
    state.rewardHistoryLastSync=Date.now();
    storage.set(rewardHistoryStorageKey()+':lastSync',String(state.rewardHistoryLastSync));
    renderRewardHistory();
    if(showFeedback) toast(parsed.length?`${parsed.length} prelievi trovati`:`Nessun prelievo in ${scanned} transazioni`);
  }catch(error){
    console.error('Reward history',error); state.rewardHistoryLoaded=true; state.rewardHistorySyncedSession=false; renderRewardHistory('Impossibile leggere lo storico on-chain.'); if(showFeedback) toast('Storico reward non disponibile');
  }finally{ state.rewardHistoryLoading=false; renderRewardHistory(); }
}
function formatDate(value){
  const d=new Date(value); if(Number.isNaN(d.getTime())) return 'Data non disponibile';
  return d.toLocaleString('it-IT',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
}
function renderRewardHistory(error=''){
  const host=$('withdrawalList'); if(!host){ renderRewardWithdrawalChart(); return; }
  const rows=state.rewardHistory||[]; const total=rows.reduce((sum,row)=>sum+row.amount,0);
  setText('withdrawnTotalInj',`${inj(total,6)} INJ`); setText('withdrawnTotalUsd',`${money(total*state.price)} al prezzo attuale`);
  setText('withdrawalCount',String(rows.length)); setText('withdrawalRange',rows.length?'Transazioni on-chain trovate':'Storico on-chain');
  setText('lastWithdrawalInj',rows.length?`${inj(rows[0].amount,6)} INJ`:'—'); setText('lastWithdrawalDate',rows.length?formatDate(rows[0].timestamp):'Nessun prelievo');
  const more=$('loadMoreWithdrawals'); if(more){ more.hidden=!state.rewardHistoryNextKey; more.disabled=state.rewardHistoryLoading; }
  if(state.rewardHistoryLoading&&!rows.length){ host.innerHTML='<div class="loading-line">Ricerca dei prelievi on-chain…</div>'; return; }
  if(error&&!rows.length){ host.innerHTML=`<div class="validator-empty">${escapeHtml(error)}</div>`; return; }
  if(!state.rewardHistoryLoaded){ host.innerHTML='<div class="validator-empty">Apri questa schermata dopo aver caricato il wallet.</div>'; return; }
  if(!rows.length){ host.innerHTML='<div class="validator-empty">Nessun ritiro reward trovato nelle transazioni disponibili.</div>'; renderRewardWithdrawalChart(); return; }
  host.innerHTML=rows.map(row=>{
    const explorer=row.hash?`https://explorer.injective.network/transaction/${encodeURIComponent(row.hash)}`:'';
    return `<div class="withdrawal-row"><div class="withdrawal-main"><strong>${escapeHtml(formatDate(row.timestamp))}</strong><small>${explorer?`<a class="tx-link" href="${explorer}" target="_blank" rel="noopener">Apri transazione ↗</a>`:`Blocco ${escapeHtml(row.height)}`}</small></div><div class="withdrawal-validator"><strong>${escapeHtml(validatorName(row.validator))}</strong><small>${escapeHtml(shortOperator(row.validator)||'Ritiro multiplo')}</small></div><div class="withdrawal-amount private"><strong>+${inj(row.amount,6)} INJ</strong><small>${money(row.amount*state.price)} oggi</small></div></div>`;
  }).join('');
}
function switchView(name){
  document.querySelectorAll('.view-tab').forEach(btn=>btn.classList.toggle('active',btn.dataset.view===name));
  ['dashboard','withdrawals'].forEach(v=>{ const el=$(v+'View'); if(el) el.classList.toggle('active',v===name); });
  if(name==='withdrawals'&&!state.rewardHistoryLoaded&&state.address) loadRewardHistory({showFeedback:false});
  if(name==='market'&&!state.marketCandles.length) loadMarketTimeframe(state.timeframe);
  requestAnimationFrame(drawAll);
}

function shortOperator(value){ const s=String(value||''); return s.length>18?`${s.slice(0,10)}…${s.slice(-6)}`:s; }
function renderValidators(){
  const host=$('validatorList'); if(!host) return;
  const rows=state.validators||[];
  setText('validatorCount',rows.length?`${rows.length} validator${rows.length>1?'s':''}`:'Nessuna delegazione');
  if(!rows.length){ host.innerHTML='<div class="validator-empty">Nessuna delegazione attiva trovata.</div>'; return; }
  host.innerHTML=rows.map(v=>{
    const netApr=(state.networkApr/100)*(1-state.communityTax)*(1-v.commission)*100;
    const daily=v.amount*(netApr/100)/365;
    return `<div class="validator-row"><div class="validator-name"><strong>${escapeHtml(v.moniker)}</strong><small>${escapeHtml(shortOperator(v.operator))}</small></div><div class="validator-stake"><strong>${inj(v.amount,3)} INJ</strong><small>in staking</small></div><div class="validator-badges"><span><small>Commissione</small><b>${(v.commission*100).toFixed(2)}%</b></span><span><small>APR netto</small><b>${netApr.toFixed(2)}%</b></span></div></div>`;
  }).join('');
}
function escapeHtml(value){ return String(value??'').replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch])); }


function historyChange(ms){
  const rows=(state.netWorthHistory||[]).filter(row=>row?.t>0&&number(row?.v)>0).sort((a,b)=>a.t-b.t);
  if(rows.length<2) return null;
  const latest=rows.at(-1);
  const target=latest.t-ms;
  // Non usare lo stesso primo snapshot per timeframe diversi: il dato esiste
  // soltanto quando lo storico copre davvero l'intervallo richiesto.
  if(rows[0].t>target) return null;
  let base=rows[0];
  for(const row of rows){
    if(row.t<=target) base=row;
    else break;
  }
  if(!base?.v || base.t>target) return null;
  return {usd:latest.v-base.v,pct:((latest.v/base.v)-1)*100,baseTime:base.t,latestTime:latest.t};
}
function formatPerformance(change){
  if(!change) return '—'; const sign=change.usd>=0?'+':''; return `${sign}${money(change.usd)} · ${sign}${change.pct.toFixed(2)}%`;
}
function setPerformance(id,change){ const el=$(id); if(!el) return; el.textContent=formatPerformance(change); el.className=change?(change.usd>=0?'up':'down'):''; }
function athKey(){ return `inj_ath_v4_${String(state.address||'guest').toLowerCase()}`; }
function updateAth(nw){
  if(!nw) return; const saved=storage.getJSON(athKey(),{value:0,date:0}); let ath=saved; let isNew=false;
  if(nw>number(saved.value)){ ath={value:nw,date:Date.now()}; storage.setJSON(athKey(),ath); isNew=number(saved.value)>0; }
  setText('athValue',money(ath.value)); setText('athDate',ath.date?new Intl.DateTimeFormat('it-IT',{day:'2-digit',month:'short',year:'numeric'}).format(new Date(ath.date)):'—');
  const badge=$('newAthBadge'); if(badge){ badge.hidden=!isNew; if(isNew) setTimeout(()=>badge.hidden=true,5000); }
}
function renderRewardWithdrawalChart(){
  const barsHost=$('rewardBars'); const axisHost=$('rewardAxis');
  if(!barsHost||!axisHost) return;
  const rows=(state.rewardHistory||[]).filter(row=>number(row?.amount)>0&&row?.timestamp)
    .sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp)).slice(-24);
  const total=rows.reduce((sum,row)=>sum+number(row.amount),0);
  setText('rewardChartTotal',`${inj(total,6)} INJ`);
  setText('rewardChartRange',rows.length?`${rows.length} preliev${rows.length===1?'o':'i'} · ${formatDate(rows[0].timestamp)} — ${formatDate(rows.at(-1).timestamp)}`:'Nessun prelievo rilevato');
  if(!rows.length){
    barsHost.innerHTML='<div class="reward-chart-empty">I prelievi reward compariranno qui come barre verticali.</div>';
    axisHost.innerHTML='';
    return;
  }
  const max=Math.max(...rows.map(row=>number(row.amount)),1e-12);
  barsHost.innerHTML=rows.map((row,index)=>{
    const height=Math.max(8,(number(row.amount)/max)*100);
    const date=new Date(row.timestamp);
    const label=date.toLocaleDateString('it-IT',{day:'2-digit',month:'2-digit'});
    const full=date.toLocaleString('it-IT',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
    return `<div class="reward-bar-column" title="${escapeHtml(full)} · ${inj(row.amount,6)} INJ"><span class="reward-bar-value">${inj(row.amount,4)}</span><i class="reward-bar" style="--bar-height:${height}%"></i><small>${escapeHtml(label)}</small></div>`;
  }).join('');
  const ticks=[max,max*.75,max*.5,max*.25,0];
  axisHost.innerHTML=ticks.map(value=>`<span>${inj(value,value>=1?2:4)}</span>`).join('');
  requestAnimationFrame(()=>{ barsHost.scrollLeft=Math.max(0,barsHost.scrollWidth-barsHost.clientWidth); });
}
function renderAchievements(total,daily){
 const host=$('achievementList'); if(!host) return; const days=state.netWorthHistory.length?Math.max(0,(Date.now()-state.netWorthHistory[0].t)/86400000):0;
 const items=[['100 INJ','Primo grande traguardo',total>=100],['1.000 INJ','Portfolio a quattro cifre',total>=1000],['1 INJ / giorno','Reward speed premium',daily>=1],['365 giorni','Un anno di storico',days>=365]];
 host.innerHTML=items.map(([title,sub,on])=>`<div class="achievement ${on?'unlocked':''}"><span class="achievement-icon">${on?'🏆':'◇'}</span><div><strong>${title}</strong><small>${sub}</small></div></div>`).join('');
}
function renderInsights(total,nw,daily){
  setPerformance('perf1d',historyChange(86400000)); setPerformance('perf7d',historyChange(7*86400000)); setPerformance('perf30d',historyChange(30*86400000));
  const rows=state.netWorthHistory||[]; const all=rows.length>1?{usd:rows.at(-1).v-rows[0].v,pct:rows[0].v?((rows.at(-1).v/rows[0].v)-1)*100:0}:null; setPerformance('perfAll',all);
  const perSecond=daily/86400; setText('rewardPerSecond',state.apr?`${inj(perSecond,9)} INJ/sec`:'—'); const seconds=perSecond>0?1/perSecond:0; const days=Math.floor(seconds/86400),hours=Math.floor((seconds%86400)/3600),mins=Math.floor((seconds%3600)/60); setText('oneInjEta',seconds?`1 INJ ogni ${days}g ${hours}h ${mins}m`:'Carica un wallet');
  const stakePct=total?state.staked/total*100:0, liquidPct=Math.max(0,100-stakePct); setText('stakeAllocation',`${stakePct.toFixed(1)}%`); setText('stakeAllocationText',`${stakePct.toFixed(1)}%`); setText('liquidAllocationText',`${liquidPct.toFixed(1)}%`); const ring=$('allocationRing'); if(ring) ring.style.background=`conic-gradient(var(--accent) ${stakePct*3.6}deg,rgba(255,255,255,.08) 0deg)`;
  updateAth(nw);
  const step=100; const goal=Math.max(step,Math.ceil((total+.000001)/step)*step); const prev=goal-step; const pct=Math.max(0,Math.min(100,((total-prev)/step)*100)); setText('milestoneGoal',`${goal.toLocaleString('en-US')} INJ`); setText('milestonePercent',`${pct.toFixed(1)}%`); setText('milestoneRemaining',`${inj(Math.max(0,goal-total),2)} INJ mancanti`); const mb=$('milestoneBar'); if(mb) mb.style.width=`${pct}%`; const eta=daily>0?(goal-total)/daily:0; setText('milestoneEta',eta>0?`Stima: ${Math.ceil(eta)} giorni ai reward attuali`:'Obiettivo raggiunto');
  const range=state.high-state.low; const position=range>0?(state.price-state.low)/range:0.5; const score=Math.max(0,Math.min(100,50+state.change*4+(position-.5)*30)); const label=score>=70?'Bullish':score>=56?'Positivo':score<=30?'Bearish':score<=44?'Debole':'Neutrale'; setText('sentimentLabel',label); setText('sentimentScore',`${Math.round(score)} / 100`); const sb=$('sentimentBar'); if(sb) sb.style.width=`${score}%`;
  renderRewardWithdrawalChart(); renderAchievements(total,daily);
}
function updateSyncCountdown(){ const elapsed=Date.now()-(state.lastAccountUpdate||Date.now()); const left=Math.max(0,(state.syncInterval||30000)-elapsed); const sec=Math.ceil(left/1000); setText('syncCountdown',`00:${String(sec).padStart(2,'0')}`); const p=$('syncProgress'); if(p) p.style.width=`${Math.max(0,Math.min(100,(1-left/(state.syncInterval||30000))*100))}%`; }
function render(){
  const total=state.available+state.staked+state.rewards; const nw=total*state.price;
  rollValue('priceUsd',preciseMoney(state.price,4),state.price); setText('priceChange',`24h ${state.change>=0?'+':''}${state.change.toFixed(2)}%`);
  if($('priceChange')) $('priceChange').className=`secondary-value ${state.change>0?'up':state.change<0?'down':''}`;
  setText('priceDirection',state.change>0?'▲':state.change<0?'▼':'—'); if($('priceDirection')) $('priceDirection').className=state.change>0?'up':state.change<0?'down':'';
  setText('dayLow',`L ${money(state.low)}`); setText('dayHigh',`H ${money(state.high)}`);
  setText('availableInj',inj(state.available)); setText('availableUsd',money(state.available*state.price));
  setText('stakedInj',inj(state.staked,4)); setText('stakedUsd',money(state.staked*state.price));
  rollValue('rewardsInj',inj(state.rewards,7),state.rewards); setText('rewardsUsd',money(state.rewards*state.price));
  setText('netWorthUsd',money(nw)); setText('netWorthInj',`${inj(total,4)} INJ`); setText('portfolioNetWorth',money(nw)); setText('portfolioTotalInj',`${inj(total,4)} INJ`); setText('portfolioApr',state.apr?`${state.apr.toFixed(3)}%`:'—'); rollValue('portfolioRewards',`${inj(state.rewards,7)} INJ`,state.rewards); setText('portfolioRewardsUsd',money(state.rewards*state.price));
  setText('aprValue',state.apr?`${state.apr.toFixed(3)}%`:'—');
  setText('marketCapValue',state.marketCap?compactUsd(state.marketCap):'—'); setText('marketCapRank',state.marketRank?`Rank #${state.marketRank} · CoinGecko`:'CoinGecko');
  setText('commissionValue',state.validators.length?`${(state.weightedCommission*100).toFixed(2)}%`:'—'); setText('networkAprValue',state.networkApr?`APR rete lordo ${state.networkApr.toFixed(3)}%`:'APR rete lordo —');
  const daily=state.staked*(state.apr/100)/365; setText('portfolioDaily',state.apr?`${inj(daily,6)} INJ/giorno`:'— INJ/giorno'); setText('dailyEstimate',state.apr?`${inj(daily,6)} INJ/giorno`:'— INJ/giorno');
  setText('reward1d',`${inj(daily,7)} INJ`); setText('reward1w',`${inj(daily*7,6)} INJ`); setText('reward1m',`${inj(daily*30.4375,5)} INJ`); setText('reward1y',`${inj(daily*365,4)} INJ`);
  setText('aprMethod',state.apr?`APR netto ponderato: emissione on-chain, community tax ${(state.communityTax*100).toFixed(2)}% e commissioni dei validator. Le fee di rete e l’uptime possono far variare leggermente il risultato reale.`:'APR calcolato dai dati on-chain e al netto delle commissioni.');
  renderInsights(total,nw,daily);
  renderValidators(); renderRewardHistory();

}

function chartRows(values){
  return (values||[]).map((row,index)=>typeof row==='number'?{t:index,v:number(row)}:{t:number(row?.t)||index,v:number(row?.v)}).filter(row=>Number.isFinite(row.v));
}
function defaultVisibleCount(chartId,total,tf=state.timeframe){
  if(total<=2) return total;
  if(chartId!=='marketChart') return Math.min(total,120);
  const counts={ '1min':60, '1h':60, '1d':288, '1w':168, '1mo':180, '1y':365 };
  if(tf==='all') return total;
  return Math.min(total,counts[tf]||total);
}
function resetChartView(chartId,total,tf=state.timeframe){
  const count=defaultVisibleCount(chartId,total,tf);
  state.chartViews[chartId]={start:Math.max(0,total-count),count};
  delete state.hover[chartId];
}
function getChartSlice(chartId,values){
  const all=chartRows(values); if(!all.length) return {all,visible:[],start:0};
  let view=state.chartViews[chartId];
  if(!view||!Number.isFinite(view.count)){ resetChartView(chartId,all.length); view=state.chartViews[chartId]; }
  view.count=Math.max(2,Math.min(all.length,view.count||all.length));
  view.start=Math.max(0,Math.min(all.length-view.count,view.start||0));
  return {all,visible:all.slice(view.start,view.start+view.count),start:view.start};
}
function panChart(chartId,total,delta){
  const view=state.chartViews[chartId]; if(!view||total<=view.count) return;
  view.start=Math.max(0,Math.min(total-view.count,view.start+delta));
  delete state.hover[chartId]; drawAll();
}
function zoomChart(chartId,total,factor,anchor=.5){
  let view=state.chartViews[chartId]; if(!view){resetChartView(chartId,total);view=state.chartViews[chartId]}
  const old=view.count; const next=Math.max(12,Math.min(total,Math.round(old*factor)));
  const anchorIndex=view.start+old*anchor;
  view.count=next; view.start=Math.max(0,Math.min(total-next,Math.round(anchorIndex-next*anchor)));
  delete state.hover[chartId]; drawAll();
}
function drawChart(canvas, values, positive=true, hover=null){
  if(!canvas) return; const rect=canvas.getBoundingClientRect(); if(rect.width<10) return;
  const dpr=Math.min(devicePixelRatio||1,2); canvas.width=Math.round(rect.width*dpr); canvas.height=Math.round(rect.height*dpr);
  const ctx=canvas.getContext('2d'); ctx.scale(dpr,dpr); const w=rect.width,h=rect.height; ctx.clearRect(0,0,w,h);
  const {visible:data}=getChartSlice(canvas.id,values); if(!data.length) return;
  let min=Math.min(...data.map(x=>x.v)),max=Math.max(...data.map(x=>x.v)); if(max===min){max+=1;min-=1} const pad=12;
  const points=data.map((row,i)=>({x:pad+(data.length===1?.5:i/(data.length-1))*(w-pad*2),y:pad+(max-row.v)/(max-min)*(h-pad*2),...row}));
  const accent=getComputedStyle(document.documentElement).getPropertyValue(positive?'--accent':'--red').trim()||'#22d3a6';
  if(points.length>1){
    const gradient=ctx.createLinearGradient(0,0,0,h); gradient.addColorStop(0,accent+'55'); gradient.addColorStop(1,accent+'00');
    ctx.beginPath(); ctx.moveTo(points[0].x,h); points.forEach(p=>ctx.lineTo(p.x,p.y)); ctx.lineTo(points.at(-1).x,h); ctx.closePath(); ctx.fillStyle=gradient; ctx.fill();
    ctx.beginPath(); points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.strokeStyle=accent; ctx.lineWidth=2; ctx.lineJoin='round'; ctx.lineCap='round'; ctx.stroke();
  }
  if(points.length===1){ctx.beginPath();ctx.arc(points[0].x,points[0].y,3.5,0,Math.PI*2);ctx.fillStyle=accent;ctx.fill()}
  if(hover&&Number.isInteger(hover.index)&&points[hover.index]){
    const p=points[hover.index]; ctx.save(); ctx.setLineDash([4,4]); ctx.strokeStyle='rgba(145,160,184,.65)'; ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(p.x,pad);ctx.lineTo(p.x,h-pad);ctx.stroke();ctx.beginPath();ctx.moveTo(pad,p.y);ctx.lineTo(w-pad,p.y);ctx.stroke();ctx.restore();
    ctx.beginPath();ctx.arc(p.x,p.y,5,0,Math.PI*2);ctx.fillStyle=accent;ctx.fill();ctx.lineWidth=2;ctx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--panel').trim()||'#0c111b';ctx.stroke();
  }
}
function drawAll(){
  drawChart($('netWorthChart'),state.netWorthHistory,true,state.hover.netWorthChart);
  drawChart($('marketChart'),state.marketCandles.map(x=>({t:x.t,v:x.c})),(state.marketCandles.at(-1)?.c||0)>=(state.marketCandles[0]?.o||0),state.hover.marketChart);
}
function formatHoverDate(timestamp,tf){
  const opts=tf==='1min'?{minute:'2-digit',second:'2-digit'}:tf==='1h'||tf==='1d'?{hour:'2-digit',minute:'2-digit'}:tf==='1w'||tf==='1mo'?{day:'2-digit',month:'short',hour:'2-digit'}:{day:'2-digit',month:'short',year:'numeric'};
  return new Intl.DateTimeFormat('it-IT',opts).format(new Date(timestamp));
}
function bindInteractiveChart(canvasId,tooltipId,getRows,type){
  const canvas=$(canvasId),tip=$(tooltipId); if(!canvas||!tip) return;
  const isTouch=()=>window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints>0;
  let pointerId=null,startX=0,lastX=0,dragging=false;
  const hideHover=()=>{
    clearTimeout(state.hoverTimers[canvasId]);
    delete state.hoverTimers[canvasId];
    delete state.hover[canvasId];
    tip.classList.remove('show');
    drawAll();
  };
  const scheduleHide=(delay=isTouch()?2000:1000)=>{
    clearTimeout(state.hoverTimers[canvasId]);
    state.hoverTimers[canvasId]=setTimeout(hideHover,delay);
  };
  const showHover=(clientX,clientY,autoHide=true)=>{
    clearTimeout(state.hoverTimers[canvasId]);
    const slice=getChartSlice(canvasId,getRows()); const rows=slice.visible; if(!rows.length) return;
    const rect=canvas.getBoundingClientRect(); const x=Math.max(0,Math.min(rect.width,clientX-rect.left));
    const index=Math.max(0,Math.min(rows.length-1,Math.round((x/rect.width)*(rows.length-1)))); const row=rows[index]; state.hover[canvasId]={index};
    const left=Math.max(65,Math.min(rect.width-65,10+(rows.length===1?.5:index/(rows.length-1))*(rect.width-20))); tip.style.left=`${left}px`; tip.style.top=`${Math.max(48,clientY-rect.top)}px`;
    const label=formatHoverDate(row.t,type==='market'?state.timeframe:'1m'); tip.innerHTML=`<strong>${money(row.v)}</strong><span>${label}</span>`; tip.classList.add('show'); drawAll();
    if(autoHide) scheduleHide();
  };
  canvas.addEventListener('pointerdown',e=>{
    pointerId=e.pointerId; startX=lastX=e.clientX; dragging=false;
    canvas.setPointerCapture?.(pointerId);
    if(!isTouch()) canvas.classList.add('grabbing');
    showHover(e.clientX,e.clientY,false);
  });
  canvas.addEventListener('pointermove',e=>{
    if(isTouch()){
      if(pointerId!==null&&e.pointerId===pointerId) showHover(e.clientX,e.clientY,false);
      return;
    }
    if(pointerId!==null&&e.pointerId===pointerId){
      const dx=e.clientX-lastX; if(Math.abs(e.clientX-startX)>5) dragging=true;
      if(dragging){
        const total=chartRows(getRows()).length; const view=state.chartViews[canvasId];
        const pxPerPoint=canvas.getBoundingClientRect().width/Math.max(1,(view?.count||total));
        const steps=Math.round(-dx/Math.max(2,pxPerPoint));
        if(steps) panChart(canvasId,total,steps);
        lastX=e.clientX; tip.classList.remove('show');
      } else showHover(e.clientX,e.clientY,true);
    } else showHover(e.clientX,e.clientY,true);
  });
  const finish=e=>{
    if(pointerId!==null&&(!e||e.pointerId===pointerId)){
      try{canvas.releasePointerCapture?.(pointerId)}catch{}
      pointerId=null; canvas.classList.remove('grabbing');
      if(e) showHover(e.clientX,e.clientY,false);
      scheduleHide(isTouch()?2000:1000);
      dragging=false;
    }
  };
  canvas.addEventListener('pointerup',finish); canvas.addEventListener('pointercancel',finish);
  canvas.addEventListener('pointerleave',()=>{ if(pointerId===null&&!isTouch()) scheduleHide(1000); });
  canvas.addEventListener('wheel',e=>{
    if(isTouch()) return;
    e.preventDefault(); const total=chartRows(getRows()).length; const rect=canvas.getBoundingClientRect();
    if(e.ctrlKey||e.metaKey){ zoomChart(canvasId,total,e.deltaY>0?1.18:.84,(e.clientX-rect.left)/rect.width); }
    else { const direction=(Math.abs(e.deltaX)>Math.abs(e.deltaY)?e.deltaX:e.deltaY); panChart(canvasId,total,Math.sign(direction)*Math.max(1,Math.round(Math.abs(direction)/18))); }
  },{passive:false});
  canvas.addEventListener('dblclick',()=>{ resetChartView(canvasId,chartRows(getRows()).length,type==='market'?state.timeframe:'1m'); drawAll(); });
}

function closeWalletSearch(){ const box=$('headerSearch'); if(!box) return; box.classList.remove('open'); $('searchToggle')?.setAttribute('aria-expanded','false'); $('addressInput')?.blur(); }
function toggleWalletSearch(force){ const box=$('headerSearch'); if(!box) return; const open=typeof force==='boolean'?force:!box.classList.contains('open'); box.classList.toggle('open',open); $('searchToggle')?.setAttribute('aria-expanded',open?'true':'false'); if(open) setTimeout(()=>$('addressInput')?.focus(),180); }
function walletKey(address){ return String(address||'').trim().toLowerCase(); }
function shortWallet(address){ const s=String(address||''); return s.length>18?`${s.slice(0,8)}…${s.slice(-6)}`:s; }
function saveWalletCollection(){
  storage.setJSON('inj_wallet_tabs_v5',state.wallets);
  storage.setJSON('inj_wallet_cache_v5',state.walletCache);
}
function renderWalletTabs(){
  const host=$('walletTabs'); if(!host) return;
  if(!state.wallets.length){ host.innerHTML='<span class="wallet-tab-empty">Aggiungi un wallet con ＋</span>'; return; }
  host.innerHTML=state.wallets.map(address=>{
    const key=walletKey(address), cache=state.walletCache[key]||{}, active=key===walletKey(state.address);
    const total=Number.isFinite(Number(cache.total))?`${inj(cache.total,2)} INJ`:'In attesa…';
    const statusClass=cache.status==='error'?'error':cache.status==='online'?'online':'';
    return `<button class="wallet-tab ${active?'active':''} ${statusClass}" type="button" data-wallet="${escapeHtml(address)}" aria-pressed="${active?'true':'false'}"><i class="wallet-tab-status"></i><span class="wallet-tab-copy"><strong>${escapeHtml(shortWallet(address))}</strong><small>${escapeHtml(total)}</small></span><span class="wallet-tab-close" data-close-wallet="${escapeHtml(address)}" title="Chiudi scheda" aria-label="Chiudi scheda">×</span></button>`;
  }).join('');
}
function clearWalletState(){
  state.available=0; state.staked=0; state.rewards=0; state.apr=0; state.networkApr=0; state.communityTax=0; state.weightedCommission=0; state.validators=[]; state.rewardHistory=[]; state.rewardHistoryLoaded=false; state.rewardHistoryLoading=false; state.rewardHistoryNextKey=''; state.rewardHistorySyncedSession=false; state.rewardHistoryLastSync=0; state.lastAccountUpdate=0;
}
function selectWallet(address,{feedback=false}={}){
  const value=String(address||'').trim(); if(!validAddress(value)) return;
  const key=walletKey(value);
  if(!state.wallets.some(item=>walletKey(item)===key)) state.wallets.push(value);
  clearInterval(state.accountTimer); clearWalletState();
  state.address=value; storage.set('inj_address',value); $('addressInput').value=value;
  state.netWorthHistory=normalizeHistory(storage.getJSON(netWorthHistoryKey(value),[])).slice(-HISTORY.netWorthLimit);
  saveWalletCollection(); renderWalletTabs(); render(); drawAll();
  loadAccount(feedback); state.accountTimer=setInterval(()=>loadAccount(false),state.syncInterval);
  document.dispatchEvent(new CustomEvent('inj:wallet-changed',{detail:{address:value}}));
}
function addWallet(address,{select=true,feedback=true}={}){
  const value=String(address||'').trim(); if(!validAddress(value)){ if(feedback) toast('Indirizzo non valido'); return false; }
  const existing=state.wallets.find(item=>walletKey(item)===walletKey(value));
  if(!existing) state.wallets.push(value);
  saveWalletCollection(); renderWalletTabs();
  if(select) selectWallet(existing||value,{feedback});
  return true;
}
function removeWallet(address){
  const key=walletKey(address), wasActive=key===walletKey(state.address);
  state.wallets=state.wallets.filter(item=>walletKey(item)!==key); delete state.walletCache[key]; saveWalletCollection();
  if(wasActive){
    clearInterval(state.accountTimer); clearWalletState();
    const next=state.wallets[0]||''; state.address=''; storage.set('inj_address',next);
    if(next) selectWallet(next,{feedback:false}); else { $('addressInput').value=''; render(); drawAll(); status('online','Prezzo live'); }
  }
  renderWalletTabs();
}
async function refreshWalletSummary(address){
  const value=String(address||'').trim(), key=walletKey(value); if(!validAddress(value)||key===walletKey(state.address)) return;
  try{
    const [bank,delegations,rewards]=await Promise.all([
      lcd(`/cosmos/bank/v1beta1/balances/${value}`),
      lcd(`/cosmos/staking/v1beta1/delegations/${value}`),
      lcd(`/cosmos/distribution/v1beta1/delegators/${value}/rewards`)
    ]);
    const available=findAmount(bank?.balances||[]), staked=parseDelegations(delegations), reward=parseRewards(rewards);
    state.walletCache[key]={total:available+staked+reward,available,staked,rewards:reward,updated:Date.now(),status:'online'};
  }catch{ state.walletCache[key]={...(state.walletCache[key]||{}),status:'error',updated:Date.now()}; }
  saveWalletCollection(); renderWalletTabs();
}
async function refreshInactiveWallets(){ for(const address of state.wallets){ if(walletKey(address)!==walletKey(state.address)) await refreshWalletSummary(address); } }
function loadWallet(){ const value=$('addressInput').value.trim(); if(addWallet(value,{select:true,feedback:true})) closeWalletSearch(); }
function initEvents(){
  $('timeframeTabs')?.addEventListener('click',event=>{ const btn=event.target.closest('button[data-tf]'); if(!btn) return; event.preventDefault(); loadMarketTimeframe(btn.dataset.tf); });
  bindInteractiveChart('netWorthChart','netWorthTooltip',()=>state.netWorthHistory,'networth');
  bindInteractiveChart('marketChart','marketTooltip',()=>state.marketCandles.map(x=>({t:x.t,v:x.c})),'market');
  $('refreshWithdrawals')?.addEventListener('click',()=>loadRewardHistory({append:false})); $('loadMoreWithdrawals')?.addEventListener('click',()=>loadRewardHistory({append:true}));
  $('searchToggle')?.addEventListener('click',()=>toggleWalletSearch());
  $('addWalletTab')?.addEventListener('click',()=>toggleWalletSearch(true));
  $('walletTabs')?.addEventListener('click',event=>{ const close=event.target.closest('[data-close-wallet]'); if(close){ event.preventDefault(); event.stopPropagation(); removeWallet(close.dataset.closeWallet); return; } const tab=event.target.closest('[data-wallet]'); if(tab) selectWallet(tab.dataset.wallet,{feedback:false}); });
  $('loadButton')?.addEventListener('click',loadWallet); $('addressInput')?.addEventListener('keydown',e=>{if(e.key==='Enter')loadWallet(); if(e.key==='Escape')closeWalletSearch()});
  document.addEventListener('pointerdown',e=>{ const box=$('headerSearch'); if(box?.classList.contains('open')&&!box.contains(e.target)) closeWalletSearch(); });
  $('themeButton')?.addEventListener('click',()=>{ const active=document.body.classList.toggle('light'); storage.set('inj_theme',active?'light':'dark'); $('themeButton')?.setAttribute('aria-pressed',active?'true':'false'); drawAll(); });
  $('privacyButton')?.addEventListener('click',()=>{ const active=document.body.classList.toggle('privacy'); $('privacyButton')?.setAttribute('aria-pressed',active?'true':'false'); $('privacyButton')?.setAttribute('aria-label',active?'Mostra valori':'Nascondi valori'); });
  window.addEventListener('resize',()=>requestAnimationFrame(drawAll)); window.addEventListener('online',()=>{status('','Riconnessione…');loadMarket();if(state.address){state.rewardHistorySyncedSession=false;loadAccount(false)}}); window.addEventListener('offline',()=>status('offline','Offline'));
}
function init(){
  state.priceHistory=normalizeHistory(storage.getJSON(HISTORY.priceKey,[])).slice(-HISTORY.priceLimit); state.timeframe=storage.get('inj_timeframe_v4','1h'); if(!TIMEFRAMES[state.timeframe]) state.timeframe='1h'; state.marketCandles=storage.getJSON(`inj_market_${state.timeframe}_v4`,[]);
  const saved=storage.get('inj_address','');
  state.wallets=(storage.getJSON('inj_wallet_tabs_v5',[])||[]).filter(validAddress);
  state.walletCache=storage.getJSON('inj_wallet_cache_v5',{})||{};
  if(validAddress(saved)&&!state.wallets.some(item=>walletKey(item)===walletKey(saved))) state.wallets.unshift(saved);
  $('addressInput').value=saved;
  if(validAddress(saved)) state.netWorthHistory=normalizeHistory(storage.getJSON(netWorthHistoryKey(saved),[])).slice(-HISTORY.netWorthLimit);
  if(storage.get('inj_theme','dark')==='light') document.body.classList.add('light');
  if(storage.get('inj_data_mode_v56','off')==='on') document.body.classList.add('data-mode');
  $('themeButton')?.setAttribute('aria-pressed',document.body.classList.contains('light')?'true':'false');
  $('dataModeButton')?.setAttribute('aria-pressed',document.body.classList.contains('data-mode')?'true':'false');
  initEvents(); renderWalletTabs(); setInterval(updateSyncCountdown,1000); updateSyncCountdown(); render(); renderMarket(); loadMarket(); loadMarketTimeframe(state.timeframe); connectPriceSocket();
  if(validAddress(saved)) selectWallet(saved,{feedback:false});
  else if(state.wallets.length) selectWallet(state.wallets[0],{feedback:false});
  state.walletRefreshTimer=setInterval(refreshInactiveWallets,60000); setTimeout(refreshInactiveWallets,5000);
}

document.addEventListener('DOMContentLoaded',init);

/* INJ Terminal v5.0 intelligence layer */
(() => {
  const V5 = {
    db: null, snapshots: [], viewing: false, replayTimer: null, lastPrice: 0,
    activities: storage.getJSON('inj_v5_activity', []).slice(0, 40),
    events: storage.getJSON('inj_v5_events', []), apiLatency: 0
  };
  const q = id => document.getElementById(id);
  const nowTime = () => new Intl.DateTimeFormat('it-IT',{hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date());

  function addActivity(text, kind='info') {
    const last=V5.activities[0]; if(last?.text===text && Date.now()-last.t<15000) return;
    V5.activities.unshift({t:Date.now(), text, kind}); V5.activities=V5.activities.slice(0,40);
    storage.setJSON('inj_v5_activity',V5.activities); renderActivity();
  }
  function renderActivity(){
    const box=q('activityStream'); if(!box) return;
    box.innerHTML=V5.activities.length?V5.activities.map(a=>`<div class="activity-row"><time>${new Intl.DateTimeFormat('it-IT',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(a.t))}</time><strong>${escapeHtml(a.text)}</strong></div>`).join(''):'<p class="empty-line">In attesa di attività…</p>';
  }

  function openDb(){
    return new Promise(resolve=>{
      if(!('indexedDB' in window)){resolve(null);return}
      const req=indexedDB.open('inj-terminal-v5',1);
      req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains('snapshots')){const s=db.createObjectStore('snapshots',{keyPath:'id',autoIncrement:true});s.createIndex('addressTime',['address','t'])}};
      req.onsuccess=()=>{V5.db=req.result;resolve(V5.db)}; req.onerror=()=>resolve(null);
    });
  }
  function snapshotData(){
    const total=number(state.available)+number(state.staked)+number(state.rewards);
    return {address:state.address||'guest',t:Date.now(),price:number(state.price),available:number(state.available),staked:number(state.staked),rewards:number(state.rewards),apr:number(state.apr),commission:number(state.weightedCommission),netWorth:total*number(state.price),total};
  }
  function saveSnapshot(){
    if(!V5.db||!state.address||!state.price) return;
    const snap=snapshotData(); const last=V5.snapshots.at(-1);
    if(last&&snap.t-last.t<25000) return;
    const tx=V5.db.transaction('snapshots','readwrite'); tx.objectStore('snapshots').add(snap); V5.snapshots.push(snap); V5.snapshots=V5.snapshots.slice(-2000); updateTimeline();
  }
  function loadSnapshots(){
    if(!V5.db||!state.address) return Promise.resolve([]);
    return new Promise(resolve=>{const tx=V5.db.transaction('snapshots','readonly');const idx=tx.objectStore('snapshots').index('addressTime');const range=IDBKeyRange.bound([state.address,0],[state.address,Number.MAX_SAFE_INTEGER]);const r=idx.getAll(range);r.onsuccess=()=>{V5.snapshots=(r.result||[]).slice(-2000);updateTimeline();resolve(V5.snapshots)};r.onerror=()=>resolve([])});
  }
  function updateTimeline(){
    const slider=q('timelineSlider');if(!slider)return;slider.max=Math.max(0,V5.snapshots.length-1);slider.value=V5.viewing?slider.value:slider.max;slider.disabled=V5.snapshots.length<2;
    q('storageMonitor').textContent=V5.db?`${V5.snapshots.length} punti`:'Local';
    if(!V5.viewing) q('timelineDate').textContent=V5.snapshots.length?`Ultimo salvataggio: ${new Date(V5.snapshots.at(-1).t).toLocaleString('it-IT')}`:'Lo storico inizierà dal primo salvataggio';
  }
  function showSnapshot(s){
    if(!s)return; V5.viewing=true; document.body.classList.add('timeline-view'); q('timelineMode').textContent='STORICO'; q('timelineDate').textContent=new Date(s.t).toLocaleString('it-IT');
    setText('marketPrice',preciseMoney(s.price,4)); setText('availableInj',`${inj(s.available,6)} INJ`); setText('stakedInj',`${inj(s.staked,4)} INJ`); setText('rewardsInj',`${inj(s.rewards,6)} INJ`); setText('aprValue',`${s.apr.toFixed(2)}%`); setText('netWorthUsd',money(s.netWorth)); setText('netWorthInj',`${inj(s.total,4)} INJ`);
  }
  function goLive(){V5.viewing=false;clearInterval(V5.replayTimer);V5.replayTimer=null;document.body.classList.remove('timeline-view','replay-active');q('timelineMode').textContent='LIVE';render();renderMarket();updateTimeline()}
  function replay(){
    if(V5.snapshots.length<2){toast('Servono almeno due snapshot');return} clearInterval(V5.replayTimer);document.body.classList.add('replay-active');let i=0;const slider=q('timelineSlider');
    V5.replayTimer=setInterval(()=>{if(i>=V5.snapshots.length){goLive();toast('Replay completato');return}slider.value=i;showSnapshot(V5.snapshots[i]);i++},600);
  }

  function renderHealth(){
    const checks=[
      ['API raggiungibile',navigator.onLine],['WebSocket connesso',state.socket?.readyState===1],['Wallet sincronizzato',!!state.address&&state.lastAccountUpdate>0],['Validator attivi',state.validators.length>0],['APR disponibile',state.apr>0],['Storico persistente',!!V5.db]
    ];
    const score=Math.round(checks.filter(x=>x[1]).length/checks.length*100);q('healthScore').textContent=`${score}/100`;q('healthBar').style.width=`${score}%`;q('healthItems').innerHTML=checks.map(([n,ok])=>`<span class="health-item ${ok?'':'warn'}"><i></i>${n}</span>`).join('');
  }
  function renderSmartInsights(){
    const box=q('smartInsightList');if(!box)return; if(!state.address){box.innerHTML='<p>Carica un wallet per generare gli insight.</p>';return}
    const total=state.available+state.staked+state.rewards,daily=state.staked*(state.apr/100)/365,goal=Math.ceil(total/100)*100||100,remaining=Math.max(0,goal-total),days=daily>0?remaining/daily:0;
    const perf=historyChange(7*864e5); const lines=[
      `Il portfolio contiene <strong>${inj(total,2)} INJ</strong>, di cui ${total?((state.staked/total)*100).toFixed(1):0}% in staking.`,
      daily>0?`Al ritmo attuale maturi circa <strong>${inj(daily,4)} INJ al giorno</strong>.`:'Il ritmo reward sarà disponibile dopo la sincronizzazione.',
      remaining>0?`Mancano <strong>${inj(remaining,2)} INJ</strong> al traguardo di ${goal} INJ${days?`, circa ${Math.ceil(days)} giorni con il solo rendimento`:''}.`:`Obiettivo di ${goal} INJ raggiunto.`,
      perf?`Negli ultimi 7 giorni il Net Worth è ${perf.usd>=0?'salito':'sceso'} di <strong>${money(Math.abs(perf.usd))}</strong>.`:'Lo storico performance crescerà automaticamente nel tempo.'
    ]; box.innerHTML=lines.map(x=>`<p>${x}</p>`).join('');
  }
  function renderMonitor(){q('apiLatency').textContent=V5.apiLatency?`${V5.apiLatency} ms`:'— ms';q('wsMonitor').textContent=state.socket?.readyState===1?'Connected':'Reconnecting';q('monitorStatus').textContent=navigator.onLine?'ONLINE':'OFFLINE';}

  function renderEvents(){
    const box=q('eventList');if(!box)return;const now=Date.now();V5.events.sort((a,b)=>a.t-b.t);
    box.innerHTML=V5.events.length?V5.events.map((e,i)=>{const d=e.t-now;const label=d<=0?'In corso / concluso':d<864e5?`${Math.ceil(d/36e5)} ore`:`${Math.ceil(d/864e5)} giorni`;return `<div class="event-row"><strong>${escapeHtml(e.title)}</strong><span class="event-countdown">${label}</span><button class="event-delete" data-i="${i}" aria-label="Elimina">×</button></div>`}).join(''):'<p class="empty-line">Nessun evento configurato.</p>';
  }


  /* Realtime Injective transaction listener for the active wallet */
  const CHAIN_WS='wss://sentry.tm.injective.network:443/websocket';
  const RT={ws:null,reconnectTimer:null,pingTimer:null,address:'',requestId:1000,seen:new Set()};

  function activitySeenKey(address){return `inj_v5_seen_tx_${String(address||'').toLowerCase()}`}
  function loadSeen(address){RT.seen=new Set(storage.getJSON(activitySeenKey(address),[]).slice(-300))}
  function rememberHash(hash){
    if(!hash)return false;
    const h=String(hash).toUpperCase();
    if(RT.seen.has(h))return false;
    RT.seen.add(h);
    storage.setJSON(activitySeenKey(RT.address),[...RT.seen].slice(-300));
    return true;
  }
  function decodeEventValue(value){
    const text=String(value??'');
    if(!text)return '';
    try{
      if(/^[A-Za-z0-9+/]+={0,2}$/.test(text)&&text.length%4===0){
        const decoded=atob(text);
        if(/^[\x20-\x7E\r\n\t]+$/.test(decoded))return decoded;
      }
    }catch{}
    return text;
  }
  function eventAttributes(events=[]){
    const out=[];
    for(const event of events||[]){
      const type=decodeEventValue(event?.type);
      for(const attr of event?.attributes||[])out.push({type,key:decodeEventValue(attr?.key),value:decodeEventValue(attr?.value)});
    }
    return out;
  }
  function coinInj(value){
    const text=String(value||'');
    const matches=[...text.matchAll(/([0-9]+(?:\.[0-9]+)?)inj\b/gi)];
    return matches.reduce((sum,m)=>sum+fromWei(m[1]),0);
  }
  function txHashFromRealtime(message){
    const events=message?.result?.events||{};
    const direct=events['tx.hash']?.[0]||events['Tx.hash']?.[0];
    if(direct)return decodeEventValue(direct);
    const attrs=eventAttributes(message?.result?.data?.value?.TxResult?.result?.events||[]);
    return attrs.find(x=>x.key==='txHash'||x.key==='hash')?.value||'';
  }
  function messageType(msg){return String(msg?.['@type']||msg?.type_url||msg?.type||'')}
  function amountFromMessage(msg){
    const a=msg?.amount;
    if(a&&typeof a==='object'&&String(a.denom).toLowerCase()==='inj')return fromWei(a.amount);
    if(Array.isArray(a))return a.filter(x=>String(x?.denom).toLowerCase()==='inj').reduce((n,x)=>n+fromWei(x.amount),0);
    return coinInj(a);
  }
  function classifyTx(detail,hash){
    const response=detail?.tx_response||detail?.txResponse||detail||{};
    if(Number(response?.code||0)!==0)return [];
    const tx=detail?.tx||response?.tx||{};
    const msgs=tx?.body?.messages||[];
    const attrs=eventAttributes(response?.events||response?.logs?.flatMap(x=>x?.events||[])||[]);
    const timestamp=response?.timestamp?new Date(response.timestamp).getTime():Date.now();
    const rows=[];
    for(const msg of msgs){
      const type=messageType(msg);
      if(type.endsWith('MsgWithdrawDelegatorReward')){
        let amount=attrs.filter(x=>x.type==='withdraw_rewards'&&x.key==='amount').reduce((n,x)=>n+coinInj(x.value),0);
        if(!amount)amount=attrs.filter(x=>x.key==='amount'&&(x.type==='coin_received'||x.type==='transfer')).reduce((n,x)=>n+coinInj(x.value),0);
        rows.push({kind:'reward',amount,timestamp,hash});
      }else if(type.endsWith('MsgDelegate')){
        rows.push({kind:'delegate',amount:amountFromMessage(msg),timestamp,hash});
      }else if(type.endsWith('MsgBeginRedelegate')){
        rows.push({kind:'redelegate',amount:amountFromMessage(msg),timestamp,hash});
      }else if(type.endsWith('MsgUndelegate')){
        rows.push({kind:'undelegate',amount:amountFromMessage(msg),timestamp,hash});
      }
    }
    return rows;
  }
  async function fetchAndRecordTx(hash){
    if(!hash||!rememberHash(hash))return;
    try{
      const detail=await lcd(`/cosmos/tx/v1beta1/txs/${encodeURIComponent(hash)}`);
      const rows=classifyTx(detail,hash);
      if(!rows.length)return;
      for(const row of rows){
        if(row.kind==='reward'&&row.amount>0){
          const response=detail?.tx_response||detail?.txResponse||detail||{};
          const tx=detail?.tx||response?.tx||{};
          const rewardMsg=(tx?.body?.messages||[]).find(msg=>messageType(msg).endsWith('MsgWithdrawDelegatorReward'));
          addRewardWithdrawal({
            id:`${hash}:${rewardMsg?.validator_address||''}`,
            hash,
            timestamp:response?.timestamp||new Date(row.timestamp||Date.now()).toISOString(),
            amount:row.amount,
            validator:rewardMsg?.validator_address||'',
            height:response?.height||''
          });
        }
        const qty=row.amount>0?`${inj(row.amount,6)} INJ`:'quantità rilevata on-chain';
        const short=String(hash).slice(0,8);
        if(row.kind==='reward')addActivity(`Reward prelevati: ${qty} · TX ${short}`,'reward');
        if(row.kind==='delegate')addActivity(`Rimessi in staking: ${qty} · TX ${short}`,'stake');
        if(row.kind==='redelegate')addActivity(`Redelega: ${qty} · TX ${short}`,'stake');
        if(row.kind==='undelegate')addActivity(`Unstake avviato: ${qty} · TX ${short}`,'warn');
        const latest=V5.activities[0]; if(latest)latest.t=row.timestamp;
      }
      storage.setJSON('inj_v5_activity',V5.activities);renderActivity();
      setTimeout(()=>loadAccount(false),700);
    }catch(error){
      console.warn('Realtime tx detail unavailable',hash,error);
      RT.seen.delete(String(hash).toUpperCase());
    }
  }
  function subscribeAddress(address){
    if(!RT.ws||RT.ws.readyState!==WebSocket.OPEN||!validAddress(address))return;
    const query=`tm.event='Tx' AND message.sender='${address}'`;
    RT.ws.send(JSON.stringify({jsonrpc:'2.0',method:'subscribe',id:++RT.requestId,params:{query}}));
  }
  function stopRealtimeWallet(){
    clearTimeout(RT.reconnectTimer);clearInterval(RT.pingTimer);
    try{RT.ws?.close()}catch{}
    RT.ws=null;
  }
  function startRealtimeWallet(address=state.address){
    const value=String(address||'').trim();
    stopRealtimeWallet();RT.address=value;
    if(!validAddress(value))return;
    loadSeen(value);
    try{
      const ws=new WebSocket(CHAIN_WS);RT.ws=ws;
      ws.onopen=()=>{
        subscribeAddress(value);
        RT.pingTimer=setInterval(()=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({jsonrpc:'2.0',method:'health',id:++RT.requestId,params:{}}))},25000);
        addActivity('Monitor on-chain realtime connesso','online');
      };
      ws.onmessage=event=>{
        try{
          const message=JSON.parse(event.data);
          const hash=txHashFromRealtime(message);
          if(hash)fetchAndRecordTx(hash);
        }catch(error){console.warn('Realtime message parse',error)}
      };
      ws.onerror=()=>{try{ws.close()}catch{}};
      ws.onclose=()=>{
        clearInterval(RT.pingTimer);
        if(RT.address===value)RT.reconnectTimer=setTimeout(()=>startRealtimeWallet(value),3000);
      };
    }catch{RT.reconnectTimer=setTimeout(()=>startRealtimeWallet(value),3000)}
  }

  const originalLoadAccount=loadAccount;
  loadAccount=async function(...args){const start=performance.now();const result=await originalLoadAccount.apply(this,args);V5.apiLatency=Math.round(performance.now()-start);if(state.address){await loadSnapshots();saveSnapshot();addActivity('Wallet sincronizzato')}renderHealth();renderSmartInsights();renderMonitor();return result};
  const originalUpdatePrice=updatePrice;
  updatePrice=function(next){const old=state.price;originalUpdatePrice(next);const p=number(next.price);if(old&&p&&Math.abs((p-old)/old)>.0007)addActivity(`Prezzo INJ ${p>old?'in rialzo':'in ribasso'}: ${preciseMoney(p,4)}`);V5.lastPrice=p;renderHealth();renderMonitor()};
  const originalRender=render;
  render=function(...args){const out=originalRender.apply(this,args);if(!V5.viewing){renderHealth();renderSmartInsights();renderMonitor()}return out};

  document.addEventListener('DOMContentLoaded',async()=>{
    await openDb(); if(state.address){ state.rewardHistory=savedRewardHistory(state.address); state.rewardHistoryLoaded=state.rewardHistory.length>0; renderRewardHistory(); await loadSnapshots(); } renderActivity();renderHealth();renderSmartInsights();renderMonitor();updateTimeline(); if(state.address)startRealtimeWallet(state.address);
    document.addEventListener('inj:wallet-changed',async()=>{ state.rewardHistory=savedRewardHistory(state.address); state.rewardHistoryLoaded=state.rewardHistory.length>0; state.rewardHistoryNextKey=''; state.rewardHistorySyncedSession=false; state.rewardHistoryLastSync=number(storage.get(rewardHistoryStorageKey()+':lastSync')); renderRewardHistory(); V5.viewing=false; V5.snapshots=[]; await loadSnapshots(); updateTimeline(); renderSmartInsights(); renderHealth(); startRealtimeWallet(state.address); });

    const syncRewardHistoryAfterOffline=()=>{
      if(!validAddress(state.address)||state.rewardHistoryLoading||document.hidden) return;
      const stale=Date.now()-number(state.rewardHistoryLastSync)>60000;
      if(stale){ state.rewardHistorySyncedSession=false; loadRewardHistory({showFeedback:false}); }
    };
    document.addEventListener('visibilitychange',()=>{ if(!document.hidden) syncRewardHistoryAfterOffline(); });
    window.addEventListener('focus',syncRewardHistoryAfterOffline);

    const setDataMode=(active)=>{ document.body.classList.toggle('data-mode',active); q('dataModeButton')?.setAttribute('aria-pressed',active?'true':'false'); storage.set('inj_data_mode_v56',active?'on':'off'); requestAnimationFrame(drawAll); };
    q('dataModeButton')?.addEventListener('click',()=>setDataMode(!document.body.classList.contains('data-mode')));
    document.addEventListener('keydown',e=>{if((e.key==='d'||e.key==='D')&&!/input|textarea/i.test(e.target.tagName))setDataMode(!document.body.classList.contains('data-mode'))});
    q('timelineSlider')?.addEventListener('input',e=>showSnapshot(V5.snapshots[number(e.target.value)]));q('liveTimeline')?.addEventListener('click',goLive);q('replayPortfolio')?.addEventListener('click',replay);
    setInterval(()=>{renderMonitor();renderHealth()},10000);
  });
})();
