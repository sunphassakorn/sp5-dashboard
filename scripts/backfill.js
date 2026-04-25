#!/usr/bin/env node
// One-shot: fetch Jan 2 (entry) + Dec 31 (exit) closes per year per ticker via Nasdaq API.
// Nasdaq public data goes back ~10 years. Writes prices-cache.json at project root.
// Run: `node scripts/backfill.js` once per year (after new-year Top 5 published).

const fs = require('fs');
const path = require('path');
const https = require('https');

const CACHE_FILE = path.join(__dirname, '..', 'prices-cache.json');

const TOP5_BY_YEAR = {
  2016: ["AAPL","GOOG","MSFT","BRK-B","XOM"],
  2017: ["AAPL","GOOG","MSFT","AMZN","BRK-B"],
  2018: ["AAPL","GOOG","MSFT","AMZN","BRK-B"],
  2019: ["MSFT","AAPL","AMZN","GOOG","BRK-B"],
  2020: ["MSFT","AAPL","AMZN","GOOG","FB"],
  2021: ["AAPL","MSFT","AMZN","GOOG","TSLA"],
  2022: ["AAPL","MSFT","AMZN","GOOG","TSLA"],
  2023: ["AAPL","MSFT","AMZN","NVDA","GOOG"],
  2024: ["MSFT","AAPL","NVDA","AMZN","GOOG"],
  2025: ["NVDA","AAPL","MSFT","AMZN","GOOG"],
  2026: ["AAPL","MSFT","NVDA","AMZN","GOOG"]
};

// Map display ticker → Nasdaq symbol
const NASDAQ_SYM = {
  "BRK-B": "BRK.B",
  "FB": "META" // Meta was FB before 2022; Nasdaq only has META data in range
};

// Asset class per ticker
const ASSET_CLASS = { SPY: 'etf' };

function classOf(t) { return ASSET_CLASS[t] || 'stocks'; }
function nasdaqSym(t) { return NASDAQ_SYM[t] || t; }

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
  });
}

async function fetchRange(ticker, fromDate, toDate) {
  const sym = encodeURIComponent(nasdaqSym(ticker));
  const url = `https://api.nasdaq.com/api/quote/${sym}/historical?assetclass=${classOf(ticker)}&fromdate=${fromDate}&todate=${toDate}&limit=10000`;
  const data = await fetchJson(url);
  const rows = (data.data || {}).tradesTable?.rows || [];
  return rows.map(r => ({
    date: r.date, // MM/DD/YYYY
    close: parseFloat((r.close || '').replace('$', '').replace(/,/g, ''))
  })).filter(r => !isNaN(r.close));
}

function parseDate(mdy) {
  const [m, d, y] = mdy.split('/');
  return `${y}-${m}-${d}`;
}

async function backfill() {
  const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
  const today = new Date().toISOString().slice(0, 10);

  const years = Object.keys(TOP5_BY_YEAR).map(Number).sort();
  const allTickers = new Set(['SPY']);
  years.forEach(y => TOP5_BY_YEAR[y].forEach(t => allTickers.add(t)));

  for (const ticker of allTickers) {
    const fromDate = '2016-01-01';
    const toDate = today;
    process.stdout.write(`fetching ${ticker}… `);
    let rows;
    try {
      rows = await fetchRange(ticker, fromDate, toDate);
    } catch (e) {
      console.log(`err: ${e.message}`);
      continue;
    }
    console.log(`${rows.length} rows`);
    // rows descending (newest first)
    rows.sort((a, b) => parseDate(a.date).localeCompare(parseDate(b.date)));

    for (const year of years) {
      const yrStart = `${year}-01-02`;
      const yrEnd = `${year}-12-31`;
      const inYear = rows.filter(r => {
        const iso = parseDate(r.date);
        return iso >= `${year}-01-01` && iso <= yrEnd;
      });
      if (!inYear.length) continue;
      const first = inYear[0];
      const last = inYear[inYear.length - 1];
      const ykey = String(year);
      if (!cache[ykey]) cache[ykey] = { entry: {}, exit: {} };
      cache[ykey].entry[ticker] = Number(first.close.toFixed(4));
      cache[ykey].exit[ticker] = Number(last.close.toFixed(4));
      if (!cache[ykey].entryDate) cache[ykey].entryDate = parseDate(first.date);
      cache[ykey].exitDate = parseDate(last.date);
    }
    await new Promise(r => setTimeout(r, 250)); // be nice
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  console.log(`\nwrote ${CACHE_FILE}`);
  console.log('years cached:', Object.keys(cache).sort().join(', '));
}

backfill().catch(e => { console.error(e); process.exit(1); });
