const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 4317;
const CACHE_FILE = path.join(__dirname, 'prices-cache.json');

// Disk cache: { "YYYY": { "entry": {TICKER: close}, "exit": {TICKER: close} } }
function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) { return {}; }
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
// Try Stooq first (needs apikey); fall back to Nasdaq public API (covers ~2016+).
// Cache per (year, ticker) on disk; hit upstream ≤1x per ticker per year.
async function getYearEndpoints(year, ticker) {
  const ykey = String(year);
  if (!priceCache[ykey]) priceCache[ykey] = { entry: {}, exit: {} };
  const slot = priceCache[ykey];
  if (slot.entry[ticker] != null && slot.exit[ticker] != null) return slot;

  if (STOOQ_APIKEY) {
    const body = await stooqHistorical(ticker.toLowerCase(), `${year}0101`, `${year}1231`);
    const rows = parseCsvRows(body);
    if (rows.length) {
      slot.entry[ticker] = rows[0].close;
      slot.exit[ticker] = rows[rows.length - 1].close;
      slot.entryDate = slot.entryDate || rows[0].date;
      slot.exitDate = rows[rows.length - 1].date;
      saveCache(priceCache);
      return slot;
    }
  }

  // Nasdaq fallback (no apikey; ~10-year window). Skip for very old years.
  const today = new Date().toISOString().slice(0, 10);
  const currentYear = new Date().getUTCFullYear();
  if (year < currentYear - 10) return slot; // Nasdaq won't have it
  try {
    const fromIso = `${year}-01-02`;
    const toIso = year >= currentYear ? today : `${year}-12-31`;
    const rows = await nasdaqHistory(ticker, fromIso, toIso);
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

async function nasdaqLatestCsv(ticker) {
  // Pull last ~10 days from Nasdaq, return single CSV row for the most-recent close.
  const today = new Date().toISOString().slice(0, 10);
  const past = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  try {
    const rows = await nasdaqHistory(ticker.toUpperCase(), past, today);
    if (!rows.length) return null;
    const r = rows[rows.length - 1];
    return `Date,Open,High,Low,Close,Volume\n${r.date},${r.close},${r.close},${r.close},${r.close},0\n`;
  } catch (_) { return null; }
}

app.get('/api/stooq', async (req, res) => {
  const { ticker, from, to, mode } = req.query;
  if (!ticker) return res.status(400).send('ticker required');
  const t = String(ticker).toLowerCase();

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');

  try {
    // Latest snapshot path: Stooq → Nasdaq fallback (Stooq blocks some cloud IPs).
    if (!from && !to && mode !== 'history') {
      const csv = await stooqLatest(t);
      if (csv) {
        const lines = csv.trim().split(/\r?\n/);
        if (lines.length >= 2) return res.send(csv);
      }
      const ndCsv = await nasdaqLatestCsv(t);
      if (ndCsv) return res.send(ndCsv);
      return res.send('Date,Open,High,Low,Close,Volume\n');
    }
    const body = await stooqHistorical(t, from, to);
    // Detect the "Get your apikey" plain-text gate
    if (body.startsWith('Get your apikey')) {
      return res.status(200).send('Date,Open,High,Low,Close,Volume\n');
    }
    res.send(body);
  } catch (e) {
    res.status(502).send('proxy error: ' + e.message);
  }
});

app.get('/api/status', (_req, res) => {
  res.json({ hasApikey: Boolean(STOOQ_APIKEY), cacheYears: Object.keys(priceCache) });
});

// /api/annual?year=2025&tickers=AAPL,MSFT,...
// Returns { year, entryDate, exitDate, entry:{...}, exit:{...}, missing:[...] }
app.get('/api/annual', async (req, res) => {
  const year = parseInt(req.query.year, 10);
  const tickers = String(req.query.tickers || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!year || !tickers.length) return res.status(400).json({ error: 'year + tickers required' });

  const missing = [];
  for (const t of tickers) {
    try {
      const slot = await getYearEndpoints(year, t);
      if (slot.entry[t] == null || slot.exit[t] == null) missing.push(t);
    } catch (e) { missing.push(t); }
  }
  const slot = priceCache[String(year)] || { entry: {}, exit: {} };
  const entry = {}, exit = {};
  for (const t of tickers) {
    if (slot.entry[t] != null) entry[t] = slot.entry[t];
    if (slot.exit[t] != null) exit[t] = slot.exit[t];
  }
  res.json({
    year,
    entryDate: slot.entryDate || null,
    exitDate: slot.exitDate || null,
    entry, exit, missing,
    hasApikey: Boolean(STOOQ_APIKEY)
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

app.get('/api/history', async (req, res) => {
  const year = parseInt(req.query.year, 10);
  const tickers = String(req.query.tickers || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!year || !tickers.length) return res.status(400).json({ error: 'year + tickers required' });

  const today = new Date().toISOString().slice(0, 10);
  const from = `${year}-01-02`;
  const cacheKey = `${year}:${tickers.sort().join(',')}`;
  const cacheEntry = historyCache[cacheKey];
  const cacheAge = cacheEntry ? (Date.now() - cacheEntry.ts) : Infinity;
  const hoursStale = cacheAge / 3_600_000;

  // Reuse cache if < 6h old
  if (cacheEntry && hoursStale < 6) {
    return res.json(cacheEntry.payload);
  }

  try {
    const series = {};
    for (const t of tickers) {
      series[t] = await nasdaqHistory(t, from, today);
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

    const payload = { year, from, to: today, points };
    historyCache[cacheKey] = { ts: Date.now(), payload };
    saveHistoryCache();
    res.json(payload);
  } catch (e) {
    res.status(502).json({ error: e.message, points: [] });
  }
});

// Manual cache override: POST /api/cache body { year, entry:{T:price}, exit:{T:price} }
app.use(express.json());
app.post('/api/cache', (req, res) => {
  const { year, entry, exit, entryDate, exitDate } = req.body || {};
  if (!year) return res.status(400).json({ error: 'year required' });
  const ykey = String(year);
  if (!priceCache[ykey]) priceCache[ykey] = { entry: {}, exit: {} };
  if (entry) Object.assign(priceCache[ykey].entry, entry);
  if (exit) Object.assign(priceCache[ykey].exit, exit);
  if (entryDate) priceCache[ykey].entryDate = entryDate;
  if (exitDate) priceCache[ykey].exitDate = exitDate;
  saveCache(priceCache);
  res.json({ ok: true, year: priceCache[ykey] });
});

app.use(express.static(__dirname));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  console.log(`S&P Five dashboard on http://localhost:${PORT}`);
});
