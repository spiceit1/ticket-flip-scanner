#!/usr/bin/env node
/**
 * SeatData Official API Module
 * 
 * Replaces the Playwright browser-scraping approach with direct REST API calls.
 * Much faster (~100ms per call vs 30+ seconds), no login sessions, no browser.
 * 
 * API Endpoints:
 *   GET /api/salesdata/get?event_id={stubhub_id}           → completed sales
 *   GET /api/v0.3.1/events/search?name={query}             → event search
 *   GET /api/v0.3.1/listings/get?event_id={stubhub_id}     → active listings
 * 
 * Pricing: $0.10/call for first 500, then cheaper. Only billed if data returned.
 * 
 * Setup:
 *   1. Log into seatdata.io → API Keys → Generate API Key
 *   2. Set SEATDATA_API_KEY env var OR store in .env or config file
 * 
 * Usage (standalone):
 *   SEATDATA_API_KEY=your_key node seatdata-api.js test
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────
const API_KEY = process.env.SEATDATA_API_KEY || (() => {
  // Try to read from a local .env file
  try {
    const envFile = path.join(__dirname, '.env');
    if (fs.existsSync(envFile)) {
      const lines = fs.readFileSync(envFile, 'utf8').split('\n');
      for (const line of lines) {
        const [k, v] = line.split('=');
        if (k?.trim() === 'SEATDATA_API_KEY') return v?.trim();
      }
    }
  } catch (e) {}
  return null;
})();

const BASE_URL = 'https://seatdata.io';
const CACHE_FILE = path.join(__dirname, 'seatdata-cache.json');
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours — don't re-hit API for same event within 2h

// ─── Cache ────────────────────────────────────────────────────────────────────
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {}
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'api-key': API_KEY || '',
        'Accept': 'application/json',
        'User-Agent': 'TicketScanner/2.0',
        ...headers,
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── Core API Functions ───────────────────────────────────────────────────────

/**
 * Get completed sales data for a StubHub event ID.
 * Returns array of zone-level sales with date, price, section, row, quantity.
 * 
 * This is the primary sell-benchmark data source.
 * Maps 1:1 to what we previously got from zone_sales in the seatdeals widget.
 */
async function getSalesData(stubhubEventId, { useCache = true } = {}) {
  if (!API_KEY) throw new Error('SEATDATA_API_KEY not set. Generate at seatdata.io → API Keys.');
  
  const cacheKey = `sales_${stubhubEventId}`;
  const cache = loadCache();
  
  if (useCache && cache[cacheKey]) {
    const age = Date.now() - cache[cacheKey].fetchedAt;
    if (age < CACHE_TTL_MS) {
      return { ...cache[cacheKey].data, cached: true, ageMs: age };
    }
  }
  
  const resp = await httpGet(`${BASE_URL}/api/salesdata/get?event_id=${stubhubEventId}`);
  
  if (resp.status === 401) throw new Error('Invalid API key');
  if (resp.status === 404) return { sales: [], eventId: stubhubEventId };
  if (resp.status !== 200) throw new Error(`SeatData API error: HTTP ${resp.status}`);
  
  let parsed;
  try {
    parsed = JSON.parse(resp.body);
  } catch (e) {
    throw new Error(`SeatData API: invalid JSON response`);
  }
  
  // Normalize the response (SeatData returns array of sale objects)
  const sales = Array.isArray(parsed) ? parsed : (parsed.sales || parsed.data || []);
  
  const result = {
    eventId: stubhubEventId,
    sales,
    totalCount: sales.length,
    fetchedAt: new Date().toISOString(),
  };
  
  // Cache it
  cache[cacheKey] = { data: result, fetchedAt: Date.now() };
  saveCache(cache);
  
  return result;
}

/**
 * Search for events by name/performer/team.
 * Returns event IDs + details for cross-referencing with buy-side platforms.
 */
async function searchEvents(query, { venue, city, dateFrom, dateTo } = {}) {
  if (!API_KEY) throw new Error('SEATDATA_API_KEY not set.');
  
  const params = new URLSearchParams({ name: query });
  if (venue) params.set('venue_name', venue);
  if (city) params.set('venue_city', city);
  if (dateFrom) params.set('date_from', dateFrom);
  if (dateTo) params.set('date_to', dateTo);
  
  const resp = await httpGet(`${BASE_URL}/api/v0.3.1/events/search?${params}`);
  if (resp.status !== 200) return [];
  
  try {
    const parsed = JSON.parse(resp.body);
    return Array.isArray(parsed) ? parsed : (parsed.events || parsed.results || []);
  } catch (e) {
    return [];
  }
}

/**
 * Get active listings for an event.
 * Used to find the current listing floor (sell benchmark component).
 */
async function getListings(stubhubEventId) {
  if (!API_KEY) throw new Error('SEATDATA_API_KEY not set.');
  
  const resp = await httpGet(`${BASE_URL}/api/v0.3.1/listings/get?event_id=${stubhubEventId}`);
  if (resp.status !== 200) return [];
  
  try {
    const parsed = JSON.parse(resp.body);
    return Array.isArray(parsed) ? parsed : (parsed.listings || parsed.data || []);
  } catch (e) {
    return [];
  }
}

/**
 * Analyze zone sales — same logic as analyzeZoneSales() in scanner.js.
 * Filters to matching quantity, last 7 days, min 3 sales required.
 */
function analyzeZoneSales(sales, quantity, targetZone) {
  const now = new Date();
  
  const last7 = (sales || []).filter(s => {
    if (Number(s.quantity) !== Number(quantity)) return false;
    const daysAgo = (now - new Date(s.date)) / (1000 * 60 * 60 * 24);
    if (daysAgo > 7) return false;
    // Zone tier matching
    if (targetZone && s.section) {
      const normTarget = targetZone.toLowerCase().replace(/\s+/g, ' ').trim();
      const normSale = s.section.toLowerCase().replace(/\s+/g, ' ').trim();
      if (normTarget !== normSale) {
        const targetHasPlus = normTarget.includes('plus') || normTarget.includes('+');
        const saleHasPlus = normSale.includes('plus') || normSale.includes('+');
        if (targetHasPlus !== saleHasPlus) return false;
      }
    }
    return true;
  })
  .sort((a, b) => new Date(b.date) - new Date(a.date))
  .slice(0, 15);
  
  if (last7.length < 3) return null;
  
  const avg = last7.reduce((sum, s) => sum + Number(s.price), 0) / last7.length;
  const floor = Math.min(...last7.map(s => Number(s.price)));
  
  return {
    avg,
    floor,
    count: last7.length,
    sales: last7,
  };
}

// ─── Main Integration Point ────────────────────────────────────────────────────
/**
 * getSeatDataForDeal(deal) — Drop-in replacement for the seatdeals widget approach.
 * 
 * Given a deal with a stubhub_event_id (from Gametime, TickPick, or any source),
 * returns zone_sales compatible with the existing scanner.js analyzeZoneSales() logic.
 * 
 * Usage in scanner.js main loop:
 *   const zoneSales = await getSeatDataForDeal(deal);
 *   const salesAnalysis = analyzeZoneSales(zoneSales, deal.quantity, deal.zone);
 */
async function getSeatDataForDeal(deal) {
  const eventId = deal.event_id || deal.stubhub_event_id || deal.stubhubEventId;
  if (!eventId) return [];
  
  try {
    const result = await getSalesData(eventId);
    return result.sales || [];
  } catch (e) {
    console.error(`SeatData API error for event ${eventId}: ${e.message}`);
    return [];
  }
}

// ─── CLI Test Mode ────────────────────────────────────────────────────────────
if (require.main === module) {
  const testEventId = process.argv[2] === 'test' ? '158109709' : process.argv[2];
  
  if (!API_KEY) {
    console.log('❌ No API key set.');
    console.log('');
    console.log('To set up:');
    console.log('  1. Log into seatdata.io → API Keys → Generate API Key');
    console.log('  2. Add to deal-scanner/.env:');
    console.log('     SEATDATA_API_KEY=your_64_char_key');
    console.log('  3. Run: node seatdata-api.js test');
    process.exit(1);
  }
  
  (async () => {
    console.log(`Testing SeatData API with event_id: ${testEventId}...`);
    const result = await getSalesData(testEventId, { useCache: false });
    console.log(`\nResult: ${result.totalCount} sales for event ${testEventId}`);
    if (result.sales?.length > 0) {
      console.log('Sample:', JSON.stringify(result.sales.slice(0, 3), null, 2));
    }
  })().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { getSalesData, searchEvents, getListings, analyzeZoneSales, getSeatDataForDeal };
