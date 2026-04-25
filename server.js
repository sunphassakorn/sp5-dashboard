const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 4317;
const CACHE_FILE = path.join(__dirname, 'prices-cache.json');

// Disk cache: { country: { "YYYY": { entry:{TICKER:close}, exit:{...} } } }
// Legacy shape (year keys at root) is auto-migrated to { us: {...} } on load.
function loadCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {};
    const looksLegacy = Object.keys(raw).length && Object.keys(raw).every(k => /^\d{4}$/.test(k));
    if (looksLegacy) return { us: raw, hk: {} };
    if (!raw.us) raw.us = {};
    if (!raw.hk) raw.hk = {};
    return raw;
  } catch (_) { return { us: {}, hk: {} }; }
}
function saveCache(c) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2)); } catch (e) { console.error('cache save err:', e.message); }
}
let priceCache = loadCache();

const STOOQ_APIKEY = process.env.STOOQ_APIKEY || '';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function stooqLatest(t) {
  // Live snapshot endpoint, no apikey needed.
  // Returns: Symbol,Date,Time,Open,High,Low,Close,Volume
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(t)}.us&f=sd2t2ohlcv&h&e=csv`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/csv,*/*' } });
  const body = await r.text();
  const lines = body.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const cols = lines[1].split(',');
  if (cols.length < 7) return null;
  const date = cols[1];
  const close = cols[6];
  if (!date || !close || isNaN(parseFloat(close))) return null;
  return `Date,Open,High,Low,Close,Volume\n${date},${cols[3]},${cols[4]},${cols[5]},${close},${cols[7] || 0}\n`;
}

async function stooqHistorical(t, from, to) {
  let url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(t)}.us&i=d`;
  if (from && to) url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(t)}.us&d1=${from}&d2=${to}&i=d`;
  else if (from) url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(t)}.us&d1=${from}&i=d`;
  if (STOOQ_APIKEY) url += `&apikey=${encodeURIComponent(STOOQ_APIKEY)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/csv,*/*' } });
  return await r.text();
}

function parseCsvRows(text) {
  if (!text || text.startsWith('Get your apikey')) return [];
  const lines = text.trim().split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < 5) continue;
    const close = parseFloat(c[4]);
    if (isNaN(close)) continue;
    rows.push({ date: c[0], close });
  }
  return rows;
}

// Fetch first trading close on/after Jan 2 and last trading close on/before Dec 31.
// US uses Nasdaq public API (~2016+), HK uses Yahoo Finance (HKEX has no free
// public historical CSV). Cache per (country, year, ticker) on disk.
async function getYearEndpoints(year, ticker, country = 'us') {
  if (!priceCache[country]) priceCache[country] = {};
  const ykey = String(year);
  if (!priceCache[country][ykey]) priceCache[country][ykey] = { entry: {}, exit: {} };
  const slot = priceCache[country][ykey];
  if (slot.entry[ticker] != null && slot.exit[ticker] != null) return slot;

  const today = new Date().toISOString().slice(0, 10);
  const currentYear = new Date().getUTCFullYear();
  if (year < currentYear - 12) return slot;

  const histFn = getCountryHistoryFn(country);
  try {
    const fromIso = `${year}-01-02`;
    const toIso = year >= currentYear ? today : `${year}-12-31`;
    const rows = await histFn(ticker, fromIso, toIso);
    if (rows.length) {
      slot.entry[ticker] = Number(rows[0].close.toFixed(4));
      slot.exit[ticker] = Number(rows[rows.length - 1].close.toFixed(4));
      slot.entryDate = slot.entryDate || rows[0].date;
      slot.exitDate = rows[rows.length - 1].date;
      saveCache(priceCache);
    }
  } catch (_) {}
  return slot;
}

async function latestCsv(ticker, country = 'us') {
  const today = new Date().toISOString().slice(0, 10);
  const past = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const histFn = getCountryHistoryFn(country);
  try {
    const rows = await histFn(country === 'us' ? ticker.toUpperCase() : ticker, past, today);
    if (!rows.length) return null;
    const r = rows[rows.length - 1];
    return `Date,Open,High,Low,Close,Volume\n${r.date},${r.close},${r.close},${r.close},${r.close},0\n`;
  } catch (_) { return null; }
}

// Latest close. Endpoint name kept (`/api/stooq`) for backwards compatibility,
// but the actual upstream is Nasdaq for US and Yahoo for HK — no Stooq.
app.get('/api/stooq', async (req, res) => {
  const ticker = req.query.ticker;
  const country = (req.query.country === 'hk') ? 'hk' : 'us';
  if (!ticker) return res.status(400).send('ticker required');
  const t = String(ticker);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');
  try {
    const csv = await latestCsv(t, country);
    if (csv) return res.send(csv);
    res.send('Date,Open,High,Low,Close,Volume\n');
  } catch (e) {
    res.status(502).send('proxy error: ' + e.message);
  }
});

app.get('/api/status', (_req, res) => {
  res.json({
    countries: ['us', 'hk'],
    cacheYears: {
      us: Object.keys(priceCache.us || {}).sort(),
      hk: Object.keys(priceCache.hk || {}).sort()
    }
  });
});

// /api/annual?year=2025&tickers=AAPL,MSFT,...
// Returns { year, entryDate, exitDate, entry:{...}, exit:{...}, missing:[...] }
app.get('/api/annual', async (req, res) => {
  const year = parseInt(req.query.year, 10);
  const country = (req.query.country === 'hk') ? 'hk' : 'us';
  const tickers = String(req.query.tickers || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!year || !tickers.length) return res.status(400).json({ error: 'year + tickers required' });

  const missing = [];
  for (const t of tickers) {
    try {
      const slot = await getYearEndpoints(year, t, country);
      if (slot.entry[t] == null || slot.exit[t] == null) missing.push(t);
    } catch (e) { missing.push(t); }
  }
  const slot = (priceCache[country] || {})[String(year)] || { entry: {}, exit: {} };
  const entry = {}, exit = {};
  for (const t of tickers) {
    if (slot.entry[t] != null) entry[t] = slot.entry[t];
    if (slot.exit[t] != null) exit[t] = slot.exit[t];
  }
  res.json({
    year, country,
    entryDate: slot.entryDate || null,
    exitDate: slot.exitDate || null,
    entry, exit, missing
  });
});

// Weekly YTD history via Nasdaq public API (cached to disk for the year).
const HISTORY_CACHE_FILE = path.join(__dirname, 'history-cache.json');
let historyCache = (function(){ try { return JSON.parse(fs.readFileSync(HISTORY_CACHE_FILE, 'utf8')); } catch(_) { return {}; } })();
function saveHistoryCache() { try { fs.writeFileSync(HISTORY_CACHE_FILE, JSON.stringify(historyCache, null, 2)); } catch(_){} }

function nasdaqSymFor(t) { if (t === 'BRK-B') return 'BRK.B'; if (t === 'FB') return 'META'; return t; }
function nasdaqClassFor(t) { return t === 'SPY' ? 'etf' : 'stocks'; }

async function nasdaqHistory(ticker, fromIso, toIso) {
  const sym = encodeURIComponent(nasdaqSymFor(ticker));
  const url = `https://api.nasdaq.com/api/quote/${sym}/historical?assetclass=${nasdaqClassFor(ticker)}&fromdate=${fromIso}&todate=${toIso}&limit=10000`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  const j = await r.json();
  const rows = (j.data || {}).tradesTable?.rows || [];
  return rows.map(r => {
    const [m, d, y] = r.date.split('/');
    return { date: `${y}-${m}-${d}`, close: parseFloat((r.close || '').replace('$', '').replace(/,/g, '')) };
  }).filter(r => !isNaN(r.close)).sort((a, b) => a.date.localeCompare(b.date));
}

// Yahoo Finance v8 chart (used for HK tickers). HKEX itself does not publish
// a free historical CSV endpoint; Yahoo is the de-facto public source.
async function yahooHistory(ticker, fromIso, toIso) {
  const p1 = Math.floor(new Date(fromIso + 'T00:00:00Z').getTime() / 1000);
  const p2 = Math.floor(new Date(toIso + 'T23:59:59Z').getTime() / 1000);
  const sym = ticker.endsWith('.HK') ? ticker : ticker + '.HK';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d&events=history`;
  let j;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    j = await r.json();
  } catch (e) {
    console.error('yahoo fetch err', sym, e.message);
    return [];
  }
  if (j?.chart?.error) {
    console.error('yahoo err', sym, JSON.stringify(j.chart.error));
    return [];
  }
  const result = j?.chart?.result?.[0];
  if (!result) { console.error('yahoo no result', sym, JSON.stringify(j).slice(0, 200)); return []; }
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null || isNaN(c)) continue;
    const d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    out.push({ date: d, close: Number(c) });
  }
  return out;
}

function getCountryHistoryFn(country) { return country === 'hk' ? yahooHistory : nasdaqHistory; }

app.get('/api/history', async (req, res) => {
  const year = parseInt(req.query.year, 10);
  const country = (req.query.country === 'hk') ? 'hk' : 'us';
  const tickers = String(req.query.tickers || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!year || !tickers.length) return res.status(400).json({ error: 'year + tickers required' });

  const today = new Date().toISOString().slice(0, 10);
  const from = `${year}-01-02`;
  const cacheKey = `${country}:${year}:${tickers.sort().join(',')}`;
  const cacheEntry = historyCache[cacheKey];
  const cacheAge = cacheEntry ? (Date.now() - cacheEntry.ts) : Infinity;
  const hoursStale = cacheAge / 3_600_000;

  // Reuse cache if < 6h old
  if (cacheEntry && hoursStale < 6) {
    return res.json(cacheEntry.payload);
  }

  const histFn = getCountryHistoryFn(country);
  try {
    const series = {};
    for (const t of tickers) {
      series[t] = await histFn(t, from, today);
      await new Promise(r => setTimeout(r, 200));
    }
    // Build union of dates and weekly-sample
    const dateSet = new Set();
    Object.values(series).forEach(rows => rows.forEach(r => dateSet.add(r.date)));
    const allDates = [...dateSet].sort();
    const weeklyDates = [];
    let lastPicked = null;
    for (const d of allDates) {
      if (!lastPicked || (new Date(d) - new Date(lastPicked)) >= 7 * 86400000) {
        weeklyDates.push(d);
        lastPicked = d;
      }
    }
    if (allDates.length && weeklyDates[weeklyDates.length - 1] !== allDates[allDates.length - 1]) {
      weeklyDates.push(allDates[allDates.length - 1]);
    }

    const points = weeklyDates.map(d => {
      const closes = {};
      for (const t of tickers) {
        const rows = series[t] || [];
        let pick = null;
        for (const r of rows) { if (r.date <= d) pick = r; else break; }
        if (pick) closes[t] = pick.close;
      }
      return { date: d, closes };
    });

    const payload = { year, country, from, to: today, points };
    historyCache[cacheKey] = { ts: Date.now(), payload };
    saveHistoryCache();
    res.json(payload);
  } catch (e) {
    res.status(502).json({ error: e.message, points: [] });
  }
});

// Manual cache override: POST /api/cache body { year, country?, entry, exit }
app.use(express.json());
app.post('/api/cache', (req, res) => {
  const { year, entry, exit, entryDate, exitDate } = req.body || {};
  const country = (req.body?.country === 'hk') ? 'hk' : 'us';
  if (!year) return res.status(400).json({ error: 'year required' });
  if (!priceCache[country]) priceCache[country] = {};
  const ykey = String(year);
  if (!priceCache[country][ykey]) priceCache[country][ykey] = { entry: {}, exit: {} };
  if (entry) Object.assign(priceCache[country][ykey].entry, entry);
  if (exit) Object.assign(priceCache[country][ykey].exit, exit);
  if (entryDate) priceCache[country][ykey].entryDate = entryDate;
  if (exitDate) priceCache[country][ykey].exitDate = exitDate;
  saveCache(priceCache);
  res.json({ ok: true, country, year: priceCache[country][ykey] });
});

app.use(express.static(__dirname));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  console.log(`S&P Five dashboard on http://localhost:${PORT}`);
});
