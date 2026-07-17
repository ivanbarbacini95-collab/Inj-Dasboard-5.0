'use strict';

const $ = (id) => document.getElementById(id);
const INJ_DECIMALS = 1e18;
const ENDPOINTS = [
  'https://sentry.lcd.injective.network:443',
  'https://lcd.injective.network',
  'https://1rpc.io/inj-lcd'
];
const state = { timeframe:'24h', hover:{}, chartViews:{}, drag:{}, timeframeLoading:false, timeframeRequest:0, marketCandles:[], address:'', price:0, change:0, low:0, high:0, marketCap:0, marketRank:0, available:0, staked:0, rewards:0, apr:0, networkApr:0, communityTax:0, weightedCommission:0, validators:[], rewardHistory:[], rewardHistoryLoaded:false, rewardHistoryLoading:false, rewardHistoryNextKey:'', endpoint:'', priceHistory:[], netWorthHistory:[], socket:null, accountTimer:null };

const HISTORY = { priceKey:'inj_price_history_v4', priceLimit:720, netWorthLimit:720, priceStep:60_000, netWorthStep:300_000 };

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
function compactUsd(value){ return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',notation:'compact',maximumFractionDigits:2}).format(number(value)); }
function rate(value){ const n=number(value); return n>1?n/1e18:n; }
function inj(value,digits=6){ return number(value).toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits}); }
function validAddress(value){ return /^inj1[0-9a-z]{38,60}$/i.test(String(value).trim()); }
function setText(id,value){ const el=$(id); if(el) el.textContent=value; }
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
  '1h':{interval:'1m',limit:60,label:'1H'},
  '24h':{interval:'5m',limit:288,label:'24H'},
  '7d':{interval:'1h',limit:168,label:'7D'},
  '1m':{interval:'4h',limit:180,label:'1M'},
  '1y':{interval:'1d',limit:365,label:'1Y'},
  'all':{interval:'1w',limit:1000,label:'ALL'}
};
async function loadMarketTimeframe(tf=state.timeframe){
  const cfg=TIMEFRAMES[tf]||TIMEFRAMES['24h'];
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
function renderMarket(){
  const rows=state.marketCandles||[]; const first=rows[0],last=rows.at(-1);
  setText('marketPrice',money(state.price)); setText('marketChange',`${state.change>=0?'+':''}${state.change.toFixed(2)}% nelle 24h`);
  setText('ohlcOpen',first?money(first.o):'—'); setText('ohlcHigh',rows.length?money(Math.max(...rows.map(x=>x.h))):'—');
  setText('ohlcLow',rows.length?money(Math.min(...rows.map(x=>x.l))):'—'); setText('ohlcClose',last?money(last.c):'—');
  setText('ohlcVolume',rows.length?`${rows.reduce((a,x)=>a+x.v,0).toLocaleString('en-US',{maximumFractionDigits:0})} INJ`:'—');
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
function updatePrice(next){ Object.assign(state,next); updateLiveMarketCandle(state.price); sampleHistory(state.priceHistory,state.price,HISTORY.priceStep,HISTORY.priceLimit); savePriceHistory(); render(); renderMarket(); drawAll(); }

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
    status('online','Online'); render(); drawAll(); if(showFeedback) toast('Wallet aggiornato');
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
function txMessages(tx){ return tx?.body?.messages||[]; }
function isWithdrawMessage(message,address){
  const type=String(message?.['@type']||message?.type_url||'');
  return type.endsWith('MsgWithdrawDelegatorReward') && (!address || message?.delegator_address===address);
}
function parseWithdrawalTx(tx,response,address){
  const messages=txMessages(tx).filter(m=>isWithdrawMessage(m,address));
  if(!messages.length || Number(response?.code||0)!==0) return [];
  const events=response?.events||[];
  const rewardEvents=events.filter(e=>e?.type==='withdraw_rewards');
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
    const unique=new Map(combined.map(row=>[row.id,row]));
    state.rewardHistory=[...unique.values()].sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp));
    state.rewardHistoryNextKey=(total&&offset<total)?String(offset):'';
    state.rewardHistoryLoaded=true;
    renderRewardHistory();
    if(showFeedback) toast(parsed.length?`${parsed.length} prelievi trovati`:`Nessun prelievo in ${scanned} transazioni`);
  }catch(error){
    console.error('Reward history',error); state.rewardHistoryLoaded=true; renderRewardHistory('Impossibile leggere lo storico on-chain.'); if(showFeedback) toast('Storico reward non disponibile');
  }finally{ state.rewardHistoryLoading=false; renderRewardHistory(); }
}
function formatDate(value){
  const d=new Date(value); if(Number.isNaN(d.getTime())) return 'Data non disponibile';
  return d.toLocaleString('it-IT',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
}
function renderRewardHistory(error=''){
  const host=$('withdrawalList'); if(!host) return;
  const rows=state.rewardHistory||[]; const total=rows.reduce((sum,row)=>sum+row.amount,0);
  setText('withdrawnTotalInj',`${inj(total,6)} INJ`); setText('withdrawnTotalUsd',`${money(total*state.price)} al prezzo attuale`);
  setText('withdrawalCount',String(rows.length)); setText('withdrawalRange',rows.length?'Transazioni on-chain trovate':'Storico on-chain');
  setText('lastWithdrawalInj',rows.length?`${inj(rows[0].amount,6)} INJ`:'—'); setText('lastWithdrawalDate',rows.length?formatDate(rows[0].timestamp):'Nessun prelievo');
  const more=$('loadMoreWithdrawals'); if(more){ more.hidden=!state.rewardHistoryNextKey; more.disabled=state.rewardHistoryLoading; }
  if(state.rewardHistoryLoading&&!rows.length){ host.innerHTML='<div class="loading-line">Ricerca dei prelievi on-chain…</div>'; return; }
  if(error&&!rows.length){ host.innerHTML=`<div class="validator-empty">${escapeHtml(error)}</div>`; return; }
  if(!state.rewardHistoryLoaded){ host.innerHTML='<div class="validator-empty">Apri questa schermata dopo aver caricato il wallet.</div>'; return; }
  if(!rows.length){ host.innerHTML='<div class="validator-empty">Nessun ritiro reward trovato nelle transazioni disponibili.</div>'; return; }
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
    return `<div class="validator-row"><div class="validator-name"><strong>${escapeHtml(v.moniker)}</strong><small>${escapeHtml(shortOperator(v.operator))}</small></div><div class="validator-stat"><strong>${inj(v.amount,3)} INJ</strong><small>delegati</small></div><div class="validator-stat"><strong>${(v.commission*100).toFixed(2)}%</strong><small>commissione · APR ${netApr.toFixed(2)}% · ${inj(daily,6)}/g</small></div></div>`;
  }).join('');
}
function escapeHtml(value){ return String(value??'').replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch])); }

function render(){
  const total=state.available+state.staked+state.rewards; const nw=total*state.price;
  setText('priceUsd',money(state.price)); setText('priceChange',`24h ${state.change>=0?'+':''}${state.change.toFixed(2)}%`);
  if($('priceChange')) $('priceChange').className=`secondary-value ${state.change>0?'up':state.change<0?'down':''}`;
  setText('priceDirection',state.change>0?'▲':state.change<0?'▼':'—'); if($('priceDirection')) $('priceDirection').className=state.change>0?'up':state.change<0?'down':'';
  setText('dayLow',`L ${money(state.low)}`); setText('dayHigh',`H ${money(state.high)}`);
  setText('availableInj',inj(state.available)); setText('availableUsd',money(state.available*state.price));
  setText('stakedInj',inj(state.staked,4)); setText('stakedUsd',money(state.staked*state.price));
  setText('rewardsInj',inj(state.rewards)); setText('rewardsUsd',money(state.rewards*state.price));
  setText('netWorthUsd',money(nw)); setText('netWorthInj',`${inj(total,4)} INJ`); setText('portfolioNetWorth',money(nw)); setText('portfolioTotalInj',`${inj(total,4)} INJ`); setText('portfolioApr',state.apr?`${state.apr.toFixed(3)}%`:'—'); setText('portfolioRewards',`${inj(state.rewards)} INJ`); setText('portfolioRewardsUsd',money(state.rewards*state.price));
  setText('aprValue',state.apr?`${state.apr.toFixed(3)}%`:'—');
  setText('marketCapValue',state.marketCap?compactUsd(state.marketCap):'—'); setText('marketCapRank',state.marketRank?`Rank #${state.marketRank} · CoinGecko`:'CoinGecko');
  setText('commissionValue',state.validators.length?`${(state.weightedCommission*100).toFixed(2)}%`:'—'); setText('networkAprValue',state.networkApr?`APR rete lordo ${state.networkApr.toFixed(3)}%`:'APR rete lordo —');
  const daily=state.staked*(state.apr/100)/365; setText('portfolioDaily',state.apr?`${inj(daily,6)} INJ/giorno`:'— INJ/giorno'); setText('dailyEstimate',state.apr?`${inj(daily,6)} INJ/giorno`:'— INJ/giorno');
  setText('reward6h',`${inj(daily/4,7)} INJ`); setText('reward1d',`${inj(daily,7)} INJ`); setText('reward1w',`${inj(daily*7,6)} INJ`); setText('reward1m',`${inj(daily*30.4375,5)} INJ`); setText('reward1y',`${inj(daily*365,4)} INJ`);
  setText('aprMethod',state.apr?`APR netto ponderato: emissione on-chain, community tax ${(state.communityTax*100).toFixed(2)}% e commissioni dei validator. Le fee di rete e l’uptime possono far variare leggermente il risultato reale.`:'APR calcolato dai dati on-chain e al netto delle commissioni.');
  renderValidators(); renderRewardHistory();

}

function chartRows(values){
  return (values||[]).map((row,index)=>typeof row==='number'?{t:index,v:number(row)}:{t:number(row?.t)||index,v:number(row?.v)}).filter(row=>Number.isFinite(row.v));
}
function defaultVisibleCount(chartId,total,tf=state.timeframe){
  if(total<=2) return total;
  if(chartId!=='marketChart') return Math.min(total,120);
  const counts={ '1h':60, '24h':96, '7d':72, '1m':90, '1y':90, 'all':104 };
  return Math.min(total,counts[tf]||96);
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
  const opts=tf==='1h'||tf==='24h'?{hour:'2-digit',minute:'2-digit'}:tf==='7d'||tf==='1m'?{day:'2-digit',month:'short',hour:'2-digit'}:{day:'2-digit',month:'short',year:'numeric'};
  return new Intl.DateTimeFormat('it-IT',opts).format(new Date(timestamp));
}
function bindInteractiveChart(canvasId,tooltipId,getRows,type){
  const canvas=$(canvasId),tip=$(tooltipId); if(!canvas||!tip) return;
  const isTouch=()=>window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints>0;
  let pointerId=null,startX=0,lastX=0,dragging=false;
  const showHover=(clientX,clientY)=>{
    const slice=getChartSlice(canvasId,getRows()); const rows=slice.visible; if(!rows.length) return;
    const rect=canvas.getBoundingClientRect(); const x=Math.max(0,Math.min(rect.width,clientX-rect.left));
    const index=Math.max(0,Math.min(rows.length-1,Math.round((x/rect.width)*(rows.length-1)))); const row=rows[index]; state.hover[canvasId]={index};
    const left=Math.max(65,Math.min(rect.width-65,10+(rows.length===1?.5:index/(rows.length-1))*(rect.width-20))); tip.style.left=`${left}px`; tip.style.top=`${Math.max(48,clientY-rect.top)}px`;
    const label=formatHoverDate(row.t,type==='market'?state.timeframe:'1m'); tip.innerHTML=`<strong>${money(row.v)}</strong><span>${label}</span>`; tip.classList.add('show'); drawAll();
  };
  canvas.addEventListener('pointerdown',e=>{
    pointerId=e.pointerId; startX=lastX=e.clientX; dragging=false;
    canvas.setPointerCapture?.(pointerId);
    if(!isTouch()) canvas.classList.add('grabbing');
    showHover(e.clientX,e.clientY);
  });
  canvas.addEventListener('pointermove',e=>{
    if(isTouch()){
      if(pointerId!==null&&e.pointerId===pointerId) showHover(e.clientX,e.clientY);
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
      } else showHover(e.clientX,e.clientY);
    } else showHover(e.clientX,e.clientY);
  });
  const finish=e=>{
    if(pointerId!==null&&(!e||e.pointerId===pointerId)){
      try{canvas.releasePointerCapture?.(pointerId)}catch{}
      pointerId=null; canvas.classList.remove('grabbing');
      if(e) showHover(e.clientX,e.clientY);
      dragging=false;
    }
  };
  canvas.addEventListener('pointerup',finish); canvas.addEventListener('pointercancel',finish);
  canvas.addEventListener('pointerleave',()=>{ if(pointerId===null&&!isTouch()){delete state.hover[canvasId];tip.classList.remove('show');drawAll()} });
  canvas.addEventListener('wheel',e=>{
    if(isTouch()) return;
    e.preventDefault(); const total=chartRows(getRows()).length; const rect=canvas.getBoundingClientRect();
    if(e.ctrlKey||e.metaKey){ zoomChart(canvasId,total,e.deltaY>0?1.18:.84,(e.clientX-rect.left)/rect.width); }
    else { const direction=(Math.abs(e.deltaX)>Math.abs(e.deltaY)?e.deltaX:e.deltaY); panChart(canvasId,total,Math.sign(direction)*Math.max(1,Math.round(Math.abs(direction)/18))); }
  },{passive:false});
  canvas.addEventListener('dblclick',()=>{ resetChartView(canvasId,chartRows(getRows()).length,type==='market'?state.timeframe:'1m'); drawAll(); });
}

function loadWallet(){ const value=$('addressInput').value.trim(); if(!validAddress(value)){ toast('Indirizzo non valido'); return; } state.address=value; state.netWorthHistory=normalizeHistory(storage.getJSON(netWorthHistoryKey(value),[])).slice(-HISTORY.netWorthLimit); state.rewardHistory=[]; state.rewardHistoryLoaded=false; state.rewardHistoryNextKey=''; clearInterval(state.accountTimer); loadAccount(); state.accountTimer=setInterval(()=>loadAccount(false),30000); }
function initEvents(){
  document.querySelectorAll('.view-tab').forEach(btn=>btn.addEventListener('click',()=>switchView(btn.dataset.view)));
  $('timeframeTabs')?.addEventListener('click',event=>{ const btn=event.target.closest('button[data-tf]'); if(!btn) return; event.preventDefault(); loadMarketTimeframe(btn.dataset.tf); });
  bindInteractiveChart('netWorthChart','netWorthTooltip',()=>state.netWorthHistory,'networth');
  bindInteractiveChart('marketChart','marketTooltip',()=>state.marketCandles.map(x=>({t:x.t,v:x.c})),'market');
  $('refreshWithdrawals')?.addEventListener('click',()=>loadRewardHistory({append:false})); $('loadMoreWithdrawals')?.addEventListener('click',()=>loadRewardHistory({append:true}));
  $('loadButton')?.addEventListener('click',loadWallet); $('addressInput')?.addEventListener('keydown',e=>{if(e.key==='Enter')loadWallet()});
  $('themeButton')?.addEventListener('click',()=>{ document.body.classList.toggle('light'); storage.set('inj_theme',document.body.classList.contains('light')?'light':'dark'); drawAll(); });
  $('privacyButton')?.addEventListener('click',()=>document.body.classList.toggle('privacy'));
  window.addEventListener('resize',()=>requestAnimationFrame(drawAll)); window.addEventListener('online',()=>{status('','Riconnessione…');loadMarket();if(state.address)loadAccount(false)}); window.addEventListener('offline',()=>status('offline','Offline'));
}
function init(){
  state.priceHistory=normalizeHistory(storage.getJSON(HISTORY.priceKey,[])).slice(-HISTORY.priceLimit); state.timeframe=storage.get('inj_timeframe_v4','24h'); state.marketCandles=storage.getJSON(`inj_market_${state.timeframe}_v4`,[]);
  const saved=storage.get('inj_address',''); $('addressInput').value=saved;
  if(validAddress(saved)) state.netWorthHistory=normalizeHistory(storage.getJSON(netWorthHistoryKey(saved),[])).slice(-HISTORY.netWorthLimit);
  if(storage.get('inj_theme','dark')==='light') document.body.classList.add('light');
  initEvents(); render(); renderMarket(); loadMarket(); loadMarketTimeframe(state.timeframe); connectPriceSocket();
  if(validAddress(saved)){ state.address=saved; loadAccount(false); state.accountTimer=setInterval(()=>loadAccount(false),30000); }
}

document.addEventListener('DOMContentLoaded',init);
