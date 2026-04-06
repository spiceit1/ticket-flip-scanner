#!/usr/bin/env node
/**
 * Deal Scanner v2.0
 * Monitors SeatData for arbitrage opportunities and cross-references
 * multiple ticket platforms for the best all-in buy price.
 *
 * Data Sources:
 *   SELL BENCHMARK: SeatData completed sales (zone_sales from seatdeals widget + events_appstack)
 *   BUY SIDE:       TickPick (no fees!), SeatGeek, VividSeats, Gametime, StubHub, Ticketmaster, AXS
 *
 * SELL BENCHMARK = MIN(active listing floor in zone, completed sales avg)
 *   Buyers act on current listings. If listings dropped below historical avg, use listing floor.
 *   If completed avg is lower, market may correct down — use avg. Always use the LOWER one.
 *   List ticket BELOW current cheapest listing to guarantee a sale.
 *
 * ROI = ((sell_benchmark * 0.85) - best_all_in_buy) / best_all_in_buy * 100
 *
 * Delivery:
 *   EMAIL (primary): Rich HTML email via Gmail API (gog CLI) → ddweck14@gmail.com
 *   TELEGRAM (secondary): Short summary saved to latest-alerts.txt
 */

const { chromium } = require('playwright');
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { Client } = require('pg');

// ─── Dry Run Mode ────────────────────────────────────────────────────────────
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

// ─── DB Connection ───────────────────────────────────────────────────────────
const DB_URL = 'postgresql://neondb_owner:npg_QW2a7wnADpOs@ep-dry-term-advgll07-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require';

// ─── Config (defaults — overridden by DB on every run) ──────────────────────
const CONFIG = {
  email: {
    to: 'ddweck14@gmail.com',
    account: 'ddweck14@gmail.com',
  },
  seatdata: {
    email: 'ddweck14@gmail.com',
    password: 'Openclaw99!',
    baseUrl: 'https://seatdata.io',
  },
  fees: {
    stubhubBuyer: 0.30,
    seatgeekBuyer: 0.20,
    vividBuyer: 0.25,
    gametimeBuyer: 0.15,
    ticketmasterBuyer: 0.20,
    axsBuyer: 0.15,
    tickpickBuyer: 0,
    sellerFee: 0.15,
    stubhubSeller: 0.15,
    vividSeller: 0.10,
    seatgeekSeller: 0.10,
  },
  thresholds: {
    minROI: 20,
    minCompletedSales: 5,
    salesWindowDays: 7,
    maxSalesUsed: 15,
    minHoursOut: 48,
    maxDaysOut: 30,
    minQuantity: 2,
    floorDivergenceFlag: 0.50,
  },
  autoBuy: {
    enabled: false,
    minROI: 40,
    minSales: 5,
    maxCost: 200,
    minDaysOut: 7,
    maxDaysOut: 60,
  },
  scannerEnabled: true,
  topEventsEnabled: true,
  scanFrequencyMin: 20,
  autoList: {
    undercutMode: 'percent',
    undercutPct: 5,
    undercutDollars: 2,
  },
  paths: {
    dealsFile: path.join(__dirname, 'deals-found.json'),
    cookiesFile: path.join(__dirname, 'cookies.json'),
    logFile: path.join(__dirname, 'scanner.log'),
  },
};

// ─── Load Rules from DB ─────────────────────────────────────────────────────
async function loadRulesFromDB() {
  const client = new Client(DB_URL);
  try {
    await client.connect();
    const res = await client.query('SELECT * FROM mc_scanner_rules WHERE id = $1', ['default']);
    if (res.rows.length === 0) {
      log('⚠️  No rules found in mc_scanner_rules — using defaults');
      return;
    }
    const r = res.rows[0];

    // Fees
    CONFIG.fees.stubhubBuyer   = parseFloat(r.stubhub_buyer_fee)  || CONFIG.fees.stubhubBuyer;
    CONFIG.fees.tickpickBuyer  = parseFloat(r.tickpick_buyer_fee) || 0;
    CONFIG.fees.seatgeekBuyer  = parseFloat(r.seatgeek_buyer_fee) || CONFIG.fees.seatgeekBuyer;
    CONFIG.fees.vividBuyer     = parseFloat(r.vivid_buyer_fee)    || CONFIG.fees.vividBuyer;
    CONFIG.fees.gametimeBuyer  = parseFloat(r.gametime_buyer_fee) || CONFIG.fees.gametimeBuyer;
    CONFIG.fees.sellerFee      = parseFloat(r.seller_fee)         || CONFIG.fees.sellerFee;
    CONFIG.fees.stubhubSeller  = parseFloat(r.stubhub_seller_fee) || CONFIG.fees.stubhubSeller;
    CONFIG.fees.vividSeller    = parseFloat(r.vivid_seller_fee)   || CONFIG.fees.vividSeller;
    CONFIG.fees.seatgeekSeller = parseFloat(r.seatgeek_seller_fee)|| CONFIG.fees.seatgeekSeller;

    // Thresholds
    CONFIG.thresholds.minROI              = parseFloat(r.min_roi)              || CONFIG.thresholds.minROI;
    CONFIG.thresholds.minCompletedSales   = parseInt(r.min_completed_sales)    || CONFIG.thresholds.minCompletedSales;
    CONFIG.thresholds.salesWindowDays     = parseInt(r.sales_window_days)      || CONFIG.thresholds.salesWindowDays;
    CONFIG.thresholds.maxSalesUsed        = parseInt(r.max_sales_used)         || CONFIG.thresholds.maxSalesUsed;
    CONFIG.thresholds.minHoursOut         = parseFloat(r.min_hours_out)        || CONFIG.thresholds.minHoursOut;
    CONFIG.thresholds.maxDaysOut          = parseInt(r.max_days_out)           || CONFIG.thresholds.maxDaysOut;
    CONFIG.thresholds.floorDivergenceFlag = parseFloat(r.floor_divergence_flag)|| CONFIG.thresholds.floorDivergenceFlag;

    // Auto-buy
    CONFIG.autoBuy.enabled    = !!r.auto_buy_enabled;
    CONFIG.autoBuy.minROI     = parseFloat(r.auto_buy_min_roi)     || CONFIG.autoBuy.minROI;
    CONFIG.autoBuy.minSales   = parseInt(r.auto_buy_min_sales)     || CONFIG.autoBuy.minSales;
    CONFIG.autoBuy.maxCost    = parseFloat(r.auto_buy_max_cost)    || CONFIG.autoBuy.maxCost;
    CONFIG.autoBuy.minDaysOut = parseInt(r.auto_buy_min_days_out)  || CONFIG.autoBuy.minDaysOut;
    CONFIG.autoBuy.maxDaysOut = parseInt(r.auto_buy_max_days_out)  || CONFIG.autoBuy.maxDaysOut;

    // Scanner flags
    CONFIG.scannerEnabled    = r.scanner_enabled !== false;
    CONFIG.topEventsEnabled  = r.top_events_enabled !== false;
    CONFIG.scanFrequencyMin  = parseInt(r.scan_frequency_min)      || CONFIG.scanFrequencyMin;

    // Auto-list undercut settings
    CONFIG.autoList.undercutMode    = r.auto_list_undercut_mode    || CONFIG.autoList.undercutMode;
    CONFIG.autoList.undercutPct     = parseFloat(r.auto_list_undercut_pct) || CONFIG.autoList.undercutPct;
    CONFIG.autoList.undercutDollars = parseFloat(r.auto_list_undercut_dollars) || CONFIG.autoList.undercutDollars;

    log(`✅ Loaded rules from DB: minROI=${CONFIG.thresholds.minROI}%, minSales=${CONFIG.thresholds.minCompletedSales}, sellerFee=${CONFIG.fees.sellerFee}, window=${CONFIG.thresholds.salesWindowDays}d, maxDaysOut=${CONFIG.thresholds.maxDaysOut}`);
    log(`   Scanner enabled: ${CONFIG.scannerEnabled} | Top events: ${CONFIG.topEventsEnabled} | Auto-buy: ${CONFIG.autoBuy.enabled}`);
  } finally {
    await client.end();
  }
}

// ─── Deal Log DB Operations ─────────────────────────────────────────────────
async function checkDuplicateDeal(stubhubEventId, zone) {
  const client = new Client(DB_URL);
  try {
    await client.connect();
    const res = await client.query(
      'SELECT id FROM mc_deal_log WHERE stubhub_event_id = $1 AND zone = $2 AND status = $3',
      [stubhubEventId, zone, 'presented']
    );
    return res.rows.length > 0 ? res.rows[0].id : null;
  } finally {
    await client.end();
  }
}

async function writeDealLog(dealAlert, existingId) {
  if (DRY_RUN) {
    log(`  [DRY RUN] Would ${existingId ? 'update' : 'insert'} deal_log: ${dealAlert.eventName} / ${dealAlert.zone} — ROI ${dealAlert.roi.toFixed(1)}%`);
    return;
  }
  const client = new Client(DB_URL);
  try {
    await client.connect();
    if (existingId) {
      await client.query(`
        UPDATE mc_deal_log SET
          buy_price = $1, buy_platform = $2, buy_all_in = $3,
          sell_benchmark = $4, sell_benchmark_source = $5,
          roi_pct = $6, profit_est = $7, section = $8, row = $9,
          quantity = $10, scanner_data = $11, updated_at = NOW(),
          buy_url = $12
        WHERE id = $13
      `, [
        dealAlert.buyPrice, dealAlert.buyPlatform, dealAlert.buyAllIn,
        dealAlert.sellBenchmark, dealAlert.sellBenchmarkSource,
        dealAlert.roi, dealAlert.profit, dealAlert.section, dealAlert.row,
        dealAlert.quantity, JSON.stringify(dealAlert), dealAlert.checkoutUrl,
        existingId,
      ]);
      log(`  📝 Updated existing deal_log id=${existingId}`);
    } else {
      await client.query(`
        INSERT INTO mc_deal_log (
          deal_id, event_name, event_date, event_time, venue, zone,
          section, row, quantity, buy_price, buy_platform, buy_all_in,
          sell_benchmark, sell_benchmark_source, roi_pct, profit_est,
          source, status, scanner_data, found_at, updated_at,
          buy_url, event_url, stubhub_event_id
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW(),NOW(),$20,$21,$22
        )
      `, [
        dealAlert.id, dealAlert.eventName, dealAlert.eventDate, dealAlert.eventTime,
        dealAlert.venue, dealAlert.zone, dealAlert.section, dealAlert.row,
        dealAlert.quantity, dealAlert.buyPrice, dealAlert.buyPlatform, dealAlert.buyAllIn,
        dealAlert.sellBenchmark, dealAlert.sellBenchmarkSource, dealAlert.roi, dealAlert.profit,
        'scanner', 'presented', JSON.stringify(dealAlert),
        dealAlert.checkoutUrl, dealAlert.eventUrl, dealAlert.stubhubEventId || null,
      ]);
      log(`  📝 Inserted new deal_log: ${dealAlert.id}`);
    }
  } finally {
    await client.end();
  }
}

// ─── Outlier Filtering ──────────────────────────────────────────────────────
function filterOutliers(sales) {
  if (!sales || sales.length < 3) return sales || [];
  const prices = sales.map(s => parseFloat(s.price)).sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid];
  // Strip sales >2.5× median and <0.2× median
  return sales.filter(s => {
    const p = parseFloat(s.price);
    return p >= median * 0.2 && p <= median * 2.5;
  });
}

// ─── Canonical ROI Calculation ──────────────────────────────────────────────
function calculateROI(sellBenchmark, sellerFee, buyAllIn) {
  // roi = (sell_benchmark * (1 - seller_fee) - buy_all_in) / buy_all_in * 100
  return (sellBenchmark * (1 - sellerFee) - buyAllIn) / buyAllIn * 100;
}

// ─── Utilities ──────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(CONFIG.paths.logFile, line + '\n');
  } catch (e) {}
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        ...headers,
      },
      timeout: 15000,
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function daysUntil(dateStr) {
  const eventDate = new Date(dateStr + 'T23:59:59');
  const now = new Date();
  return Math.ceil((eventDate - now) / (1000 * 60 * 60 * 24));
}

// Returns fractional hours until event start (using actual event time when available)
function hoursUntil(dateStr, timeStr) {
  // Prefer exact event start time; fall back to end-of-day
  let eventDate;
  if (timeStr && /\d{2}:\d{2}/.test(timeStr)) {
    eventDate = new Date(`${dateStr.substring(0, 10)}T${timeStr.substring(0, 8)}`);
  } else {
    eventDate = new Date(dateStr.substring(0, 10) + 'T23:59:59');
  }
  const now = new Date();
  return (eventDate - now) / (1000 * 60 * 60);
}

function loadDeals() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG.paths.dealsFile, 'utf8'));
  } catch (e) {
    return { sentDeals: [], allDeals: [], lastRun: null };
  }
}

function saveDeals(data) {
  data.lastRun = new Date().toISOString();
  fs.writeFileSync(CONFIG.paths.dealsFile, JSON.stringify(data, null, 2));
}

// ─── SeatData Module ────────────────────────────────────────────────────────
async function loginSeatData(browser) {
  log('Logging into SeatData...');
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  await page.goto(`${CONFIG.seatdata.baseUrl}/login/`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"], input[name="email"], #email', CONFIG.seatdata.email);
  await page.fill('input[type="password"], input[name="password"], #password', CONFIG.seatdata.password);

  const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
  if (submitBtn) await submitBtn.click();
  await page.waitForTimeout(5000);

  const url = page.url();
  if (!url.includes('dashboard')) {
    throw new Error(`Login failed. Current URL: ${url}`);
  }
  log('SeatData login successful.');
  return { context, page };
}

async function getSeatDeals(page) {
  log('Fetching SeatDeals...');
  const data = await page.evaluate(async () => {
    const resp = await fetch('/api/seatdeals/widget');
    return await resp.json();
  });
  log(`Got ${data.deals?.length || 0} SeatDeals.`);
  return data.deals || [];
}

async function fetchZoneSalesForEvent(internalId, page) {
  // Fetch completed zone sales from SeatData for a given event (by internal SeatData ID)
  // Uses the same authenticated page session already open on seatdata.io
  // CORRECT endpoint discovered 2026-03-31: /api/salesdata?eventId={id}&zoneName=ALL
  // (old /api/zone_sales?event_id={id} was returning 404 since ~late March 2026)
  try {
    const data = await page.evaluate(async (eid) => {
      const resp = await fetch(`/api/salesdata?eventId=${eid}&zoneName=ALL`);
      if (!resp.ok) return null;
      return await resp.json();
    }, String(internalId));
    if (!data) return [];
    // Response is a flat array of sale objects
    const sales = Array.isArray(data) ? data : (data.sales || data.zone_sales || data.data || []);
    if (!Array.isArray(sales)) return [];
    return sales.map(s => ({
      timestamp: s.timestamp || s.date || s.created_at || '',
      quantity: parseInt(s.quantity) || 0,  // keep 0 for unknown — strict qty match will reject
      price: parseFloat(s.price) || 0,
      zone: s.zone || s.zone_name || '',
      section: s.section || s.sec || '',
      row: s.row || '',
    })).filter(s => s.price > 0);
  } catch (e) {
    return [];
  }
}

// Fetch zone-level active listing stats from SeatData Pro portal
// Returns { lowest_price, mean, median } for the most recent snapshot
async function fetchZoneActiveStats(internalId, zoneName, page) {
  try {
    const params = { eid: String(internalId), zone: zoneName };
    const data = await page.evaluate(async (p) => {
      const resp = await fetch(`/api/event_stats_zones?eventId=${p.eid}&zone=${encodeURIComponent(p.zone)}`);
      if (!resp.ok) return null;
      return await resp.json();
    }, params);
    if (!data || !Array.isArray(data) || data.length === 0) return null;
    // Latest entry = current data
    const latest = data[data.length - 1];
    return {
      lowestPrice: parseFloat(latest.lowest_price) || null,
      mean: parseFloat(latest.mean) || null,
      median: parseFloat(latest.median) || null,
    };
  } catch (e) {
    return null;
  }
}

async function getTopEvents(page, limit = 50) {
  log('Fetching top events from SeatData...');
  const data = await page.evaluate(async (lim) => {
    // Build DataTables query for events_appstack
    // Columns 0-3 (pin/icons) are NOT searchable/orderable; 4+ are
    // Must match the real page's DataTable params or API returns 500
    const params = new URLSearchParams();
    params.set('draw', '1');
    for (let i = 0; i <= 17; i++) {
      params.set(`columns[${i}][data]`, i.toString());
      params.set(`columns[${i}][name]`, '');
      params.set(`columns[${i}][searchable]`, i >= 4 ? 'true' : 'false');
      params.set(`columns[${i}][orderable]`, i >= 4 ? 'true' : 'false');
      params.set(`columns[${i}][search][value]`, '');
      params.set(`columns[${i}][search][regex]`, 'false');
    }
    params.set('order[0][column]', '5');
    params.set('order[0][dir]', 'asc');
    params.set('order[0][name]', '');
    params.set('start', '0');
    params.set('length', lim.toString());
    params.set('search[value]', '');
    params.set('search[regex]', 'false');
    params.set('showHistorical', 'false');
    params.set('showRecAddedAndActive', 'false');
    params.set('showPinnedEvents', 'false');
    params.set('_', Date.now().toString());

    const resp = await fetch(`/api/events_appstack?${params.toString()}`);
    return await resp.json();
  }, limit);

  // Parse the HTML-laden response into structured events
  const events = [];
  if (data?.data) {
    for (const row of data.data) {
      // SeatData column layout (confirmed 2026-03-26):
      // row[0] = internal ID, row[1] = Pin btn, row[2] = SH link, row[3] = TM btn,
      // row[4] = event name (plain text or HTML), row[5] = date, row[6] = time,
      // row[7] = venue, row[8] = N/A, row[9] = city, row[10] = country
      // NOTE: row[4] was previously row[3] before SeatData added the TM column
      const nameHtml = String(row[4] || '');
      const dateStr = String(row[5] || '');
      const venueStr = String(row[7] || '');

      // Extract event name from HTML
      // The appstack HTML often wraps the name in an anchor with a button badge inside.
      // Strategy: strip all tags, collect all text nodes, pick the longest meaningful one.
      const stripped = nameHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      // Prefer the text after the last '>' or the longest token >4 chars that isn't just "TM" etc
      const tokens = stripped.split(/\s+/).filter(t => t.length > 2);
      let name;
      if (tokens.length === 0) {
        name = '';
      } else if (tokens.length === 1 && tokens[0].length <= 4) {
        // Very short single token — likely a badge like "TM"; try full stripped
        name = stripped;
      } else {
        // Join tokens back — but skip short badges (<=4 chars) at the start
        const meaningful = tokens.filter((t, i) => i === 0 ? t.length > 4 : true);
        name = (meaningful.length > 0 ? meaningful : tokens).join(' ');
      }
      // Fallback: try anchor text specifically
      if (!name || name.length <= 4) {
        const anchorMatch = nameHtml.match(/title="([^"]+)"/i) || nameHtml.match(/data-name="([^"]+)"/i);
        if (anchorMatch) name = anchorMatch[1].trim();
      }

      // Extract StubHub event ID from links
      const shIdMatch = String(row[2] || '').match(/event\/(\d+)/);
      const stubhubEventId = shIdMatch ? shIdMatch[1] : null;

      // Skip placeholder events with no real name data
      const skipPatterns = ['not yet available', 'tm data', 'coming soon', 'tba'];
      const nameLower = name.toLowerCase();
      const isPlaceholder = skipPatterns.some(p => nameLower.includes(p));

      if (name && name.length > 5 && !isPlaceholder && dateStr) {
        // Clean date: "2026-03-24 (Tue)" → "2026-03-24"
        const cleanDate = dateStr.replace(/\s*\([^)]*\)\s*/g, '').trim().substring(0, 10);
        // Validate date is parseable
        if (cleanDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
          events.push({
            internalId: row[0],
            name,
            date: cleanDate,
            venue: venueStr.replace(/<[^>]+>/g, '').trim(),
            stubhubEventId,
          });
        }
      }
    }
  }
  log(`Parsed ${events.length} events from SeatData.`);
  return events;
}

// ─── TickPick Module ────────────────────────────────────────────────────────
async function searchTickPick(eventName, eventDate) {
  // Extract team/performer names for search
  const searchTerms = eventName
    .replace(/ at /gi, ' ')
    .replace(/ vs\.? /gi, ' ')
    .split(/\s+/)
    .slice(0, 3)
    .join(' ');

  try {
    const resp = await httpGet(
      `https://api.tickpick.com/1.0/events?performerName=${encodeURIComponent(searchTerms)}&limit=20`
    );
    if (resp.status !== 200) return [];
    const data = JSON.parse(resp.body);
    return data.events || [];
  } catch (e) {
    log(`TickPick search error: ${e.message}`);
    return [];
  }
}

async function getTickPickListings(eventId, page) {
  // Use Playwright page context to get listings (avoids auth issues)
  try {
    const data = await page.evaluate(async (eid) => {
      const resp = await fetch(`https://api.tickpick.com/1.0/listings/internal/event-v2/${eid}?trackView=false`);
      if (!resp.ok) return null;
      return await resp.json();
    }, eventId);

    if (!data?.listings) return [];

    // Build TickPick event URL
    const tpEventUrl = `https://www.tickpick.com/buy-tickets/${eventId}/`;

    return data.listings
      .filter(l => !l.d?.includes('pk')) // exclude parking
      .map(l => ({
        platform: 'TickPick',
        section: l.sid,
        row: l.r,
        quantity: l.q,
        price: l.p,           // TickPick: price = all-in, NO fees
        allInPrice: l.p,
        feeRate: 0,
        listingId: l.id,
        zone: l.lid || '',
        listingUrl: tpEventUrl,
        checkoutUrl: tpEventUrl,
      }));
  } catch (e) {
    log(`TickPick listings error: ${e.message}`);
    return [];
  }
}

function matchTickPickEvent(tpEvents, eventName, eventDate) {
  // Normalize date to YYYY-MM-DD
  const targetDate = eventDate.substring(0, 10);

  // Extract key terms from event name (team names)
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const targetTerms = normalize(eventName).split(/\s+/);

  let bestMatch = null;
  let bestScore = 0;

  for (const tpEvent of tpEvents) {
    const tpDate = (tpEvent.event_date || '').substring(0, 10);
    if (tpDate !== targetDate) continue;

    const tpTerms = normalize(tpEvent.event_name || '').split(/\s+/);
    let score = 0;
    for (const term of targetTerms) {
      if (tpTerms.some(t => t.includes(term) || term.includes(t))) score++;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = tpEvent;
    }
  }

  return bestMatch;
}

// ─── Multi-Platform Price Check ─────────────────────────────────────────────
// For platforms that are harder to scrape, we try API calls and fall back gracefully.

async function checkSeatGeekPrice(eventName, eventDate, section, page) {
  try {
    // SeatGeek has heavy Cloudflare. Try a lightweight approach via their mobile API.
    const searchQ = eventName.split(/\s+(at|vs\.?)\s+/i)[0].trim();
    const resp = await httpGet(
      `https://seatgeek.com/api/search?q=${encodeURIComponent(searchQ)}&per_page=5`,
      { 'Accept': 'application/json' }
    );
    if (resp.status === 200) {
      const data = JSON.parse(resp.body);
      // Process results if available
      return [];
    }
  } catch (e) {
    // SeatGeek blocked - expected with Cloudflare
  }
  return [];
}

async function checkVividSeatsPrice(eventName, eventDate, section) {
  try {
    // Vivid Seats API attempt
    const searchQ = eventName.split(/\s+(at|vs\.?)\s+/i)[0].trim();
    const resp = await httpGet(
      `https://www.vividseats.com/hermes/api/v1/listings?productionId=0&quantity=2`
    );
    if (resp.status === 200) {
      return [];
    }
  } catch (e) {}
  return [];
}

// ─── Gametime Module ─────────────────────────────────────────────────────────
// Uses Gametime's undocumented mobile API. No auth required; mobile UA is mandatory.
// Prices returned in CENTS — divide by 100 for dollars.
const GAMETIME_UA = 'Gametime/12.34.0 (iPhone; iOS 17.0; Scale/3.00)';
const GAMETIME_BASE = 'https://mobile.gametime.co/v1';

async function fetchGametimeListings(eventName, eventDate, quantity) {
  try {
    // ── 1. Infer category + location for Gametime's category-filtered API ────
    // Gametime's ?q= search ignores text; it returns popularity/geo results.
    // Best match strategy: use category + lat/lon near the venue city,
    // then match by name + date from the result set.
    const nameLower = (eventName || '').toLowerCase();

    // ── City-to-coordinates lookup for major US sports venues ────────────────
    // Maps team short names (lowercase) to their home city lat/lon.
    // Used to search Gametime near the correct city instead of always NYC.
    const TEAM_COORDS = {
      // NBA
      'hawks': { lat: 33.757, lon: -84.396 },         // Atlanta
      'celtics': { lat: 42.366, lon: -71.062 },        // Boston
      'nets': { lat: 40.683, lon: -73.976 },            // Brooklyn
      'hornets': { lat: 35.225, lon: -80.839 },         // Charlotte
      'bulls': { lat: 41.881, lon: -87.674 },           // Chicago
      'cavaliers': { lat: 41.496, lon: -81.688 },       // Cleveland
      'mavericks': { lat: 32.790, lon: -96.810 },       // Dallas
      'nuggets': { lat: 39.749, lon: -105.008 },        // Denver
      'pistons': { lat: 42.341, lon: -83.055 },         // Detroit
      'warriors': { lat: 37.768, lon: -122.388 },       // San Francisco
      'rockets': { lat: 29.751, lon: -95.362 },         // Houston
      'pacers': { lat: 39.764, lon: -86.156 },          // Indianapolis
      'clippers': { lat: 33.944, lon: -118.343 },       // Inglewood
      'lakers': { lat: 34.043, lon: -118.267 },         // Los Angeles
      'grizzlies': { lat: 35.138, lon: -90.051 },       // Memphis
      'heat': { lat: 25.781, lon: -80.187 },             // Miami
      'bucks': { lat: 43.045, lon: -87.917 },           // Milwaukee
      'timberwolves': { lat: 44.980, lon: -93.276 },    // Minneapolis
      'pelicans': { lat: 29.949, lon: -90.082 },        // New Orleans
      'knicks': { lat: 40.751, lon: -73.994 },          // New York
      'thunder': { lat: 35.463, lon: -97.515 },         // Oklahoma City
      'magic': { lat: 28.539, lon: -81.384 },           // Orlando
      '76ers': { lat: 39.901, lon: -75.172 },           // Philadelphia
      'suns': { lat: 33.446, lon: -112.071 },           // Phoenix
      'trail blazers': { lat: 45.532, lon: -122.667 },  // Portland
      'blazers': { lat: 45.532, lon: -122.667 },        // Portland (alt)
      'kings': { lat: 38.580, lon: -121.500 },          // Sacramento
      'spurs': { lat: 29.427, lon: -98.438 },           // San Antonio
      'raptors': { lat: 43.643, lon: -79.379 },         // Toronto
      'jazz': { lat: 40.768, lon: -111.901 },           // Salt Lake City
      'wizards': { lat: 38.898, lon: -77.021 },         // Washington DC
      // NHL
      'ducks': { lat: 33.808, lon: -117.877 },          // Anaheim
      'coyotes': { lat: 33.532, lon: -112.063 },        // Arizona
      'bruins': { lat: 42.366, lon: -71.062 },          // Boston
      'sabres': { lat: 42.875, lon: -78.876 },          // Buffalo
      'flames': { lat: 51.038, lon: -114.052 },         // Calgary
      'hurricanes': { lat: 35.803, lon: -78.722 },      // Raleigh
      'blackhawks': { lat: 41.881, lon: -87.674 },      // Chicago
      'avalanche': { lat: 39.749, lon: -105.008 },      // Denver
      'red wings': { lat: 42.341, lon: -83.055 },       // Detroit
      'oilers': { lat: 53.547, lon: -113.498 },         // Edmonton
      'panthers': { lat: 26.158, lon: -80.326 },        // Sunrise (Florida)
      'kings hockey': { lat: 34.043, lon: -118.267 },   // Los Angeles
      'wild': { lat: 44.945, lon: -93.101 },            // St. Paul
      'canadiens': { lat: 45.496, lon: -73.570 },       // Montreal
      'predators': { lat: 36.159, lon: -86.779 },       // Nashville
      'devils': { lat: 40.734, lon: -74.171 },          // Newark
      'islanders': { lat: 40.683, lon: -73.976 },       // New York
      'rangers': { lat: 40.751, lon: -73.994 },         // New York
      'senators': { lat: 45.297, lon: -75.928 },        // Ottawa
      'flyers': { lat: 39.901, lon: -75.172 },          // Philadelphia
      'penguins': { lat: 40.439, lon: -79.989 },        // Pittsburgh
      'sharks': { lat: 37.333, lon: -121.901 },         // San Jose
      'kraken': { lat: 47.622, lon: -122.354 },         // Seattle
      'blues': { lat: 38.627, lon: -90.203 },           // St. Louis
      'lightning': { lat: 27.943, lon: -82.452 },       // Tampa
      'maple leafs': { lat: 43.643, lon: -79.379 },     // Toronto
      'canucks': { lat: 49.278, lon: -123.109 },        // Vancouver
      'golden knights': { lat: 36.103, lon: -115.178 }, // Las Vegas
      'capitals': { lat: 38.898, lon: -77.021 },        // Washington DC
      'jets': { lat: 49.893, lon: -97.144 },            // Winnipeg
      // NFL
      'cardinals': { lat: 33.528, lon: -112.263 },      // Glendale AZ
      'falcons': { lat: 33.755, lon: -84.401 },         // Atlanta
      'ravens': { lat: 39.278, lon: -76.623 },          // Baltimore
      'bills': { lat: 42.774, lon: -78.787 },           // Orchard Park
      'bears': { lat: 41.862, lon: -87.617 },           // Chicago
      'bengals': { lat: 39.095, lon: -84.516 },         // Cincinnati
      'browns': { lat: 41.506, lon: -81.700 },          // Cleveland
      'cowboys': { lat: 32.748, lon: -97.093 },         // Arlington TX
      'broncos': { lat: 39.744, lon: -105.020 },        // Denver
      'lions': { lat: 42.340, lon: -83.046 },           // Detroit
      'packers': { lat: 44.501, lon: -88.062 },         // Green Bay
      'texans': { lat: 29.685, lon: -95.411 },          // Houston
      'colts': { lat: 39.760, lon: -86.164 },           // Indianapolis
      'jaguars': { lat: 30.324, lon: -81.638 },         // Jacksonville
      'chiefs': { lat: 39.049, lon: -94.484 },          // Kansas City
      'raiders': { lat: 36.091, lon: -115.183 },        // Las Vegas
      'chargers': { lat: 33.953, lon: -118.339 },       // Inglewood
      'rams': { lat: 33.953, lon: -118.339 },           // Inglewood
      'dolphins': { lat: 25.958, lon: -80.239 },        // Miami Gardens
      'vikings': { lat: 44.974, lon: -93.258 },         // Minneapolis
      'patriots': { lat: 42.091, lon: -71.264 },        // Foxborough
      'saints': { lat: 29.951, lon: -90.081 },          // New Orleans
      'giants football': { lat: 40.813, lon: -74.074 }, // East Rutherford
      'jets football': { lat: 40.813, lon: -74.074 },   // East Rutherford
      'eagles': { lat: 39.901, lon: -75.168 },          // Philadelphia
      'steelers': { lat: 40.447, lon: -80.016 },        // Pittsburgh
      '49ers': { lat: 37.403, lon: -121.970 },          // Santa Clara
      'seahawks': { lat: 47.595, lon: -122.332 },       // Seattle
      'buccaneers': { lat: 27.976, lon: -82.503 },      // Tampa
      'titans': { lat: 36.166, lon: -86.771 },          // Nashville
      'commanders': { lat: 38.908, lon: -76.864 },      // Landover MD
      // MLB
      'diamondbacks': { lat: 33.446, lon: -112.067 },   // Phoenix
      'braves': { lat: 33.891, lon: -84.468 },          // Atlanta
      'orioles': { lat: 39.284, lon: -76.622 },         // Baltimore
      'red sox': { lat: 42.346, lon: -71.098 },         // Boston
      'cubs': { lat: 41.948, lon: -87.656 },            // Chicago
      'white sox': { lat: 41.830, lon: -87.634 },       // Chicago
      'reds': { lat: 39.097, lon: -84.507 },            // Cincinnati
      'guardians': { lat: 41.496, lon: -81.685 },       // Cleveland
      'rockies': { lat: 39.756, lon: -104.994 },        // Denver
      'tigers': { lat: 42.339, lon: -83.049 },          // Detroit
      'astros': { lat: 29.757, lon: -95.355 },          // Houston
      'royals': { lat: 39.051, lon: -94.480 },          // Kansas City
      'angels': { lat: 33.800, lon: -117.883 },         // Anaheim
      'dodgers': { lat: 34.074, lon: -118.240 },        // Los Angeles
      'marlins': { lat: 25.778, lon: -80.220 },         // Miami
      'brewers': { lat: 43.028, lon: -87.971 },         // Milwaukee
      'twins': { lat: 44.982, lon: -93.278 },           // Minneapolis
      'mets': { lat: 40.757, lon: -73.846 },            // Queens
      'yankees': { lat: 40.829, lon: -73.926 },         // Bronx
      'athletics': { lat: 37.751, lon: -122.201 },      // Oakland
      'phillies': { lat: 39.906, lon: -75.166 },        // Philadelphia
      'pirates': { lat: 40.447, lon: -80.006 },         // Pittsburgh
      'padres': { lat: 32.707, lon: -117.157 },         // San Diego
      'giants baseball': { lat: 37.778, lon: -122.389 },// San Francisco
      'mariners': { lat: 47.591, lon: -122.333 },       // Seattle
      'cardinals baseball': { lat: 38.623, lon: -90.193 }, // St. Louis
      'rays': { lat: 27.768, lon: -82.653 },            // St. Petersburg
      'rangers baseball': { lat: 32.751, lon: -97.082 },// Arlington TX
      'blue jays': { lat: 43.641, lon: -79.389 },       // Toronto
      'nationals': { lat: 38.873, lon: -77.007 },       // Washington DC
    };

    // Derive category from event name
    let gtCategory = null;
    if (/yankees|mets|red sox|cubs|dodgers|giants.*baseball|braves|marlins|phillies|padres|brewers/i.test(nameLower)) gtCategory = 'mlb';
    else if (/knicks|nets|heat|celtics|bulls|76ers|lakers|warriors|bucks|cavaliers|raptors|hornets|pelicans|nuggets|suns|clippers/i.test(nameLower)) gtCategory = 'nba';
    else if (/rangers|islanders|devils|penguins|bruins|flyers|capitals|lightning|maple leafs|blackhawks|red wings/i.test(nameLower)) gtCategory = 'nhl';
    else if (/giants|jets|eagles|patriots|cowboys|rams|49ers|chiefs|bills|ravens|bengals|dolphins|browns/i.test(nameLower)) gtCategory = 'nfl';
    else if (/concert|tour\b/i.test(nameLower)) gtCategory = 'concert';

    // ── Determine lat/lon from home team (team after "at") ──────────────────
    // Format: "Team A at Team B" — Team B is the home team / venue city
    let lat = 40.71, lon = -74.00; // default: NYC
    const atMatch = (eventName || '').match(/\s+at\s+(.+)$/i);
    if (atMatch) {
      const homeTeam = atMatch[1].trim().toLowerCase();
      // Try matching against TEAM_COORDS keys (check longest keys first for multi-word names)
      const coordKeys = Object.keys(TEAM_COORDS).sort((a, b) => b.length - a.length);
      for (const key of coordKeys) {
        if (homeTeam.includes(key)) {
          lat = TEAM_COORDS[key].lat;
          lon = TEAM_COORDS[key].lon;
          log(`  Gametime: using coordinates for "${key}" (lat=${lat}, lon=${lon})`);
          break;
        }
      }
    }

    // Build search URL — use category if detected, else use q= as best effort
    let searchUrl;
    if (gtCategory) {
      searchUrl = `${GAMETIME_BASE}/events?category=${gtCategory}&lat=${lat}&lon=${lon}&per_page=50`;
      log(`  Gametime: searching category=${gtCategory} near lat=${lat},lon=${lon}`);
    } else {
      // Fallback: strip venue and search by performer name
      const searchQ = eventName
        .replace(/\s+at\s+.+$/i, '')
        .replace(/\s+vs\.?\s+/i, ' ')
        .trim()
        .split(/\s+/).slice(0, 4).join(' ');
      searchUrl = `${GAMETIME_BASE}/events?q=${encodeURIComponent(searchQ)}&lat=${lat}&lon=${lon}&per_page=50`;
      log(`  Gametime: searching q="${searchQ}" near lat=${lat},lon=${lon}`);
    }

    const searchResp = await httpGet(searchUrl, { 'User-Agent': GAMETIME_UA });
    if (searchResp.status !== 200) {
      log(`  Gametime: search returned HTTP ${searchResp.status}`);
      return null;
    }

    let searchData;
    try { searchData = JSON.parse(searchResp.body); } catch (_) {
      log('  Gametime: non-JSON search response');
      return null;
    }

    // ── NOTE: Gametime wraps each event under {event: {...}, performers: [...]}
    const rawEvents = searchData.events || searchData.results || [];
    if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
      log('  Gametime: no events in response');
      return null;
    }

    // Unwrap nested structure: each item may be {event: {...}} or a flat event object
    const events = rawEvents.map(item => item.event || item);

    // ── 2. Find best matching event by name + date proximity ─────────────────
    const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    const targetTerms = normalize(eventName).split(/\s+/).filter(t => t.length > 2);
    const targetDate = (eventDate || '').substring(0, 10); // YYYY-MM-DD

    let bestEvent = null;
    let bestScore = -Infinity;
    let bestNameHits = 0;

    for (const ev of events) {
      const evName = ev.name || ev.title || '';
      const evDateRaw = ev.datetime_local || ev.date || ev.starts_at || '';
      const evDate = evDateRaw.substring(0, 10);

      // Score: term overlap between event names
      const evTerms = normalize(evName).split(/\s+/);
      let nameHits = 0;
      for (const term of targetTerms) {
        if (evTerms.some(t => t.includes(term) || term.includes(t))) nameHits++;
      }
      let score = nameHits;

      // Date proximity bonus
      if (targetDate && evDate) {
        const diffDays = Math.abs(
          (new Date(evDate) - new Date(targetDate)) / (1000 * 60 * 60 * 24)
        );
        if (diffDays === 0) score += 10;
        else if (diffDays <= 1) score += 5;
        else if (diffDays <= 7) score += 2;
        else score -= 5; // penalize far-off dates
      }

      if (score > bestScore) {
        bestScore = score;
        bestEvent = ev;
        bestNameHits = nameHits;
      }
    }

    // Require at least 2 name term matches AND a good total score.
    // A date-only match (score=10, nameHits=0) is NOT enough — that's how
    // "Washington Capitals vs NJ Devils" was matching "Boston Bruins at Florida Panthers".
    if (!bestEvent || bestScore < 2 || bestNameHits < 2) {
      log(`  Gametime: no strong event match (best score=${bestScore}, nameHits=${bestNameHits})`);
      return null;
    }

    // ── Team name validation for sports events ──────────────────────────────
    // "Team A at Team B" format — extract short names and verify both appear
    // in the matched event name to prevent cross-event mismatches.
    // Match "Team at Team", "Team vs Team", "Team vs. Team", or "TeamCity TeamName TeamCity TeamName" patterns
    const sportsAtMatch = (eventName || '').match(/^(.+?)\s+(?:at|vs\.?)\s+(.+)$/i);
    // Also try splitting sports names without a separator (SeatData format: "Philadelphia Flyers New York Islanders")
    // by matching the Gametime event name's teams against the source event name
    if (sportsAtMatch && gtCategory && ['nhl', 'nba', 'nfl', 'mlb'].includes(gtCategory)) {
      const extractShortName = (fullTeamName) => {
        const words = fullTeamName.trim().split(/\s+/);
        if (words.length >= 2) {
          // Try 2-word short name first (e.g., "Red Wings", "Blue Jays", "Red Sox", "Trail Blazers", "Maple Leafs")
          const twoWord = words.slice(-2).join(' ').toLowerCase();
          const twoWordTeams = ['red wings', 'blue jays', 'red sox', 'white sox', 'trail blazers',
            'maple leafs', 'golden knights', 'blue jackets'];
          if (twoWordTeams.includes(twoWord)) return twoWord;
          // Otherwise use last word (e.g., "Sabres", "Warriors", "Panthers")
          return words[words.length - 1].toLowerCase();
        }
        return words[0].toLowerCase();
      };

      const awayTeam = sportsAtMatch[1].trim();
      const homeTeam = sportsAtMatch[2].trim();
      const awayShort = extractShortName(awayTeam);
      const homeShort = extractShortName(homeTeam);
      const matchedName = (bestEvent.name || bestEvent.title || '').toLowerCase();

      const awayFound = matchedName.includes(awayShort);
      const homeFound = matchedName.includes(homeShort);

      if (!awayFound || !homeFound) {
        log(`  Gametime: team name mismatch — rejecting (wanted "${awayShort}" + "${homeShort}", got "${bestEvent.name || bestEvent.title}")`);
        return null;
      }
    }

    // ADDITIONAL CHECK: Even without "at"/"vs" in event name, verify the Gametime match
    // contains words from the original event name. "Philadelphia Flyers New York Islanders"
    // should NOT match "Detroit Red Wings at Philadelphia Flyers" — "Islanders" is missing.
    if (gtCategory && ['nhl', 'nba', 'nfl', 'mlb'].includes(gtCategory) && !sportsAtMatch) {
      const srcNorm = (eventName || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
      const matchNorm = (bestEvent.name || bestEvent.title || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
      const srcWords = srcNorm.split(/\s+/).filter(w => w.length > 3);
      const matchWords = matchNorm.split(/\s+/).filter(w => w.length > 3);
      let hits = 0;
      for (const w of srcWords) {
        if (matchWords.some(m => m.includes(w) || w.includes(m))) hits++;
      }
      // At least 60% of source words must appear in the matched event
      const hitRate = srcWords.length > 0 ? hits / srcWords.length : 0;
      if (hitRate < 0.6) {
        log(`  Gametime: insufficient name overlap — rejecting (${hits}/${srcWords.length} words matched, need 60%+)`);
        return null;
      }
    }

    const gtEventId = bestEvent.id || bestEvent._id;
    if (!gtEventId) {
      log('  Gametime: matched event has no ID');
      return null;
    }

    log(`  Gametime: matched event "${bestEvent.name}" (id=${gtEventId}, score=${bestScore})`);

    // ── 3. Fetch listings for that event ─────────────────────────────────────
    const listingsUrl = `${GAMETIME_BASE}/listings?event_id=${encodeURIComponent(gtEventId)}`;
    log(`  Gametime: fetching listings → ${listingsUrl}`);

    const listResp = await httpGet(listingsUrl, { 'User-Agent': GAMETIME_UA });
    if (listResp.status !== 200) {
      log(`  Gametime: listings returned HTTP ${listResp.status}`);
      return null;
    }

    let listData;
    try { listData = JSON.parse(listResp.body); } catch (_) {
      log('  Gametime: non-JSON listings response');
      return null;
    }

    const rawListings = listData.listings || listData.results || [];
    if (!Array.isArray(rawListings) || rawListings.length === 0) {
      log('  Gametime: no listings returned');
      return null;
    }

    // ── 4. Parse listings — prices in CENTS ──────────────────────────────────
    // Gametime listing structure (confirmed from live API):
    //   l.seats = ["*", "*"] → array length = ticket count
    //   l.price.prefee = base price in cents
    //   l.price.total  = all-in price in cents (includes Gametime fee)
    //   l.section, l.row, l.section_group (zone name)
    const parsed = rawListings
      .filter(l => {
        if (!l.price?.total || l.price.total <= 0) return false;
        // Quantity: use seats array length as ground truth
        const lQty = Array.isArray(l.seats) ? l.seats.length : 0;
        if (quantity && lQty > 0 && lQty !== parseInt(quantity)) return false;
        return true;
      })
      .map(l => {
        const section = l.section || '';
        const row = l.row || '';
        const qty = Array.isArray(l.seats) ? l.seats.length : parseInt(quantity || 2);
        // Prices in cents → dollars
        const basePrice  = (l.price.prefee || l.price.total || 0) / 100;
        const allInPrice = (l.price.total || 0) / 100;

        // Build Gametime buy URL from event seo_url or fallback to event ID
        const gtEventUrl = bestEvent.seo_url
          ? `https://gametime.co${bestEvent.seo_url}`
          : `https://gametime.co/event/${gtEventId}`;

        return {
          section,
          row,
          quantity: qty,
          price:      Math.round(basePrice  * 100) / 100,
          allInPrice: Math.round(allInPrice * 100) / 100,
          platform: 'Gametime',
          feeRate: basePrice > 0 ? (allInPrice - basePrice) / basePrice : CONFIG.fees.gametimeBuyer,
          listingId: l.id || '',
          zone: l.section_group || '',
          listingUrl: gtEventUrl, // used as the BUY NOW button link in email
          checkoutUrl: gtEventUrl,
        };
      })
      .filter(l => l.allInPrice > 0)
      .sort((a, b) => a.allInPrice - b.allInPrice);

    log(`  Gametime: ${rawListings.length} raw listings → ${parsed.length} matching qty=${quantity}`);
    return parsed.length > 0 ? parsed : null;

  } catch (e) {
    log(`  Gametime error: ${e.message}`);
    return null;
  }
}

async function checkGametimePrice(eventName, eventDate) {
  // Legacy stub — superseded by fetchGametimeListings() wired into the main loop.
  return [];
}

async function checkTicketmasterPrice(eventName, eventDate) {
  // TM resale - would need discovery API. Mark as unavailable for now.
  return [];
}

async function checkAXSPrice(eventName, eventDate) {
  // AXS resale - limited inventory. Mark as unavailable for now.
  return [];
}

// ─── Live StubHub Listings (WAF-aware) ──────────────────────────────────────
// StubHub's public buy-side requires OAuth for their partner API.
// We attempt several endpoint patterns; most will return 400/404/403.
// If all fail, we return null and the caller falls back to SeatData cached data.
async function fetchStubHubListings(eventName, eventDate, zone, quantity, stubhubEventId) {
  const dateShort = (eventDate || '').substring(0, 10); // YYYY-MM-DD

  // Helper: attempt to fetch listings for a known StubHub event ID
  async function tryListingsById(eventId) {
    const listingPatterns = [
      // Partner/seller API (requires OAuth in prod — likely 400 without token)
      `https://api.stubhub.com/sellers/search/events/v3/${eventId}/listings?quantity=${quantity}&rows=50&start=0&sortBy=currentprice+asc`,
      // Catalog listings endpoint
      `https://api.stubhub.com/catalog/listings/v1?eventId=${eventId}&quantity=${quantity}&rows=50&sort=currentprice+asc`,
    ];
    for (const url of listingPatterns) {
      try {
        const resp = await httpGet(url, {
          'Accept': 'application/json',
          'Referer': 'https://www.stubhub.com/',
        });
        if (resp.status !== 200) {
          log(`  StubHub listings API (${resp.status}): ${url.substring(0, 70)}`);
          continue;
        }
        let listData;
        try { listData = JSON.parse(resp.body); } catch (_) { continue; }
        const rawListings = listData.listing || listData.listings || listData.items || [];
        if (!Array.isArray(rawListings) || rawListings.length === 0) continue;
        return rawListings
          .map(l => ({
            price: parseFloat(l.currentPrice?.amount || l.listingPrice?.amount || l.pricePerTicket || 0),
            section: l.section || l.sectionName || '',
            row: l.row || l.rowId || '',
            quantity: parseInt(l.quantity || l.availableTickets || 0),
            allInPrice: parseFloat(l.currentPrice?.amount || l.listingPrice?.amount || 0) * (1 + CONFIG.fees.stubhubBuyer),
            listingId: l.listingId || l.id || '',
          }))
          .filter(l => l.price > 0)
          .sort((a, b) => a.price - b.price);
      } catch (err) {
        log(`  StubHub listings error: ${err.message}`);
      }
    }
    return null;
  }

  // Fast path: if we already have the StubHub event ID from SeatData, try directly
  if (stubhubEventId) {
    log(`  StubHub: trying direct lookup with event ID ${stubhubEventId}`);
    const direct = await tryListingsById(stubhubEventId);
    if (direct) {
      log(`  ✅ StubHub live listings: ${direct.length} listings fetched (direct event ID)`);
      return direct;
    }
  }

  // Search path: try event search endpoints to find the event ID, then fetch listings
  const searchEndpoints = [
    // StubHub catalog search API
    `https://api.stubhub.com/catalog/events/v3?name=${encodeURIComponent(eventName)}&date=${encodeURIComponent(dateShort)}&rows=5`,
    // StubHub search (public-facing, may need auth)
    `https://api.stubhub.com/search/catalog/events/v3?name=${encodeURIComponent(eventName)}&date=${encodeURIComponent(dateShort)}&rows=5`,
  ];

  for (const url of searchEndpoints) {
    try {
      const resp = await httpGet(url, {
        'Accept': 'application/json, text/javascript, */*',
        'Referer': 'https://www.stubhub.com/',
        'Origin': 'https://www.stubhub.com',
      });

      if (resp.status === 403 || resp.status === 429 || resp.status === 503) {
        log(`  StubHub WAF blocked (${resp.status}): ${url.substring(0, 60)}`);
        continue;
      }
      if (resp.status !== 200) {
        log(`  StubHub search returned ${resp.status}: ${url.substring(0, 60)}`);
        continue;
      }

      let data;
      try { data = JSON.parse(resp.body); } catch (_) {
        log(`  StubHub: non-JSON from ${url.substring(0, 60)}`);
        continue;
      }

      const events = data.events || data.items || data.data || [];
      if (!Array.isArray(events) || events.length === 0) {
        log(`  StubHub: no events in search response`);
        continue;
      }

      // Find best event match by name + date
      const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
      const targetTerms = normalize(eventName).split(/\s+/).filter(t => t.length > 2);
      let bestEvent = null;
      let bestScore = 0;

      for (const ev of events) {
        const evName = ev.name || ev.title || ev.event_name || '';
        const evDate = (ev.eventDateLocal || ev.date || ev.event_date || '').substring(0, 10);
        if (evDate && dateShort && evDate !== dateShort) continue;
        const evTerms = normalize(evName).split(/\s+/);
        let score = 0;
        for (const term of targetTerms) {
          if (evTerms.some(t => t.includes(term) || term.includes(t))) score++;
        }
        if (score > bestScore) { bestScore = score; bestEvent = ev; }
      }

      if (!bestEvent || bestScore < 2) {
        log(`  StubHub: no strong event match (score=${bestScore})`);
        continue;
      }

      const foundId = bestEvent.id || bestEvent.eventId || bestEvent.event_id;
      if (!foundId) { log('  StubHub: matched event but no ID'); continue; }

      const listings = await tryListingsById(foundId);
      if (listings) {
        log(`  ✅ StubHub live listings: ${listings.length} listings fetched for event ${foundId}`);
        return listings;
      }

    } catch (err) {
      log(`  StubHub search error: ${err.message}`);
    }
  }

  log('  StubHub: all API endpoints failed/blocked — trying Playwright scrape...');

  // Playwright fallback: scrape the actual StubHub event page
  if (stubhubEventId) {
    try {
      const { chromium } = require('playwright');
      const browser = await chromium.launch({ headless: true, timeout: 30000, args: ['--disable-blink-features=AutomationControlled'] });
      const ctx = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 900 },
      });
      const pg = await ctx.newPage();
      
      // Load event page sorted by price, filtered to our quantity
      const url = `https://www.stubhub.com/event/${stubhubEventId}/?quantity=${quantity}&sort=price`;
      await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await pg.waitForTimeout(5000);
      
      // Click "Show more" once only to balance speed vs coverage
      try {
        const showMore = pg.locator('button:has-text("Show more"), button:has-text("show more")').first();
        if (await showMore.count() > 0) {
          await showMore.click().catch(() => {});
          await pg.waitForTimeout(2000);
        }
      } catch(e) { /* timeout ok */ }
      
      // Extract listing data from page text
      const pageListings = await pg.evaluate((qty) => {
        const text = document.body.innerText;
        const lines = text.split('\n');
        const results = [];
        
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          // Match "Section NNN" pattern
          const secMatch = line.match(/^Section\s+(\d+)/);
          if (secMatch) {
            const section = secMatch[1];
            let row = '', price = 0;
            // Look ahead for row and price
            for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
              const ahead = lines[j].trim();
              if (ahead.match(/^Row/)) row = ahead.replace('Row ', '');
              const priceMatch = ahead.match(/^\$(\d+)/);
              if (priceMatch) {
                price = parseInt(priceMatch[1]);
                break;
              }
            }
            if (price > 0) {
              results.push({ section, row, price, quantity: qty });
            }
          }
          // Also catch "Floor" / GA listings
          if (line === 'Floor' || line.match(/^(GA|General Admission)/i)) {
            for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
              const ahead = lines[j].trim();
              const priceMatch = ahead.match(/^\$(\d+)/);
              if (priceMatch) {
                results.push({ section: 'Floor', row: 'GA', price: parseInt(priceMatch[1]), quantity: qty });
                break;
              }
            }
          }
        }
        return results;
      }, quantity);
      
      await browser.close();
      
      if (pageListings.length > 0) {
        log(`  ✅ StubHub Playwright scrape: ${pageListings.length} listings found`);
        // These prices are buyer-visible (incl. fees). Convert to seller prices.
        return pageListings.map(l => ({
          price: l.price, // This is the buyer all-in price shown on StubHub
          section: l.section,
          row: l.row,
          quantity: l.quantity,
          allInPrice: l.price, // Already includes buyer fees
          listingId: '',
          isScraped: true,
        })).sort((a, b) => a.price - b.price);
      } else {
        log('  StubHub Playwright: page loaded but no listings parsed');
      }
    } catch (err) {
      log(`  StubHub Playwright error: ${err.message}`);
    }
  }

  log('  StubHub: all methods failed — no live listing data available');
  return null;
}

// ─── StubHub Price from SeatData ────────────────────────────────────────────
function getStubHubListingsFromDeal(deal) {
  const listings = [];

  // The deal itself is a StubHub listing
  listings.push({
    platform: 'StubHub',
    section: deal.section,
    row: deal.row,
    quantity: deal.quantity,
    price: parseFloat(deal.price),
    allInPrice: parseFloat(deal.price) * (1 + CONFIG.fees.stubhubBuyer),
    feeRate: CONFIG.fees.stubhubBuyer,
    listingId: deal.listing_id,
    zone: deal.zone,
    isDeal: true,
  });

  // Next prices in zone (also StubHub)
  if (deal.next_prices_in_zone?.listings) {
    for (const l of deal.next_prices_in_zone.listings) {
      listings.push({
        platform: 'StubHub',
        section: l.section,
        row: l.row,
        quantity: l.quantity,
        price: parseFloat(l.price),
        allInPrice: parseFloat(l.price) * (1 + CONFIG.fees.stubhubBuyer),
        feeRate: CONFIG.fees.stubhubBuyer,
        zone: deal.zone,
        isDeal: false,
      });
    }
  }

  return listings;
}

// ─── Cheapest Venue Ticket ──────────────────────────────────────────────────
// Finds the cheapest same-quantity ticket across ALL zones, excluding the deal section.
// Used to show the "floor price to get into this venue at all" context.
function findCheapestVenueTicket(allListings, dealSection, dealQuantity) {
  const candidates = allListings.filter(l => {
    if (Number(l.quantity) !== Number(dealQuantity)) return false;
    if (String(l.section).trim() === String(dealSection).trim()) return false;
    if (!l.allInPrice || l.allInPrice <= 0) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.allInPrice - b.allInPrice);
  const cheapest = candidates[0];

  return {
    price:      cheapest.price,
    allInPrice: cheapest.allInPrice,
    section:    cheapest.section,
    row:        cheapest.row,
    quantity:   cheapest.quantity,
    platform:   cheapest.platform,
  };
}

// ─── Deal Analysis ──────────────────────────────────────────────────────────
function analyzeZoneSales(zoneSales, quantity, targetZone) {
  const now = new Date();
  const windowDays = CONFIG.thresholds.salesWindowDays || 7;
  const maxSales = CONFIG.thresholds.maxSalesUsed || 15;
  const minSales = CONFIG.thresholds.minCompletedSales || 5;

  const filtered = (zoneSales || []).filter(s => {
    // Quantity matching: ONLY use sales that exactly match the deal quantity.
    // If SeatData doesn't provide qty (0 or null), reject the sale — unknown qty ≠ same qty.
    // If there aren't enough matching-qty sales, the deal gets skipped. No fallback.
    const saleQty = Number(s.quantity);
    if (saleQty !== Number(quantity)) return false;
    const saleDate = new Date(s.date || s.timestamp);
    const daysAgo = (now - saleDate) / (1000 * 60 * 60 * 24);
    if (daysAgo > windowDays) return false;
    // Zone tier matching: prevent GA vs "GA Plus" mixing
    if (targetZone && (s.zone || s.section)) {
      const saleZone = (s.zone || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const normTarget = targetZone.toLowerCase().replace(/\s+/g, ' ').trim();
      // If zone field matches, keep it
      if (saleZone && saleZone === normTarget) return true;
      // Otherwise check section-level tier matching
      const normSale = (s.section || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (normTarget !== normSale) {
        const targetHasPlus = normTarget.includes('plus') || normTarget.includes('+');
        const saleHasPlus = normSale.includes('plus') || normSale.includes('+');
        if (targetHasPlus !== saleHasPlus) return false;
      }
    }
    return true;
  })
  .sort((a, b) => new Date(b.date || b.timestamp) - new Date(a.date || a.timestamp))
  .slice(0, maxSales);

  // Apply outlier filtering (>2.5× median and <0.2× median)
  const clean = filterOutliers(filtered);

  // Need minSales clean sales after stripping outliers
  if (clean.length < minSales) return null;

  // Recency-weighted average: weight each sale by e^(-daysAgo/3)
  // This means a sale from today (~0 days) gets weight 1.0,
  // a sale from 3 days ago gets weight ~0.37, 7 days ago gets ~0.10.
  // Most recent sale dominates — older sales add context but don't skew the number.
  const now2 = new Date();
  let weightedSum = 0;
  let weightTotal = 0;
  for (const s of clean) {
    const saleDate = new Date(s.date || s.timestamp);
    const daysAgo = Math.max(0, (now2 - saleDate) / (1000 * 60 * 60 * 24));
    const weight = Math.exp(-daysAgo / 3); // half-life of ~3 days
    weightedSum += parseFloat(s.price) * weight;
    weightTotal += weight;
  }
  const avg = weightTotal > 0 ? weightedSum / weightTotal : clean.reduce((sum, s) => sum + parseFloat(s.price), 0) / clean.length;
  const floor = Math.min(...clean.map(s => parseFloat(s.price)));

  return {
    avg,
    floor,
    count: clean.length,
    recentCount: clean.length,
    sales: clean,
  };
}

function buildDealAlert(deal, bestBuy, salesAnalysis, allListings, platformsChecked, liveStubHubListings, gametimeListings, cheapestVenueTicket, preCalcROI, preCalcSellBenchmark, preCalcSellerFee) {
  const buyCost = bestBuy.allInPrice;
  const dealQty = bestBuy.quantity;

  // Use pre-calculated values if provided (canonical single-calculation path)
  const usePreCalc = preCalcROI !== undefined && preCalcSellBenchmark !== undefined;

  const activeFloorRaw = allListings
    .filter(l => l.platform === 'StubHub' && l.allInPrice > buyCost && Number(l.quantity) === Number(dealQty))
    .reduce((min, l) => Math.min(min, l.price), Infinity);
  const activeFloorBase = activeFloorRaw < Infinity ? activeFloorRaw : null;
  const weightedRecentAvg = salesAnalysis.avg;

  let liveStubHubFloor = null;
  let liveStubHubUsed = false;

  if (liveStubHubListings && liveStubHubListings.length > 0) {
    const sameQtyAboveBuy = liveStubHubListings
      .filter(l => Number(l.quantity) === Number(dealQty) && l.price > (buyCost / (1 + CONFIG.fees.stubhubBuyer)));

    if (sameQtyAboveBuy.length > 0) {
      liveStubHubFloor = sameQtyAboveBuy[0].price;
      log(`  Live StubHub floor (qty=${dealQty}): $${liveStubHubFloor.toFixed(2)} (vs SeatData activeFloor: $${activeFloorBase !== null ? activeFloorBase.toFixed(2) : 'N/A'})`);
      liveStubHubUsed = true;
    }
  }

  let sellPrice;
  let sellBenchmarkSource;

  // Determine effective active floor: MIN(SeatData floor, live StubHub floor)
  // This catches cases where SeatData is stale/inflated vs reality.
  let effectiveActiveFloor = activeFloorBase;
  if (liveStubHubUsed && liveStubHubFloor !== null) {
    if (effectiveActiveFloor === null || liveStubHubFloor < effectiveActiveFloor) {
      effectiveActiveFloor = liveStubHubFloor;
      log(`  Using live StubHub floor ($${liveStubHubFloor.toFixed(2)}) as effective floor (lower than SeatData cached)`);
    } else {
      log(`  SeatData floor ($${effectiveActiveFloor.toFixed(2)}) is lower than or matches live StubHub — keeping SeatData`);
    }
  }

  if (effectiveActiveFloor === null) {
    // No active listings — use the same 7-day avg (already calculated above)
    sellPrice = weightedRecentAvg;
    sellBenchmarkSource = `7-day avg ($${weightedRecentAvg.toFixed(2)}, ${salesAnalysis.count} sales — no active listings)${liveStubHubUsed ? ' [live StubHub confirmed]' : ''}`;
  } else if (effectiveActiveFloor > weightedRecentAvg * 1.20) {
    sellPrice = weightedRecentAvg;
    sellBenchmarkSource = `weighted recent avg ($${weightedRecentAvg.toFixed(2)}) — active floor inflated >20%${liveStubHubUsed ? ' [live StubHub verified]' : ''}`;
  } else if (effectiveActiveFloor < weightedRecentAvg * 0.80) {
    sellPrice = effectiveActiveFloor;
    sellBenchmarkSource = `active listing floor ($${effectiveActiveFloor.toFixed(2)}) — prices dropping >20%${liveStubHubUsed ? ' [live StubHub verified]' : ''}`;
  } else {
    sellPrice = weightedRecentAvg;
    sellBenchmarkSource = `weighted recent avg ($${weightedRecentAvg.toFixed(2)}) — market stable${liveStubHubUsed ? ' [live StubHub verified]' : ''}`;
  }

  // Use canonical ROI if pre-calculated; otherwise compute here
  const effectiveSellerFee = preCalcSellerFee || CONFIG.fees.sellerFee;
  const sellerNet = usePreCalc ? (preCalcSellBenchmark * (1 - effectiveSellerFee)) : (sellPrice * (1 - effectiveSellerFee));
  if (usePreCalc) sellPrice = preCalcSellBenchmark;
  const profit = sellerNet - buyCost;
  const roi = usePreCalc ? preCalcROI : calculateROI(sellPrice, effectiveSellerFee, buyCost);
  const profitPerTicket = profit;

  const hoursOut = hoursUntil(deal.event_date, deal.event_time);
  const daysOut = daysUntil(deal.event_date);

  // Check for flags — tiered time warnings
  const flags = [];
  if (hoursOut < 72) {
    flags.push('⚠️ Event in less than 3 days — act quickly');
  } else if (daysOut <= 7) {
    flags.push('⏰ Event this week');
  } else if (daysOut <= 14) {
    flags.push(`⏰ Event in ${daysOut} days`);
  }
  // (14+ days → no time flag)
  if (bestBuy.quantity === 1) flags.push('📊 1 ticket available — low quantity');
  if (salesAnalysis.count < 8) flags.push('📊 Limited same-qty sales data');

  // Step 4: DATA FRESHNESS flag
  if (liveStubHubUsed) {
    flags.push('✅ Live StubHub listings verified');
  } else {
    flags.push('⚠️ Using SeatData cached listings — verify on StubHub before buying');
  }

  // Check floor divergence (same-qty active floor vs same-qty sales floor)
  const activeFloorAllIn = allListings
    .filter(l => l.platform === 'StubHub' && Number(l.quantity) === Number(dealQty))
    .reduce((min, l) => Math.min(min, l.allInPrice), Infinity);
  if (activeFloorAllIn < Infinity) {
    const divergence = Math.abs(activeFloorAllIn - salesAnalysis.floor) / salesAnalysis.floor;
    if (divergence > CONFIG.thresholds.floorDivergenceFlag) {
      flags.push(`🔍 Active listing floor ($${activeFloorAllIn.toFixed(0)}) vs sales floor ($${salesAnalysis.floor}) diverge by ${(divergence * 100).toFixed(0)}%`);
    }
  }

  // ── Gametime floor cross-check ────────────────────────────────────────────
  // If Gametime has listings for this event+qty, compute their floor.
  // Alert if our buy price (buyCost) is below the Gametime floor (great sign — GT is higher).
  // Also alert if GT floor is BELOW our buy price (bad — GT is cheaper, undermines our resale).
  const gtSameQty = (gametimeListings || []).filter(l => Number(l.quantity) === Number(dealQty));
  if (gtSameQty.length > 0) {
    const gtFloorAllIn = Math.min(...gtSameQty.map(l => l.allInPrice));
    flags.push(`🟠 Gametime floor (all-in): $${gtFloorAllIn.toFixed(2)} for qty ${dealQty}`);
    if (buyCost < gtFloorAllIn) {
      flags.push(`✅ Our buy ($${buyCost.toFixed(2)}) is BELOW Gametime floor ($${gtFloorAllIn.toFixed(2)}) — strong signal`);
    } else if (buyCost > gtFloorAllIn * 1.05) {
      flags.push(`⚠️ Gametime is CHEAPER than our buy ($${gtFloorAllIn.toFixed(2)} vs $${buyCost.toFixed(2)}) — consider buying on Gametime instead`);
    }
  } else if (gametimeListings !== null && gametimeListings !== undefined) {
    // Gametime was queried but no matching qty listings
    flags.push('ℹ️ Gametime: no same-quantity listings found');
  }

  // Savings vs StubHub
  const stubhubPrice = parseFloat(deal.price) * (1 + CONFIG.fees.stubhubBuyer);
  const savings = stubhubPrice - buyCost;

  const platformStr = platformsChecked
    .map(p => `${p.name}: ${p.available ? (p.cheapest ? '$' + p.cheapest.toFixed(0) : 'no match') : '⛔ blocked'}`)
    .join(' | ');

  return {
    id: `deal_${deal.event_id}_${bestBuy.section}_${bestBuy.row}_${Date.now()}`,
    eventName: deal.event_name,
    eventDate: deal.event_date,
    eventTime: deal.event_time,
    venue: deal.venue,
    zone: deal.zone,
    section: bestBuy.section,
    row: bestBuy.row,
    quantity: bestBuy.quantity,
    buyPlatform: bestBuy.platform,
    buyPrice: bestBuy.price,
    buyAllIn: Math.round(buyCost * 100) / 100,
    feeRate: bestBuy.feeRate,
    sellBenchmark: Math.round(sellPrice * 100) / 100,
    sellBenchmarkSource: sellBenchmarkSource,
    sellerNet: Math.round(sellerNet * 100) / 100,
    profit: Math.round(profitPerTicket * 100) / 100,
    roi: Math.round(roi * 100) / 100,
    salesData: salesAnalysis,
    hoursUntilEvent: Math.round(hoursOut * 10) / 10,
    daysUntilEvent: daysOut,
    flags,
    platformComparison: platformStr,
    stubhubSavings: Math.round(savings * 100) / 100,
    // Use the best buy platform's own URL when available — not the SeatDeals checkout URL
    // (SeatDeals checkout URLs always point to StubHub, even when best buy is Gametime/TickPick)
    checkoutUrl: bestBuy.checkoutUrl || bestBuy.listingUrl || deal.checkout_url,
    eventUrl: deal.event_url,
    stubhubEventId: deal.event_id || deal.stubhubEventId || deal.stubhub_event_id || null,
    timestamp: new Date().toISOString(),

    // Live StubHub data
    liveStubHubListings: liveStubHubListings || null,
    liveStubHubUsed,

    // Gametime listings (for email active-listings table and cross-check flags)
    gametimeListings: gametimeListings || null,

    // Cheapest venue ticket (for floor comparison across all zones)
    cheapestVenueTicket: cheapestVenueTicket || null,

    // For Telegram formatting
    alert: formatDealAlert(deal, bestBuy, salesAnalysis, buyCost, sellerNet, profit, roi, profitPerTicket, daysOut, flags, platformsChecked, savings),
  };
}

// ─── Telegram: short summary only ────────────────────────────────────────────
function formatDealAlert(deal, bestBuy, salesAnalysis, buyCost, sellerNet, profit, roi, profitPerTicket, daysOut, flags, platformsChecked, savings) {
  const lines = [];
  lines.push(`🎟️ DEAL ALERT: ${deal.event_name}`);
  lines.push(`📅 ${deal.event_date} ${deal.event_time || ''} | ${deal.venue}`);
  lines.push(`📍 Zone: ${deal.zone} | Sec: ${bestBuy.section} | Row: ${bestBuy.row} | Qty: ${bestBuy.quantity}`);
  lines.push('');
  lines.push(`💰 Buy: $${bestBuy.price}/ticket on ${bestBuy.platform} (all-in $${buyCost.toFixed(2)})`);
  lines.push(`📈 ROI: ${roi.toFixed(1)}% | Profit: $${profitPerTicket.toFixed(2)}/ticket`);
  lines.push(`📊 Sell benchmark: $${(salesAnalysis.avg || 0).toFixed(0)} (weighted recent avg)`);
  if (flags.length > 0) { lines.push(''); flags.forEach(f => lines.push(f)); }
  lines.push('');
  lines.push('📧 Full breakdown sent to email.');
  return lines.join('\n');
}

// ─── HTML Email Formatter ─────────────────────────────────────────────────────
function formatDealAlertHTML(dealAlert, deal) {
  const {
    eventName, eventDate, eventTime, venue, zone,
    section, row, quantity, buyPlatform, buyPrice, buyAllIn, feeRate,
    sellBenchmark, sellBenchmarkSource, sellerNet, profit, roi, salesData,
    hoursUntilEvent, daysUntilEvent, flags,
    checkoutUrl, eventUrl, timestamp,
    liveStubHubListings, liveStubHubUsed, gametimeListings,
    cheapestVenueTicket,
  } = dealAlert;

  // ── Cost calculations ──────────────────────────────────────────────────────
  const deliveryCost = buyPlatform === 'TickPick' ? 0 : 3.50;
  // buyAllIn = base × (1 + feeRate); totalAllIn adds delivery
  const totalAllIn     = buyAllIn + deliveryCost;                // per ticket, all costs
  const totalBuyCost   = (totalAllIn * quantity).toFixed(2);     // total out-of-pocket
  const grossRevenue   = (sellBenchmark * quantity).toFixed(2);
  const effectiveSellerFeeForEmail = CONFIG.fees.sellerFee;
  const sellerFeeAmt   = (sellBenchmark * effectiveSellerFeeForEmail * quantity).toFixed(2);
  const netRevenue     = (sellerNet * quantity).toFixed(2);
  const totalProfit    = (profit * quantity).toFixed(2);

  const feeDisplay = buyPlatform === 'TickPick'
    ? 'NONE (no-fee platform)'
    : `${(feeRate * 100).toFixed(0)}% buyer fee`;

  // ── Active listings — same quantity only ──────────────────────────────────
  // Step 3: Combine live StubHub data + Gametime listings (if available)
  // Fall back to SeatData feed when live StubHub is unavailable.
  let activeListingSectionLabel;
  let allActive;       // array of {section,row,quantity,price,platform,isDeal}
  let activeFloor;

  // Pull Gametime listings from dealAlert (already parsed by fetchGametimeListings)
  const gtActiveListings = (gametimeListings || []).filter(l => Number(l.quantity) === Number(quantity));

  if (liveStubHubUsed && liveStubHubListings && liveStubHubListings.length > 0) {
    // Live StubHub data — use it directly (already sorted ascending)
    const sameQtyLive = liveStubHubListings
      .filter(l => Number(l.quantity) === Number(quantity))
      .map(l => ({ ...l, platform: 'StubHub' }));
    // Our deal ticket at the top
    const dealEntry = { section, row, quantity, price: String(buyPrice), platform: buyPlatform, isDeal: true };
    // Combine StubHub + Gametime (above our buy price), sort by price
    const otherListings = [
      ...sameQtyLive.filter(l => parseFloat(l.price) > parseFloat(buyPrice)),
      ...gtActiveListings.filter(l => l.allInPrice > parseFloat(buyPrice) * (1 + CONFIG.fees.stubhubBuyer))
        .map(l => ({ section: l.section, row: l.row, quantity: l.quantity, price: String(l.price), allInPrice: l.allInPrice, platform: 'Gametime' })),
    ].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));

    allActive = [dealEntry, ...otherListings];
    activeFloor = otherListings.length
      ? Math.min(...otherListings.map(l => parseFloat(l.price)))
      : null;
    activeListingSectionLabel = gtActiveListings.length > 0
      ? `ACTIVE LISTINGS — STUBHUB (LIVE) + GAMETIME (QTY ${quantity})`
      : `ACTIVE LISTINGS ON STUBHUB RIGHT NOW (QTY ${quantity})`;
  } else {
    // Fallback: SeatData feed for StubHub + Gametime if available
    const rawActive = (deal.next_prices_in_zone?.listings || []);
    const otherStubHub = rawActive
      .filter(l => Number(l.quantity) === Number(quantity))
      .map(l => ({ ...l, platform: 'StubHub' }));
    const dealEntry = { section, row, quantity, price: String(buyPrice), platform: buyPlatform, isDeal: true };
    const otherListings = [
      ...otherStubHub,
      ...gtActiveListings.map(l => ({
        section: l.section, row: l.row, quantity: l.quantity,
        price: String(l.price), allInPrice: l.allInPrice, platform: 'Gametime',
      })),
    ].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));

    allActive = [dealEntry, ...otherListings];
    activeFloor = otherListings.length
      ? Math.min(...otherListings.map(l => parseFloat(l.price)))
      : null;
    activeListingSectionLabel = gtActiveListings.length > 0
      ? `ACTIVE LISTINGS — SEATDATA FEED + GAMETIME (QTY ${quantity})`
      : `ACTIVE LISTINGS (FROM SEATDATA FEED, QTY ${quantity})`;
  }

  // ── Filter active listings to same zone ─────────────────────────────────
  // Only show listings whose section appears in the completed sales for this zone.
  // This prevents upper-bowl sections showing up in a Club-level deal email.
  const salesSections = new Set(
    (salesData.sales || deal.zone_sales || []).map(s => String(s.section || '').trim()).filter(Boolean)
  );
  if (salesSections.size > 0) {
    allActive = allActive.filter(l => {
      if (l.isDeal) return true; // always include the deal itself
      const lSec = String(l.section || '').trim();
      return salesSections.has(lSec);
    });
  }

  // ── Zone listing count (excluding our deal ticket) ─────────────────────────
  const zoneListingCount = allActive.length - 1; // subtract our deal ticket
  const zoneCountFlag = zoneListingCount < 4
    ? `<div style="margin:8px 0;padding:8px 12px;background:#2a1f00;border-left:3px solid #f0a500;border-radius:4px;color:#ffd166;font-size:13px;font-weight:700">⚠️ Only ${zoneListingCount} listing${zoneListingCount !== 1 ? 's' : ''} in zone — limited price comparison data</div>`
    : `<div style="margin:8px 0;padding:8px 12px;background:#0d2a12;border-left:3px solid #00cc66;border-radius:4px;color:#00cc66;font-size:13px;font-weight:700">✅ ${zoneListingCount} listings in zone — good price comparison data</div>`;

  // ── Completed sales — same quantity only (use salesData.sales if present) ──
  // salesData.sales contains the already-filtered rows from analyzeZoneSales.
  // Fall back to deal.zone_sales filtered by qty for send-test-v3 compatibility.
  const rawSales = salesData.sales
    || (deal.zone_sales || []).filter(s => Number(s.quantity) === Number(quantity));
  const completedFloor = salesData.floor;

  // ── Callout booleans ──────────────────────────────────────────────────────
  const atOrBelowActiveFloor = activeFloor !== null && buyAllIn <= activeFloor;
  const belowCompletedFloor  = completedFloor != null && buyAllIn < completedFloor;

  // ── Time label for header badge ───────────────────────────────────────────
  const daysLabel = `${daysUntilEvent} day${daysUntilEvent !== 1 ? 's' : ''} away`;

  // ── Links ─────────────────────────────────────────────────────────────────
  const stubhubEventLink = eventUrl || '#';
  const tmSearchLink = `https://www.ticketmaster.com/search?q=${encodeURIComponent(eventName)}`;
  const gmapsLink    = `https://maps.google.com/?q=${encodeURIComponent(venue)}`;

  // ── Section label helper ──────────────────────────────────────────────────
  const sectionLabel = (text) =>
    `<div style="font-size:11px;color:#4db8c8;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;margin-bottom:10px">${text}</div>`;

  const divider = `<div style="border-top:1px solid #253047;margin:20px 0"></div>`;

  // ── Active listings table rows (with SOURCE column) ──────────────────────
  const activeRows = allActive.slice(0, 15).map((l, i) => {
    const isDeal   = i === 0;
    const platform = l.platform || 'StubHub';
    const isGT     = platform === 'Gametime';
    const rowBg    = isDeal
      ? 'background:#162535'
      : (i % 2 === 1 ? 'background:#1e2d44' : 'background:#171f30');
    const numCell = isDeal
      ? `<td style="padding:6px 8px;color:#00cc66;font-weight:700">1 ★</td>`
      : `<td style="padding:6px 8px;color:#8899aa">${i + 1}</td>`;
    const priceStyle = isDeal ? 'color:#00cc66;font-weight:700' : 'color:#ffffff';
    // Source badge: "GT" in orange for Gametime, "SH" in blue for StubHub, "TP" for TickPick
    let sourceBadge;
    if (platform === 'Gametime') {
      sourceBadge = `<span style="background:#d4531c;color:#fff;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700">GT</span>`;
    } else if (platform === 'TickPick') {
      sourceBadge = `<span style="background:#7c3aed;color:#fff;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700">TP</span>`;
    } else {
      sourceBadge = `<span style="background:#1d4ed8;color:#fff;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700">SH</span>`;
    }
    // Show all-in price for Gametime (since GT already includes fees), base price for StubHub
    const displayPrice = isGT && l.allInPrice
      ? `$${parseFloat(l.allInPrice).toFixed(2)} <span style="font-size:10px;color:#8899aa">(all-in)</span>`
      : `$${parseFloat(l.price).toFixed(2)}`;
    return `<tr style="${rowBg}">
      ${numCell}
      <td style="padding:6px 8px;${priceStyle}">${displayPrice}</td>
      <td style="padding:6px 8px;color:#ffffff">Sec ${escHtml(String(l.section))}</td>
      <td style="padding:6px 8px;color:#ffffff">Row ${escHtml(String(l.row))}</td>
      <td style="padding:6px 8px;color:#ffffff">Qty ${l.quantity}</td>
      <td style="padding:6px 8px">${sourceBadge}</td>
    </tr>`;
  }).join('');

  // ── Completed sales table rows ────────────────────────────────────────────
  const salesRows = rawSales.slice(0, 15).map((s, i) => {
    const rowBg = i % 2 === 0 ? 'background:#1e2d44' : 'background:#171f30';
    return `<tr style="${rowBg}">
      <td style="padding:6px 8px;color:#8899aa">${i + 1}</td>
      <td style="padding:6px 8px;color:#ffffff">${escHtml(String(s.date || '—'))}</td>
      <td style="padding:6px 8px;color:#ffffff">$${parseFloat(s.price).toFixed(2)}</td>
      <td style="padding:6px 8px;color:#ffffff">Sec ${escHtml(String(s.section || '?'))}</td>
      <td style="padding:6px 8px;color:#ffffff">Row ${escHtml(String(s.row || '?'))}</td>
      <td style="padding:6px 8px;color:#ffffff">Qty ${s.quantity || '?'}</td>
    </tr>`;
  }).join('');

  // ── Flags HTML ────────────────────────────────────────────────────────────
  const flagsHtml = flags.length > 0
    ? flags.map(f => {
        const isPositive = f.startsWith('✅');
        const bg    = isPositive ? '#0d2a12' : '#2a1f00';
        const bdr   = isPositive ? '#00cc66' : '#f0a500';
        const color = isPositive ? '#00cc66'  : '#ffd166';
        return `<div style="margin:5px 0;padding:8px 12px;background:${bg};border-left:3px solid ${bdr};border-radius:4px;color:${color};font-size:13px">${escHtml(f)}</div>`;
      }).join('')
    : '<div style="color:#6b7280;font-style:italic;font-size:13px">No flags — clean deal.</div>';

  // ── Sell benchmark label ───────────────────────────────────────────────────
  const sellLabel = `Sell at: ${escHtml(sellBenchmarkSource)} ($${sellBenchmark.toFixed(2)}/ticket × ${quantity})`;

  // ── Formatted timestamp ────────────────────────────────────────────────────
  const tsFormatted = new Date(timestamp).toLocaleString('en-US', {
    timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short',
  });

  // ── Button helper ─────────────────────────────────────────────────────────
  const btn = (href, emoji, label, primary) => {
    const bg = primary ? '#2979ff' : '#2a3348';
    return `<a href="${escHtml(href)}" style="display:inline-block;background:${bg};color:#ffffff;padding:9px 18px;border-radius:6px;text-decoration:none;font-weight:700;font-size:13px;margin:4px 6px 4px 0">${emoji} ${label}</a>`;
  };

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#1a1f2e;font-family:Arial,sans-serif;color:#e2e8f0">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#1a1f2e;padding:20px 0">
<tr><td align="center">
<table width="700" cellpadding="0" cellspacing="0" style="background:#1a1f2e;border-radius:12px;overflow:hidden;max-width:700px;width:100%">

  <!-- ═══ HEADER CARD ═══ -->
  <tr><td style="background:#1e2d4a;border-radius:12px;padding:24px 28px;margin-bottom:4px">
    <div style="font-size:11px;color:#4db8c8;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;margin-bottom:8px">MR. SHMACK DEAL SCANNER</div>
    <div style="font-size:28px;font-weight:700;color:#ffffff;line-height:1.2;margin-bottom:10px">🎟️ ${escHtml(eventName)}</div>
    <div style="font-size:14px;color:#d0d8e8;margin-bottom:14px">📅 ${escHtml(eventDate)}${eventTime ? ' ' + escHtml(eventTime.substring(0,5)) : ''} &nbsp;·&nbsp; ${escHtml(venue)}</div>
    <div>
      <span style="display:inline-block;background:#2d5fa6;color:#c8ddff;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;margin-right:6px">Zone: ${escHtml(zone)}</span>
      <span style="display:inline-block;background:#27a844;color:#c6f0d1;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;margin-right:6px">${roi.toFixed(1)}% ROI</span>
      <span style="display:inline-block;background:#6b4fa0;color:#e0d0ff;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600">${daysLabel}</span>
    </div>
  </td></tr>

  <!-- ═══ BODY ═══ -->
  <tr><td style="padding:24px 28px">

    <!-- TICKET DETAILS -->
    ${sectionLabel('TICKET DETAILS')}
    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="color:#8899aa;font-size:13px;padding:5px 0;width:140px">Zone</td>
        <td style="color:#ffffff;font-size:14px;font-weight:700;padding:5px 0">${escHtml(zone)}</td>
      </tr>
      <tr>
        <td style="color:#8899aa;font-size:13px;padding:5px 0">Section / Row / Qty</td>
        <td style="color:#ffffff;font-size:14px;font-weight:700;padding:5px 0">Sec ${escHtml(String(section))} &nbsp;·&nbsp; Row ${escHtml(String(row))} &nbsp;·&nbsp; Qty ${quantity}</td>
      </tr>
      <tr>
        <td style="color:#8899aa;font-size:13px;padding:5px 0">Platform</td>
        <td style="color:#ffffff;font-size:14px;font-weight:700;padding:5px 0">${escHtml(buyPlatform)}</td>
      </tr>
    </table>

    ${divider}

    <!-- BUY PRICE -->
    ${sectionLabel('BUY PRICE')}
    <div style="background:#131c2e;border-radius:8px;padding:20px 24px">
      <div style="margin-bottom:6px">
        <span style="font-size:36px;font-weight:700;color:#00cc66">$${totalAllIn.toFixed(2)}</span>
        <span style="font-size:14px;color:#8899aa;font-weight:400"> all-in / ticket</span>
      </div>
      <div style="color:#8899aa;font-size:13px;margin-bottom:8px">
        Base $${parseFloat(buyPrice).toFixed(2)} + ${feeDisplay}${deliveryCost > 0 ? ` + $${deliveryCost.toFixed(2)} delivery` : ''}
      </div>
      <div style="color:#ffffff;font-size:14px;font-weight:700;margin-bottom:14px">
        Total cost: $${totalBuyCost} (${quantity} ticket${quantity !== 1 ? 's' : ''} all-in)
      </div>
      ${checkoutUrl ? btn(checkoutUrl, '🛒', `BUY NOW on ${escHtml(buyPlatform)}`, true) : ''}
    </div>

    ${divider}

    <!-- CHEAPEST ALTERNATIVE IN VENUE -->
    ${sectionLabel(`CHEAPEST ALTERNATIVE (QTY ${quantity} — ENTIRE VENUE)`)}
    ${(() => {
      if (!cheapestVenueTicket) {
        return `<div style="margin:5px 0;padding:10px 14px;background:#1e2d44;border-radius:6px;color:#ffd166;font-size:13px">⚠️ No other same-quantity listings found in venue — price unverified</div>`;
      }
      const cvt = cheapestVenueTicket;
      const gap = cvt.allInPrice - (buyAllIn + (buyPlatform === 'TickPick' ? 0 : 3.50));
      // Source badge
      let srcBadge;
      if (cvt.platform === 'Gametime') {
        srcBadge = `<span style="background:#d4531c;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">GT</span>`;
      } else if (cvt.platform === 'TickPick') {
        srcBadge = `<span style="background:#7c3aed;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">TP</span>`;
      } else {
        srcBadge = `<span style="background:#1d4ed8;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">SH</span>`;
      }
      const gapHtml = gap > 0
        ? `<div style="margin-top:10px;padding:8px 14px;background:#0d2a12;border-left:3px solid #00cc66;border-radius:4px;color:#00cc66;font-size:13px;font-weight:700">✅ YOUR TICKET IS $${gap.toFixed(2)} CHEAPER THAN THE NEXT CHEAPEST OPTION IN THE VENUE</div>`
        : `<div style="margin-top:10px;padding:8px 14px;background:#2a0d0d;border-left:3px solid #ff4444;border-radius:4px;color:#ff8888;font-size:13px;font-weight:700">⚠️ Cheapest venue alternative is $${Math.abs(gap).toFixed(2)} CHEAPER than your ticket</div>`;
      return `<div style="background:#131c2e;border-radius:8px;padding:16px 20px">
        <table style="width:100%;border-collapse:collapse;font-size:15px">
          <tr>
            <td style="padding:6px 0;color:#00e5ff;font-weight:700">$${cvt.allInPrice.toFixed(2)} all-in</td>
            <td style="padding:6px 8px;color:#ffffff">Sec ${escHtml(String(cvt.section))}</td>
            <td style="padding:6px 8px;color:#ffffff">Row ${escHtml(String(cvt.row))}</td>
            <td style="padding:6px 8px">${srcBadge}</td>
          </tr>
        </table>
        ${gapHtml}
      </div>`;
    })()}

    ${divider}

    <!-- ACTIVE LISTINGS IN ZONE -->
    ${sectionLabel(`ACTIVE LISTINGS IN ZONE (QTY ${quantity}) — ${zoneListingCount} LISTINGS`)}
    ${zoneCountFlag}
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="color:#8899aa;font-size:11px;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #253047">
          <th style="padding:6px 8px;text-align:left;font-weight:600">#</th>
          <th style="padding:6px 8px;text-align:left;font-weight:600">PRICE</th>
          <th style="padding:6px 8px;text-align:left;font-weight:600">SECTION</th>
          <th style="padding:6px 8px;text-align:left;font-weight:600">ROW</th>
          <th style="padding:6px 8px;text-align:left;font-weight:600">QTY</th>
          <th style="padding:6px 8px;text-align:left;font-weight:600">SOURCE</th>
        </tr>
      </thead>
      <tbody>${activeRows}</tbody>
    </table>
    <div style="margin-top:8px;color:#8899aa;font-size:12px">
      Zone active floor: ${activeFloor !== null ? `$${activeFloor.toFixed(2)}/ticket` : 'N/A'} (base price, qty ${quantity} only)
    </div>
    ${atOrBelowActiveFloor ? `<div style="margin-top:6px;color:#00cc66;font-size:13px;font-weight:700">✅ YOUR TICKET IS AT/BELOW THE ZONE FLOOR</div>` : ''}

    ${divider}

    <!-- COMPLETED SALES -->
    ${sectionLabel(`COMPLETED SALES IN ZONE — LAST 14 DAYS — QTY ${quantity} ONLY — ${rawSales.length} SALES`)}
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="color:#8899aa;font-size:11px;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #253047">
          <th style="padding:6px 8px;text-align:left;font-weight:600">#</th>
          <th style="padding:6px 8px;text-align:left;font-weight:600">DATE</th>
          <th style="padding:6px 8px;text-align:left;font-weight:600">PRICE</th>
          <th style="padding:6px 8px;text-align:left;font-weight:600">SECTION</th>
          <th style="padding:6px 8px;text-align:left;font-weight:600">ROW</th>
          <th style="padding:6px 8px;text-align:left;font-weight:600">QTY</th>
        </tr>
      </thead>
      <tbody>${salesRows}</tbody>
    </table>
    <div style="margin-top:8px;color:#8899aa;font-size:12px">
      14-day recency-weighted avg (${salesData.count} sales): $${salesData.avg.toFixed(2)} &nbsp;|&nbsp; Floor of these sales: $${(completedFloor || 0).toFixed(2)}
    </div>
    <div style="margin-top:6px;color:#6b7280;font-size:11px;font-style:italic">
      Sell estimate based on exponential recency-weighted avg (half-life ~3 days). Today's sale ≈ weight 1.0, 3 days ago ≈ 0.37, 7 days ago ≈ 0.10. Most recent sale dominates.
    </div>
    ${belowCompletedFloor ? `<div style="margin-top:6px;color:#00cc66;font-size:13px;font-weight:700">✅ YOUR BUY PRICE ($${totalAllIn.toFixed(2)}) IS BELOW THE COMPLETED SALES FLOOR ($${completedFloor.toFixed(2)})</div>` : ''}

    ${divider}

    <!-- P&L -->
    ${sectionLabel('P&amp;L CALCULATION')}
    <div style="background:#0f1520;border-radius:8px;padding:20px 24px;font-size:14px">
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="padding:5px 0;color:#8899aa">Buy all-in (${quantity} × $${totalAllIn.toFixed(2)})</td>
          <td style="padding:5px 0;color:#ff4444;font-weight:700;text-align:right">−$${totalBuyCost}</td>
        </tr>
        <tr>
          <td style="padding:5px 0;color:#8899aa">${sellLabel}</td>
          <td style="padding:5px 0;color:#ffffff;text-align:right">$${grossRevenue}</td>
        </tr>
        <tr>
          <td style="padding:5px 0;color:#8899aa">Seller fee (${(effectiveSellerFeeForEmail * 100).toFixed(0)}%)</td>
          <td style="padding:5px 0;color:#ff4444;text-align:right">−$${sellerFeeAmt}</td>
        </tr>
        <tr>
          <td style="padding:5px 0;color:#ffffff;font-weight:700">Net from sale</td>
          <td style="padding:5px 0;color:#ffffff;font-weight:700;text-align:right">$${netRevenue}</td>
        </tr>
      </table>
      <div style="border-top:1px solid #253047;margin:12px 0"></div>
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="padding:4px 0;color:#ffffff;font-weight:700;font-size:16px">Total Profit</td>
          <td style="padding:4px 0;color:#00cc66;font-weight:700;font-size:20px;text-align:right">$${totalProfit}</td>
        </tr>
        <tr>
          <td style="padding:4px 0;color:#8899aa;font-size:13px">ROI</td>
          <td style="padding:4px 0;color:#00cc66;font-weight:700;font-size:18px;text-align:right">${roi.toFixed(1)}%</td>
        </tr>
      </table>
      ${cheapestVenueTicket ? `<div style="border-top:1px solid #253047;margin:12px 0"></div>
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="padding:4px 0;color:#8899aa;font-size:13px">Cheapest alternative in venue (qty ${quantity})</td>
          <td style="padding:4px 0;color:#00e5ff;font-size:13px;text-align:right">$${cheapestVenueTicket.allInPrice.toFixed(2)} all-in <span style="color:#00cc66">(you're $${(cheapestVenueTicket.allInPrice - (buyAllIn + (buyPlatform === 'TickPick' ? 0 : 3.50))).toFixed(2)} cheaper)</span></td>
        </tr>
      </table>` : ''}
      <div style="margin-top:10px;color:#4db8c8;font-size:11px">
        Sell benchmark = recency-weighted avg (7d=3×, 8–30d=2×, 31–60d=1×). Adjusts for active floor only when market is dropping (&gt;20% below avg).
      </div>
    </div>

    ${divider}

    <!-- LINKS -->
    ${sectionLabel('LINKS')}
    <div>
      ${checkoutUrl ? btn(checkoutUrl, '🛒', 'Buy Tickets', true) : ''}
      ${btn(stubhubEventLink, '📋', 'StubHub Event Page', false)}
      ${btn(tmSearchLink, '🎫', 'Ticketmaster Event Page', false)}
      ${btn(gmapsLink, '📍', 'Venue Map', false)}
    </div>

    ${divider}

    <!-- FLAGS -->
    ${sectionLabel('⚠ FLAGS')}
    ${flagsHtml}

    ${divider}

    <!-- FOOTER -->
    <div style="text-align:center;color:#4b5563;font-size:11px;padding-top:4px">
      Mr. Shmack Deal Scanner &nbsp;•&nbsp; ${escHtml(tsFormatted)} ET &nbsp;•&nbsp; Sell benchmark: recency-weighted avg (7d=3×, 30d=2×, 60d=1×)
    </div>

  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Gmail Email Sender (via gog CLI) ────────────────────────────────────────
function sendDealEmail(dealAlert, deal) {
  const subject = `[DEAL ALERT] ${dealAlert.eventName} — ${dealAlert.roi.toFixed(1)}% ROI | ${dealAlert.eventDate}`;
  const htmlBody = formatDealAlertHTML(dealAlert, deal);

  // Use execFileSync (no shell) to pass --body-html as a direct argument,
  // avoiding all shell-escaping / $(cat ...) substitution issues.
  try {
    execFileSync('gog', [
      'gmail', 'send',
      '--to',      CONFIG.email.to,
      '--account', CONFIG.email.account,
      '--subject', subject,
      '--body-html', htmlBody,
      '--force',
    ], { stdio: 'pipe', timeout: 30000 });
    log(`📧 Email sent: ${subject}`);
    return true;
  } catch (e) {
    log(`❌ Email send failed: ${e.message}`);
    // Fallback: write HTML to temp file and use --body-html @file approach via shell
    const tmpFile = path.join(__dirname, '.email-tmp.html');
    try {
      fs.writeFileSync(tmpFile, htmlBody, 'utf8');
      execSync(
        `gog gmail send --to ${CONFIG.email.to} --account ${CONFIG.email.account} --subject ${JSON.stringify(subject)} --body-html "$(cat ${JSON.stringify(tmpFile)})" --force`,
        { stdio: 'pipe', timeout: 30000 }
      );
      log(`📧 Email sent (fallback): ${subject}`);
      return true;
    } catch (e2) {
      log(`❌ Email send fallback failed: ${e2.message}`);
      return false;
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  }
}

// ─── Main Scanner ───────────────────────────────────────────────────────────
async function updateScoutStatus(status, taskSummary) {
  try {
    const client = new Client(DB_URL);
    await client.connect();
    await client.query(
      `UPDATE mc_factory_agents SET status=$1, task_summary=$2, updated_at=NOW()${status === 'active' ? ', started_at=NOW()' : ''} WHERE id='scout'`,
      [status, taskSummary]
    );
    await client.end();
  } catch(e) { /* non-fatal */ }
}

// Touch Scout's updated_at to prevent auto-idle from flipping it mid-scan
async function touchScout() {
  try {
    const client = new Client(DB_URL);
    await client.connect();
    await client.query(`UPDATE mc_factory_agents SET updated_at=NOW() WHERE id='scout' AND status='active'`);
    await client.end();
  } catch(e) { /* non-fatal */ }
}

async function runScanner() {
  log('========================================');
  log('Deal Scanner starting...');
  const scanStartTime = Date.now();
  log('========================================');

  // Move Scout to In Progress on Factory
  await updateScoutStatus('active', 'Scanning for deals...');

  const browser = await chromium.launch({ headless: true });
  const dealStore = loadDeals();
  const newDeals = [];

  try {
    // 1. Login to SeatData
    const { context, page } = await loginSeatData(browser);

    // ─── Helper: collect current listings from all platforms for a deal ──────
    async function collectListings(deal, page) {
      const allListings = [];
      const platformsChecked = [];

      // A) StubHub listings from the deal (if from SeatDeals widget)
      if (deal.price && deal.section) {
        const stubListings = getStubHubListingsFromDeal(deal);
        allListings.push(...stubListings);
        const stubCheapest = stubListings.length > 0
          ? Math.min(...stubListings.map(l => l.allInPrice))
          : null;
        platformsChecked.push({
          name: 'StubHub',
          available: true,
          cheapest: stubCheapest,
          feeNote: `+${(CONFIG.fees.stubhubBuyer * 100).toFixed(0)}% fee`,
        });
      } else {
        platformsChecked.push({ name: 'StubHub', available: false, cheapest: null, feeNote: 'no listing data' });
      }

      // B) TickPick - search for matching event
      try {
        const tpEvents = await searchTickPick(deal.event_name, deal.event_date);
        const tpMatch = matchTickPickEvent(tpEvents, deal.event_name, deal.event_date);
        if (tpMatch) {
          log(`  TickPick match: ${tpMatch.event_name} (${tpMatch.event_id})`);
          const tpListings = await getTickPickListings(tpMatch.event_id, page);
          // Filter to same zone/section area
          // Filter TickPick listings: only accept if section matches a section
          // from the deal's zone_sales (same logic as Top Events path).
          // This prevents cross-zone comparisons.
          const dealZoneSections = new Set(
            (deal.zone_sales || []).map(s => String(s.section || '').trim()).filter(Boolean)
          );
          const dealSec = String(deal.section || '').trim();
          // If we have zone_sales sections, use those. Otherwise fall back to exact section match.
          const relevantTp = tpListings.filter(l => {
            const tpSec = String(l.section || '').trim();
            if (dealZoneSections.size > 0) return dealZoneSections.has(tpSec);
            if (dealSec) return tpSec === dealSec;
            return false; // no section info = can't match
          });
          allListings.push(...relevantTp);
          const tpCheapest = relevantTp.length > 0
            ? Math.min(...relevantTp.map(l => l.allInPrice))
            : null;
          platformsChecked.push({
            name: 'TickPick',
            available: true,
            cheapest: tpCheapest,
            feeNote: 'NO FEES',
          });
          log(`  TickPick: ${relevantTp.length} relevant listings in zone`);
        } else {
          platformsChecked.push({ name: 'TickPick', available: true, cheapest: null, feeNote: 'no matching event' });
          log('  TickPick: no matching event found');
        }
      } catch (e) {
        platformsChecked.push({ name: 'TickPick', available: false, cheapest: null });
        log(`  TickPick error: ${e.message}`);
      }

      // C) SeatGeek
      try {
        const sgListings = await checkSeatGeekPrice(deal.event_name, deal.event_date, deal.section, page);
        if (sgListings.length > 0) {
          allListings.push(...sgListings);
          platformsChecked.push({
            name: 'SeatGeek',
            available: true,
            cheapest: Math.min(...sgListings.map(l => l.allInPrice)),
          });
        } else {
          platformsChecked.push({ name: 'SeatGeek', available: false, cheapest: null, feeNote: 'Cloudflare blocked' });
        }
      } catch (e) {
        platformsChecked.push({ name: 'SeatGeek', available: false, cheapest: null });
      }

      // D) Vivid Seats
      try {
        const vsListings = await checkVividSeatsPrice(deal.event_name, deal.event_date, deal.section);
        platformsChecked.push({
          name: 'VividSeats',
          available: vsListings.length > 0,
          cheapest: vsListings.length > 0 ? Math.min(...vsListings.map(l => l.allInPrice)) : null,
          feeNote: vsListings.length > 0 ? `+${(CONFIG.fees.vividBuyer * 100).toFixed(0)}% fee` : 'no data',
        });
      } catch (e) {
        platformsChecked.push({ name: 'VividSeats', available: false, cheapest: null });
      }

      // E) Gametime
      try {
        const gtListings = await fetchGametimeListings(deal.event_name, deal.event_date, deal.quantity || 2);
        if (gtListings && gtListings.length > 0) {
          allListings.push(...gtListings);
          const gtCheapest = Math.min(...gtListings.map(l => l.allInPrice));
          platformsChecked.push({
            name: 'Gametime',
            available: true,
            cheapest: gtCheapest,
            feeNote: `~${(gtListings[0].feeRate * 100).toFixed(0)}% fee (all-in shown)`,
          });
          log(`  Gametime: ${gtListings.length} listings — cheapest all-in $${gtCheapest.toFixed(2)}`);
        } else {
          platformsChecked.push({ name: 'Gametime', available: false, cheapest: null, feeNote: 'no matching listings' });
        }
      } catch (e) {
        platformsChecked.push({ name: 'Gametime', available: false, cheapest: null, feeNote: 'error' });
        log(`  Gametime error: ${e.message}`);
      }

      // F) Ticketmaster Resale
      platformsChecked.push({ name: 'TM Resale', available: false, cheapest: null, feeNote: 'API needed' });
      // G) AXS Resale
      platformsChecked.push({ name: 'AXS', available: false, cheapest: null, feeNote: 'limited' });

      return { allListings, platformsChecked };
    }

    // ─── Helper: compute sell benchmark from sales + active floor ────────────
    // ─── THREE-PRICE FRAMEWORK (Douglas-approved Mar 31 2026) ─────────────
    // Sell price = MIN(completed sales avg, active listings floor)
    // - If active < sales → undercut active by configured % (competing with live sellers)
    // - If sales ≤ active → use sales as-is (already below competition, proven price)
    function computeSellBenchmark(salesAnalysis, allListings, buyCost, dealQty, zoneActiveStats) {
      const completedSalesAvg = salesAnalysis.avg;

      // Active floor: prefer SeatData zone stats (most accurate), fallback to fetched listings
      let activeFloor = null;
      let activeSource = '';
      if (zoneActiveStats && zoneActiveStats.lowestPrice && zoneActiveStats.lowestPrice > 0) {
        activeFloor = zoneActiveStats.lowestPrice;
        activeSource = 'SeatData zone stats';
      } else {
        // Fallback: use any StubHub listings we have from the deal or scrape
        const activeFloorRaw = allListings
          .filter(l => l.platform === 'StubHub' && Number(l.quantity) === Number(dealQty))
          .reduce((min, l) => Math.min(min, l.price), Infinity);
        if (activeFloorRaw < Infinity) {
          activeFloor = activeFloorRaw;
          activeSource = 'StubHub listings';
        }
      }

      // Undercut settings from DB
      const undercutMode = CONFIG.autoList?.undercutMode || 'percent';
      const undercutPct = parseFloat(CONFIG.autoList?.undercutPct || 5) / 100;
      const undercutDollars = parseFloat(CONFIG.autoList?.undercutDollars || 2);

      let sellBenchmarkPrice;
      let benchmarkSource;

      if (activeFloor === null) {
        // No active listings data — use completed sales avg only
        sellBenchmarkPrice = completedSalesAvg;
        benchmarkSource = `completed sales avg $${completedSalesAvg.toFixed(2)} (no active listings data)`;
      } else if (activeFloor < completedSalesAvg) {
        // Market dropped — active listings are cheaper than what sold before
        // Undercut the active floor to compete with live sellers
        const undercut = undercutMode === 'percent'
          ? activeFloor * undercutPct
          : undercutDollars;
        sellBenchmarkPrice = activeFloor - undercut;
        benchmarkSource = `active floor $${activeFloor.toFixed(2)} (${activeSource}) - ${undercutMode === 'percent' ? (undercutPct*100)+'%' : '$'+undercutDollars} undercut = $${sellBenchmarkPrice.toFixed(2)} (market dropped below historical sales)`;
      } else {
        // Active listings are at or above completed sales — use sales price as-is
        // No undercut needed — you're already below all active listings at this price
        sellBenchmarkPrice = completedSalesAvg;
        benchmarkSource = `completed sales avg $${completedSalesAvg.toFixed(2)} (active floor $${activeFloor.toFixed(2)} from ${activeSource} is higher — price at proven sell level)`;
      }

      return { sellBenchmarkPrice, benchmarkSource, activeFloor, activeSource };
    }

    // ─── Helper: process a single deal candidate ────────────────────────────
    async function processDealCandidate(deal, page, source) {
      log(`\nAnalyzing deal [${source}]: ${deal.event_name} (${deal.event_date})`);

      // Check event timing
      const hoursOut = hoursUntil(deal.event_date, deal.event_time);
      const daysOut = daysUntil(deal.event_date);
      if (hoursOut < CONFIG.thresholds.minHoursOut) {
        log(`  Skipping: event is only ${hoursOut.toFixed(1)}h away (min: ${CONFIG.thresholds.minHoursOut}h)`);
        return null;
      }
      if (daysOut > CONFIG.thresholds.maxDaysOut) {
        log(`  Skipping: event is ${daysOut} days away (max: ${CONFIG.thresholds.maxDaysOut})`);
        return null;
      }

      // Quantity note
      const dealQty = deal.quantity || 2;
      if (dealQty < CONFIG.thresholds.minQuantity) {
        log(`  Note: quantity is ${dealQty} (below min ${CONFIG.thresholds.minQuantity}), but still checking`);
      }

      // Analyze completed sales (with outlier filtering)
      const salesAnalysis = analyzeZoneSales(deal.zone_sales, dealQty, deal.zone);
      if (!salesAnalysis) {
        log(`  Insufficient completed sales (need ${CONFIG.thresholds.minCompletedSales} clean sales in ${CONFIG.thresholds.salesWindowDays}d window) — skipping`);
        return null;
      }

      log(`  Zone: ${deal.zone} | Qty=${dealQty} Sales: ${salesAnalysis.count} | Avg: $${salesAnalysis.avg.toFixed(2)} | Floor: $${salesAnalysis.floor.toFixed(2)}`);

      // Collect CURRENT LISTINGS from all platforms (Fix #5)
      const { allListings, platformsChecked } = await collectListings(deal, page);

      // Find the best buy from CURRENT LISTINGS (not completed sales)
      const availableListings = allListings.filter(l => l.allInPrice > 0);
      if (availableListings.length === 0) {
        log('  No current listings found across platforms');
        return null;
      }

      availableListings.sort((a, b) => a.allInPrice - b.allInPrice);
      const bestBuy = availableListings[0];
      const buyCost = bestBuy.allInPrice;

      // Build zone active stats from SeatDeals widget's next_prices_in_zone
      let seatDealsZoneStats = null;
      if (deal.next_prices_in_zone?.listings?.length > 0) {
        const zonePrices = deal.next_prices_in_zone.listings
          .map(l => parseFloat(l.price))
          .filter(p => p > 0)
          .sort((a, b) => a - b);
        if (zonePrices.length > 0) {
          seatDealsZoneStats = {
            lowestPrice: zonePrices[0],
            median: zonePrices[Math.floor(zonePrices.length / 2)],
            mean: zonePrices.reduce((s, p) => s + p, 0) / zonePrices.length,
          };
          log(`  SeatDeals zone active listings: ${zonePrices.length} listings, lowest=$${seatDealsZoneStats.lowestPrice}, median=$${seatDealsZoneStats.median}`);
        }
      }

      // Compute sell benchmark using three-price framework
      let { sellBenchmarkPrice, benchmarkSource } = computeSellBenchmark(salesAnalysis, allListings, buyCost, dealQty, seatDealsZoneStats);

      // ─── CANONICAL ROI CALCULATION (Fix #2, #3) ─────────────────────────
      let canonicalROI = calculateROI(sellBenchmarkPrice, CONFIG.fees.sellerFee, buyCost);
      let sellerNet = sellBenchmarkPrice * (1 - CONFIG.fees.sellerFee);
      let profit = sellerNet - buyCost;

      log(`  Best buy: $${bestBuy.price} on ${bestBuy.platform} (all-in: $${buyCost.toFixed(2)}) — Sec ${bestBuy.section} Row ${bestBuy.row}`);
      log(`  Sell benchmark: $${sellBenchmarkPrice.toFixed(2)} (${benchmarkSource}) → net $${sellerNet.toFixed(2)}`);
      log(`  Profit: $${profit.toFixed(2)} | ROI: ${canonicalROI.toFixed(1)}%`);

      // ─── FINAL GATE CHECK (Fix #2) — if ROI < min_roi, do NOT email/log ──
      if (canonicalROI < CONFIG.thresholds.minROI) {
        log(`  Below ROI threshold (${canonicalROI.toFixed(1)}% < ${CONFIG.thresholds.minROI}%). Skipping.`);
        return null;
      }

      // Fetch live StubHub listings for sell benchmark verification
      let skipDeal = false;
      log('  Fetching live StubHub listings for verification...');
      const liveStubHubListings = await fetchStubHubListings(
        deal.event_name, deal.event_date, deal.zone,
        bestBuy.quantity || dealQty,
        deal.event_id || deal.stubhubEventId
      );
      if (liveStubHubListings && liveStubHubListings.length > 0) {
        log(`  Live StubHub: ${liveStubHubListings.length} listings returned`);
        
        // Filter to same zone level
        const dealSection = parseInt(deal.section || bestBuy.section || '0');
        const dealLevel = Math.floor(dealSection / 100) * 100;
        const zoneLive = liveStubHubListings.filter(l => {
          const sec = parseInt(l.section);
          return !isNaN(sec) && Math.floor(sec / 100) * 100 === dealLevel;
        });
        const liveFloorEntry = zoneLive.length > 0 ? zoneLive[0] : (liveStubHubListings[0] || null);
        const liveFloor = liveFloorEntry?.price || null;
        // If scraped (isScraped), price IS already all-in. If from API, add buyer fee.
        const liveFloorAllIn = liveFloorEntry?.isScraped 
          ? liveFloor 
          : (liveFloor ? liveFloor * (1 + CONFIG.fees.stubhubBuyer) : null);
        
        log(`  Live StubHub zone floor: $${liveFloorAllIn?.toFixed(2) || '?'} all-in${liveFloorEntry?.isScraped ? ' (scraped, already incl. fees)' : ''} (${zoneLive.length} zone listings)`);
        
        // CRITICAL FIX: If live floor is significantly lower than our sell benchmark,
        // override the benchmark. This prevents alerting deals that can't actually sell
        // at the benchmarked price because active listings are much cheaper.
        if (liveFloorAllIn && sellBenchmarkPrice && liveFloorAllIn < sellBenchmarkPrice * 0.85) {
          const oldBenchmark = sellBenchmarkPrice;
          sellBenchmarkPrice = liveFloorAllIn;
          benchmarkSource = `LIVE StubHub floor ($${liveFloorAllIn.toFixed(2)} all-in) — overrides stale benchmark ($${oldBenchmark.toFixed(2)})`;
          log(`  🛑 BENCHMARK OVERRIDE: $${oldBenchmark.toFixed(2)} → $${liveFloorAllIn.toFixed(2)} (live floor is ${((1 - liveFloorAllIn/oldBenchmark) * 100).toFixed(0)}% lower)`);
          
          // Recalculate ROI with corrected benchmark
          const newRevenue = sellBenchmarkPrice * (1 - CONFIG.fees.sellerFee);
          canonicalROI = ((newRevenue - buyCost) / buyCost) * 100;
          log(`  Recalculated ROI: ${canonicalROI.toFixed(1)}% (was based on stale data)`);
          
          // If ROI dropped below minimum, this deal should be skipped
          if (canonicalROI < CONFIG.thresholds.minROI) {
            log(`  ❌ ROI ${canonicalROI.toFixed(1)}% < min ${CONFIG.thresholds.minROI}% after live price correction — SKIPPING DEAL`);
            skipDeal = true;
          }
        }
        
        // Add live listings to allListings for zone count display
        for (const l of zoneLive) {
          if (!allListings.some(a => a.listingId === l.listingId && a.platform === 'StubHub')) {
            allListings.push({
              platform: 'StubHub',
              section: l.section,
              row: l.row,
              quantity: l.quantity,
              price: l.price,
              allInPrice: l.price * (1 + CONFIG.fees.stubhubBuyer),
              feeRate: CONFIG.fees.stubhubBuyer,
              listingId: l.listingId,
              zone: deal.zone,
              isDeal: false,
              isLive: true,
            });
          }
        }
        log(`  Zone listings after live merge: ${allListings.filter(l => l.platform === 'StubHub').length}`);
      } else {
        log('  Live StubHub unavailable — using cached data only');
      }

      // Skip deal if live price check invalidated it
      if (skipDeal) {
        log('  Deal skipped after live price correction');
        return null;
      }

      // Build deal alert — pass pre-calculated ROI (Fix #3)
      const gtListingsForAlert = allListings.filter(l => l.platform === 'Gametime');
      const cheapestVenueTicket = findCheapestVenueTicket(allListings, bestBuy.section, bestBuy.quantity || dealQty);
      if (cheapestVenueTicket) {
        log(`  Cheapest venue alt: $${cheapestVenueTicket.allInPrice.toFixed(2)} — Sec ${cheapestVenueTicket.section} Row ${cheapestVenueTicket.row} on ${cheapestVenueTicket.platform}`);
      }

      const dealAlert = buildDealAlert(
        deal, bestBuy, salesAnalysis, allListings, platformsChecked,
        liveStubHubListings,
        gtListingsForAlert.length > 0 ? gtListingsForAlert : null,
        cheapestVenueTicket,
        canonicalROI,           // pre-calculated ROI
        sellBenchmarkPrice,     // pre-calculated sell benchmark
        CONFIG.fees.sellerFee   // seller fee used
      );

      // ─── DEDUPLICATION (Fix #4 + cross-run time-based dedup) ─────────────
      // Re-read deals file to catch deals saved by concurrent/recent runs
      let freshStore;
      try { freshStore = loadDeals(); } catch (e) { freshStore = dealStore; }
      const dedupSource = freshStore.sentDeals.length > dealStore.sentDeals.length ? freshStore.sentDeals : dealStore.sentDeals;

      // Permanent dedup — once a deal is sent for this event+zone+platform, never send again.
      // No time window. Douglas explicitly said "never send the same deal again, even after 2 hours."
      const isDuplicateLocal = dedupSource.some(d =>
        d.eventName === dealAlert.eventName &&
        d.buyPlatform === dealAlert.buyPlatform &&
        Math.abs(d.buyAllIn - dealAlert.buyAllIn) < 5
      );

      if (isDuplicateLocal) {
        log(`  Already alerted on this deal (permanent dedup). Skipping.`);
        return null;
      }

      // Check DB for same event+zone presented deal
      const stubhubEventId = deal.event_id || deal.stubhubEventId || deal.stubhub_event_id || null;
      let existingDealId = null;
      try {
        existingDealId = await checkDuplicateDeal(stubhubEventId, deal.zone);
        if (existingDealId) {
          log(`  Found existing deal in DB (id=${existingDealId}) — will update instead of duplicate`);
        }
      } catch (e) {
        log(`  DB dedup check failed: ${e.message} — proceeding as new deal`);
      }

      // ─── SECOND ROI GATE CHECK (post-live-StubHub) ──────────────────────
      // The buildDealAlert may have adjusted sell benchmark based on live data.
      // Re-check the final ROI from dealAlert.
      if (dealAlert.roi < CONFIG.thresholds.minROI) {
        log(`  ROI dropped below threshold after live data adjustment (${dealAlert.roi.toFixed(1)}% < ${CONFIG.thresholds.minROI}%). Skipping.`);
        return null;
      }

      // Write to deal log (Fix #4 — update if exists)
      try {
        await writeDealLog(dealAlert, existingDealId);
      } catch (e) {
        log(`  ⚠️ Deal log write failed: ${e.message}`);
      }

      log(`  ✅ DEAL FOUND! ROI: ${canonicalROI.toFixed(1)}%`);
      console.log('\n' + dealAlert.alert + '\n');

      // Incremental save — write to disk immediately so concurrent runs see this deal
      dealStore.sentDeals.push({
        eventName: dealAlert.eventName,
        section: dealAlert.section,
        row: dealAlert.row,
        buyPlatform: dealAlert.buyPlatform,
        buyAllIn: dealAlert.buyAllIn,
        timestamp: dealAlert.timestamp,
      });
      saveDeals(dealStore);

      return { dealAlert, deal, existingDealId };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PATH 1: SeatDeals widget (legacy)
    // ═══════════════════════════════════════════════════════════════════════
    const seatDeals = await getSeatDeals(page);
    log(`\n=== Processing ${seatDeals.length} SeatDeals ===`);

    for (const deal of seatDeals) {
      const result = await processDealCandidate(deal, page, 'SeatDeals');
      if (result) newDeals.push(result);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PATH 2: Top events scan (independent)
    // ═══════════════════════════════════════════════════════════════════════
    if (CONFIG.topEventsEnabled) {
      log('\n=== Scanning Top Events ===');
      // Navigate to Event Analytics page — events_appstack API requires this page context
      // (returns 500 from dashboard but works from /dashboard/sold-listings)
      try {
        await page.goto(`${CONFIG.seatdata.baseUrl}/dashboard/sold-listings`, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(3000);
      } catch (e) {
        log(`  Warning: Could not navigate to Event Analytics: ${e.message}`);
      }
      const topEvents = await getTopEvents(page, 500);

      // Load zone cache for SeatData sales data
      const zoneCachePath = path.join(__dirname, 'zone-cache.json');
      let zoneCache = {};
      try {
        zoneCache = JSON.parse(fs.readFileSync(zoneCachePath, 'utf8'));
      } catch (e) {
        log('  No zone cache found — will scrape fresh');
      }

      let topSkipNoId = 0, topSkipRange = 0, topSkipNoSales = 0, topProcessed = 0;

      // Deduplicate events by internalId, filter by timing
      const seen = new Set();
      const candidateEvents = [];
      for (const evt of topEvents) {
        if (!evt.stubhubEventId) { topSkipNoId++; continue; }
        const hoursOut = hoursUntil(evt.date, null);
        const daysOut = daysUntil(evt.date);
        if (hoursOut < CONFIG.thresholds.minHoursOut || daysOut > CONFIG.thresholds.maxDaysOut) { topSkipRange++; continue; }
        const cacheKey = String(evt.internalId || evt.stubhubEventId || '');
        if (seen.has(cacheKey)) continue;
        seen.add(cacheKey);
        candidateEvents.push({ evt, cacheKey });
      }

      // For each candidate: use zone cache if fresh, otherwise fetch live from SeatData
      const filteredEvents = [];
      for (const { evt, cacheKey } of candidateEvents) {
        let sales = zoneCache[cacheKey]?.sales || [];
        if (sales.length === 0 && evt.internalId) {
          // Cache miss — fetch live zone sales from SeatData
          sales = await fetchZoneSalesForEvent(evt.internalId, page);
          if (sales.length > 0) {
            // Update cache so next run is instant
            zoneCache[cacheKey] = { sales, cachedAt: new Date().toISOString() };
          }
        }
        if (sales.length === 0) { topSkipNoSales++; continue; }
        filteredEvents.push({ evt, cacheKey, cachedSales: sales });
      }

      // Persist refreshed cache
      try {
        fs.writeFileSync(path.join(__dirname, 'zone-cache.json'), JSON.stringify(zoneCache, null, 2));
      } catch (e) { /* non-fatal */ }

      log(`Top Events: ${filteredEvents.length} unique events in range with cached sales`);

      // Limit to 30 events per scan to stay within cron timeout.
      // Sort by number of cached sales (more sales = more reliable benchmark = better deals)
      filteredEvents.sort((a, b) => b.cachedSales.length - a.cachedSales.length);
      const eventsToProcess = filteredEvents.slice(0, 30);
      log(`Processing top ${eventsToProcess.length} events (of ${filteredEvents.length} candidates)`);

      for (const { evt, cacheKey, cachedSales } of eventsToProcess) {
        log(`\n--- Top Event: ${evt.name} (${evt.date}) [id=${evt.stubhubEventId}] ---`);
        topProcessed++;
        // Keep Scout alive in Factory — prevents auto-idle from flipping mid-scan
        if (topProcessed % 10 === 0) await touchScout();

        // Normalize zone_sales timestamps once per event
        const normalizedSales = cachedSales.map(s => ({
          date: s.timestamp ? (() => {
            try { return new Date(s.timestamp.replace(/(\d{2})-(\d{2})-(\d{2})/, '20$3-$1-$2')).toISOString(); } catch(e) { return new Date().toISOString(); }
          })() : new Date().toISOString(),
          price: parseFloat(s.price),
          section: s.section,
          row: s.row,
          quantity: parseInt(s.quantity) || 0,  // keep 0 for unknown — strict qty match will correctly reject
          zone: s.zone,
        }));

        // Fetch platform listings ONCE per event (not per zone) to avoid N×slow-API calls
        const evtDeal = {
          event_name: evt.name,
          event_date: evt.date,
          event_time: null,
          venue: evt.venue,
          zone: '',
          quantity: 2,
          section: null,
          row: null,
          price: null,
          event_id: evt.stubhubEventId,
          stubhubEventId: evt.stubhubEventId,
          event_url: `https://www.stubhub.com/event/${evt.stubhubEventId}`,
          checkout_url: null,
          next_prices_in_zone: null,
          next_zone_price: null,
        };

        // PRE-CHECK: Analyze sales data BEFORE fetching any listings.
        // If no zone has enough sales to meet the minimum threshold, skip the event entirely.
        // This avoids wasting API calls on events with no deal potential.
        const zoneGroupsPreCheck = {};
        for (const s of normalizedSales) {
          const z = (s.zone || '').trim();
          if (!z) continue;
          if (!zoneGroupsPreCheck[z]) zoneGroupsPreCheck[z] = [];
          zoneGroupsPreCheck[z].push(s);
        }
        const hasViableZone = Object.values(zoneGroupsPreCheck).some(sales => {
          // Quick check: does this zone have enough same-qty sales?
          // Filter by qty=2 (default) since we don't know the buy qty yet
          const minSales = CONFIG.thresholds.minCompletedSales || 3;
          const qtyMatched = sales.filter(s => Number(s.quantity) === 2 || Number(s.quantity) === 0);
          return qtyMatched.length >= minSales;
        });
        if (!hasViableZone) {
          log(`  No zone has enough qty-matched sales data — skipping event`);
          continue;
        }

        // Fetch listings from TickPick + Gametime ONLY (fast APIs).
        // SeatGeek/Vivid/TM/AXS never return useful data — skip them for speed.
        // StubHub is deferred to verification step after ROI passes.
        let evtListings = [];
        let evtPlatformsChecked = [];
        try {
          // TickPick
          const tpEvents = await searchTickPick(evt.name, evt.date);
          const tpMatch = matchTickPickEvent(tpEvents, evt.name, evt.date);
          if (tpMatch) {
            log(`  TickPick match: ${tpMatch.event_name} (${tpMatch.event_id})`);
            const tpListings = await getTickPickListings(tpMatch.event_id, page);
            evtListings.push(...tpListings);
            evtPlatformsChecked.push({ name: 'TickPick', available: true, cheapest: tpListings.length > 0 ? Math.min(...tpListings.map(l => l.allInPrice)) : null, feeNote: 'NO FEES' });
          } else {
            evtPlatformsChecked.push({ name: 'TickPick', available: true, cheapest: null, feeNote: 'no matching event' });
            log('  TickPick: no matching event found');
          }
        } catch(e) { log(`  TickPick error: ${e.message}`); }
        try {
          // Gametime
          const gtListings = await fetchGametimeListings(evt.name, evt.date, 2);
          if (gtListings && gtListings.length > 0) {
            evtListings.push(...gtListings);
            evtPlatformsChecked.push({ name: 'Gametime', available: true, cheapest: Math.min(...gtListings.map(l => l.allInPrice)) });
            log(`  Gametime: ${gtListings.length} listings`);
          } else {
            evtPlatformsChecked.push({ name: 'Gametime', available: false, cheapest: null });
          }
        } catch(e) { log(`  Gametime error: ${e.message}`); }

        if (evtListings.length === 0) {
          log(`  No listings found on TickPick/Gametime — skipping event`);
          continue;
        }

        // StubHub verification is deferred — only fires if a deal passes ROI threshold
        let evtLiveStubHub = null;
        let stubHubFetched = false;

        // ZONE MATCHING: StubHub defines zone boundaries via SeatData completed sales.
        // Each sale has a zone name AND a section number. We use this to build a
        // zone→sections map. Then any buy listing (from ANY platform) whose section
        // appears in that zone's section list is a valid match.
        // Example: Zone "Lower Sideline" has sales in Sec 101,102,103,104.
        //   → Gametime listing in Sec 103 = match, regardless of what Gametime calls the zone.
        const zoneGroups = {};
        const zoneSections = {}; // zone name → Set of section numbers seen in sales
        for (const s of normalizedSales) {
          const z = (s.zone || '').trim();
          if (!z) continue;
          if (!zoneGroups[z]) { zoneGroups[z] = []; zoneSections[z] = new Set(); }
          zoneGroups[z].push(s);
          const sec = String(s.section || '').trim();
          if (sec) zoneSections[z].add(sec);
        }

        for (const [zoneName, zoneSales] of Object.entries(zoneGroups)) {
          const validSections = zoneSections[zoneName];
          if (!validSections || validSections.size === 0) continue;

          // Find cheapest buy listing whose SECTION is in this zone's section set
          // Works across all platforms — doesn't depend on zone label matching
          const zoneListings = evtListings.filter(l => {
            if (l.allInPrice <= 0) return false;
            const lSec = String(l.section || '').trim();
            return validSections.has(lSec);
          }).sort((a, b) => a.allInPrice - b.allInPrice);

          if (zoneListings.length === 0) continue; // no buy listing in any section of this zone
          const bestBuy = zoneListings[0];
          const buyCost = bestBuy.allInPrice;

          // Analyze this zone's completed sales (with outlier filtering)
          const salesAnalysis = analyzeZoneSales(zoneSales, bestBuy.quantity || 2, zoneName);
          if (!salesAnalysis) continue;

          // Fetch zone-level active listing stats from SeatData
          const zoneActiveStats = await fetchZoneActiveStats(evt.internalId || cacheKey, zoneName, page);
          if (zoneActiveStats) {
            log(`  Zone "${zoneName}" active stats: lowest=$${zoneActiveStats.lowestPrice} | median=$${zoneActiveStats.median} | mean=$${zoneActiveStats.mean}`);
            
            // OUTLIER DETECTION: If lowest is NOT significantly below median, no deal
            // lowest vs median gap < 30% → every listing is similarly priced → no outlier
            if (zoneActiveStats.median && zoneActiveStats.lowestPrice) {
              const gapPct = (zoneActiveStats.median - zoneActiveStats.lowestPrice) / zoneActiveStats.median;
              if (gapPct < 0.30) {
                log(`  Zone "${zoneName}": lowest ($${zoneActiveStats.lowestPrice}) is only ${(gapPct*100).toFixed(0)}% below median ($${zoneActiveStats.median}) — no outlier, skipping`);
                continue;
              }
            }
          }

          // Compute sell benchmark using three-price framework
          const { sellBenchmarkPrice, benchmarkSource, activeFloor } = computeSellBenchmark(salesAnalysis, evtListings, buyCost, bestBuy.quantity || 2, zoneActiveStats);

          // Canonical ROI check
          const canonicalROI = calculateROI(sellBenchmarkPrice, CONFIG.fees.sellerFee, buyCost);
          if (canonicalROI < CONFIG.thresholds.minROI) continue;

          log(`  Zone "${zoneName}": ROI=${canonicalROI.toFixed(1)}% | buy=$${buyCost.toFixed(2)} on ${bestBuy.platform} (Sec ${bestBuy.section}) | sell=$${sellBenchmarkPrice.toFixed(2)} | active floor=$${activeFloor || '?'}`);

          // Build the synthetic deal for this zone
          const syntheticDeal = {
            event_name: evt.name,
            event_date: evt.date,
            event_time: null,
            venue: evt.venue,
            zone: zoneName,
            zone_sales: zoneSales,
            event_id: evt.stubhubEventId,
            stubhubEventId: evt.stubhubEventId,
            quantity: bestBuy.quantity || 2,
            section: bestBuy.section,
            row: bestBuy.row,
            price: bestBuy.price,
            event_url: `https://www.stubhub.com/event/${evt.stubhubEventId}`,
            checkout_url: bestBuy.checkoutUrl || null,
            next_prices_in_zone: null,
            next_zone_price: null,
          };

          // Check for duplicate in local store and DB
          const isDuplicateLocal = dealStore.sentDeals.some(d =>
            d.eventName === evt.name && d.buyPlatform === bestBuy.platform &&
            Math.abs(d.buyAllIn - buyCost) < 5
          );
          if (isDuplicateLocal) { log(`  Already alerted (local). Skipping zone ${zoneName}.`); continue; }

          let existingDealId = null;
          try {
            existingDealId = await checkDuplicateDeal(evt.stubhubEventId, zoneName);
            if (existingDealId) log(`  Found existing DB deal (id=${existingDealId}) — will update`);
          } catch (e) { log(`  DB dedup check failed: ${e.message}`); }

          // Lazy fetch: only scrape StubHub if this zone already passes ROI on SeatData alone
          if (!stubHubFetched) {
            try {
              evtLiveStubHub = await fetchStubHubListings(evt.name, evt.date, '', 2, evt.stubhubEventId);
            } catch(e) { /* non-fatal */ }
            stubHubFetched = true;
          }
          const liveStubHub = evtLiveStubHub;

          const gtListings = evtListings.filter(l => l.platform === 'Gametime');
          const cheapestVenueTicket = findCheapestVenueTicket(evtListings, bestBuy.section, bestBuy.quantity || 2);

          const dealAlert = buildDealAlert(
            syntheticDeal, bestBuy, salesAnalysis, evtListings, evtPlatformsChecked,
            liveStubHub, gtListings.length > 0 ? gtListings : null, cheapestVenueTicket,
            canonicalROI, sellBenchmarkPrice, CONFIG.fees.sellerFee
          );

          if (dealAlert.roi < CONFIG.thresholds.minROI) continue;

          try { await writeDealLog(dealAlert, existingDealId); } catch (e) { log(`  Deal log write failed: ${e.message}`); }

          log(`  ✅ TOP EVENT DEAL FOUND! ${evt.name} / ${zoneName} — ROI: ${canonicalROI.toFixed(1)}%`);
          console.log('\n' + dealAlert.alert + '\n');

          // Incremental save for Top Events too
          dealStore.sentDeals.push({
            eventName: dealAlert.eventName,
            section: dealAlert.section,
            row: dealAlert.row,
            buyPlatform: dealAlert.buyPlatform,
            buyAllIn: dealAlert.buyAllIn,
            timestamp: dealAlert.timestamp,
          });
          saveDeals(dealStore);

          newDeals.push({ dealAlert, deal: syntheticDeal, existingDealId });
        }
      }
      log(`Top Events summary: ${topProcessed} events scanned, ${topSkipNoId} no StubHub ID, ${topSkipRange} out of date range, ${topSkipNoSales} no cached sales`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Save results
    // ═══════════════════════════════════════════════════════════════════════
    const allDealAlerts = newDeals.map(r => r.dealAlert);
    dealStore.allDeals.push(...allDealAlerts);
    // Note: sentDeals already updated incrementally per-deal above — no bulk push needed
    saveDeals(dealStore);

    if (dealStore.sentDeals.length > 200) {
      dealStore.sentDeals = dealStore.sentDeals.slice(-200);
      saveDeals(dealStore);
    }

    await context.close();
  } catch (e) {
    log(`Scanner error: ${e.message}`);
    console.error(e);
  } finally {
    await browser.close();
  }

  // Summary
  log('');
  log('========================================');
  log(`Scan complete. Found ${newDeals.length} new deal(s).${DRY_RUN ? ' [DRY RUN]' : ''}`);
  log('========================================');

  // Move Scout back to idle on Factory with scan summary
  const nextScanMin = CONFIG.scanFrequencyMin || 20;
  const scanEndTime = Date.now();
  const scanDurationSec = Math.round((scanEndTime - scanStartTime) / 1000);
  const scanMin = Math.floor(scanDurationSec / 60);
  const scanSec = scanDurationSec % 60;
  const durationStr = scanMin > 0 ? `${scanMin}m ${scanSec}s` : `${scanSec}s`;
  const summary = `✅ ${newDeals.length} deal | ${durationStr} — next scan in ${nextScanMin}m`;
  await updateScoutStatus('idle', summary);

  return newDeals.map(r => r.dealAlert);
}

// ─── Entry Point ────────────────────────────────────────────────────────────
(async () => {
  // Load rules from DB first
  try {
    await loadRulesFromDB();
  } catch (e) {
    log(`⚠️  Failed to load rules from DB: ${e.message} — using defaults`);
  }

  // Check scanner_enabled flag
  if (!CONFIG.scannerEnabled) {
    log('🛑 Scanner is DISABLED in mc_scanner_rules. Exiting.');
    process.exit(0);
  }

  if (DRY_RUN) {
    log('🧪 DRY RUN MODE — no emails, no deal_log writes, no Telegram alerts');
  }

  const deals = await runScanner();

  if (deals.length > 0) {
    if (DRY_RUN) {
      log(`\n🧪 [DRY RUN] Would have sent ${deals.length} deal email(s) and Telegram alerts:`);
      for (const d of deals) {
        log(`  📧 ${d.eventName} — ROI: ${d.roi.toFixed(1)}% — Buy: $${d.buyAllIn.toFixed(2)} on ${d.buyPlatform} — Sell: $${d.sellBenchmark.toFixed(2)}`);
      }
      // Save dry run output to file
      const dryRunOutput = deals.map(d => ({
        event: d.eventName,
        date: d.eventDate,
        zone: d.zone,
        section: d.section,
        row: d.row,
        quantity: d.quantity,
        buyPlatform: d.buyPlatform,
        buyPrice: d.buyPrice,
        buyAllIn: d.buyAllIn,
        sellBenchmark: d.sellBenchmark,
        sellerNet: d.sellerNet,
        roi: d.roi,
        profit: d.profit,
        flags: d.flags,
      }));
      fs.writeFileSync(path.join(__dirname, 'dry-run-output.json'), JSON.stringify(dryRunOutput, null, 2));
      log(`\n📄 Dry run output saved to dry-run-output.json`);
      process.exit(0);
    }

    log(`\n🔍 Verifying ${deals.length} deal(s) before sending...`);

    // ═══════════════════════════════════════════════════════════════════════
    // DEAL VERIFICATION GATE — every deal must pass ALL checks before email
    // ═══════════════════════════════════════════════════════════════════════
    function verifyDeal(d) {
      const failures = [];

      // 1. EVENT MATCH: reserved for future use (Gametime name-overlap check happens earlier in scan)
      // NOTE: "Gametime is CHEAPER" flag compares venue-wide floor vs zone-specific buy.
      // This is NOT a valid rejection — a $4 upper-deck ticket doesn't invalidate a $32 lower-zone deal.

      // 2. ZONE MATCH: buy section must appear in completed sales sections
      const salesSections = new Set(
        (d.salesData?.sales || []).map(s => String(s.section || '').trim()).filter(Boolean)
      );
      if (salesSections.size > 0 && d.section) {
        const buySec = String(d.section).trim();
        if (!salesSections.has(buySec)) {
          // Check if ANY section in the same zone has sales (zone-level match via zone name)
          // The buy section should at minimum be in the same zone as the completed sales
          failures.push(`ZONE MISMATCH: Buy section ${buySec} not found in completed sales sections [${[...salesSections].join(',')}]`);
        }
      }

      // 3. QTY MATCH: all completed sales must match deal qty
      if (d.salesData?.sales && d.quantity) {
        const wrongQty = d.salesData.sales.filter(s => {
          const sq = Number(s.quantity);
          return sq !== 0 && sq !== Number(d.quantity);
        });
        if (wrongQty.length > 0) {
          failures.push(`QTY MISMATCH: ${wrongQty.length} of ${d.salesData.sales.length} sales have wrong qty (deal is qty ${d.quantity})`);
        }
      }

      // 4. BENCHMARK SANITY: sell benchmark shouldn't be >2x the most recent sale
      if (d.salesData?.sales?.length > 0 && d.sellBenchmark) {
        const mostRecent = d.salesData.sales[0]; // already sorted by recency
        const recentPrice = parseFloat(mostRecent.price);
        if (recentPrice > 0 && d.sellBenchmark > recentPrice * 2) {
          failures.push(`BENCHMARK INFLATED: sell benchmark $${d.sellBenchmark.toFixed(2)} is >2x most recent sale $${recentPrice.toFixed(2)}`);
        }
      }

      // 5. ROI SANITY: if ROI > 500%, it's almost certainly bad data
      if (d.roi > 500) {
        failures.push(`ROI SUSPICIOUS: ${d.roi.toFixed(1)}% is unrealistically high — likely bad data`);
      }

      // 6. SELL BENCHMARK vs ZONE FLOOR: check live StubHub listings IN THE SAME ZONE
      // Filter StubHub listings to only sections that appear in the completed sales
      if (d.liveStubHubUsed && d.liveStubHubListings?.length > 0) {
        const zoneLive = d.liveStubHubListings.filter(l => salesSections.has(String(l.section || '').trim()));
        const zoneFloor = zoneLive.length > 0 ? Math.min(...zoneLive.map(l => l.price)) : null;
        if (zoneFloor && d.sellBenchmark > zoneFloor * 1.5) {
          failures.push(`ZONE FLOOR DIVERGENCE: sell benchmark $${d.sellBenchmark.toFixed(2)} is >50% above live StubHub zone floor $${zoneFloor} (same-zone sections only)`);
        }
        // Also check venue-wide
        const venueFloor = d.liveStubHubListings[0]?.price;
        if (venueFloor && d.sellBenchmark > venueFloor * 2.5) {
          failures.push(`VENUE FLOOR DIVERGENCE: sell benchmark $${d.sellBenchmark.toFixed(2)} is >2.5x venue-wide StubHub floor $${venueFloor}`);
        }
      }

      // 7. SELL BENCHMARK vs BUY PRICE REALITY CHECK
      // If the sell benchmark is more than 2x the buy price, that's suspicious.
      // Real arbitrage in tickets is typically 20-80% margins, not 200%+.
      // A $171 buy with a $436 sell benchmark means the market data is stale/wrong
      // because if tickets really sold for $436, they wouldn't be listed at $171 now.
      if (d.sellBenchmark && d.buyAllIn && d.sellBenchmark > d.buyAllIn * 2.5) {
        failures.push(`BENCHMARK vs BUY GAP: sell benchmark $${d.sellBenchmark.toFixed(2)} is >2.5x buy price $${d.buyAllIn.toFixed(2)} — market data likely stale`);
      }

      return failures;
    }

    const verifiedDeals = [];
    for (const d of deals) {
      const failures = verifyDeal(d);
      if (failures.length > 0) {
        log(`  ❌ DEAL REJECTED: ${d.eventName} (${d.zone})`);
        failures.forEach(f => log(`     → ${f}`));
        continue;
      }
      log(`  ✅ DEAL VERIFIED: ${d.eventName} (${d.zone}) — ${d.roi.toFixed(1)}% ROI`);
      verifiedDeals.push(d);
    }

    log(`\n📬 Sending ${verifiedDeals.length} verified deal(s) (${deals.length - verifiedDeals.length} rejected)...`);

    const dealStore = loadDeals();

    for (const dealAlert of verifiedDeals) {
      const rawDeal = dealStore.allDeals.find(d => d.id === dealAlert.id) || dealAlert;
      const emailOk = sendDealEmail(dealAlert, rawDeal);
      if (!emailOk) {
        log(`⚠️  Email failed for ${dealAlert.eventName} — check gog auth`);
      }
    }

    // Short Telegram-style summaries (verified deals only)
    const telegramMessages = verifiedDeals.map(d =>
      `🎟️ DEAL: ${d.eventName}\n` +
      `📈 ROI: ${d.roi.toFixed(1)}% | Profit: $${d.profit.toFixed(2)}/ticket\n` +
      `💰 Buy: $${d.buyAllIn.toFixed(2)} all-in on ${d.buyPlatform} | Sell benchmark: $${d.sellBenchmark.toFixed(2)} avg\n` +
      `📅 ${d.eventDate} | ${d.daysUntilEvent}d away\n` +
      (d.flags.length ? d.flags.join(' | ') + '\n' : '') +
      `📧 Full breakdown emailed to ${CONFIG.email.to}`
    ).join('\n\n---\n\n');

    fs.writeFileSync(path.join(__dirname, 'latest-alerts.txt'), telegramMessages);

    // Send directly to Telegram
    try {
      const { execSync: esc } = require('child_process');
      const tmsg = telegramMessages.slice(0, 4000);
      esc(`openclaw message send --channel telegram --target 8684069023 --message ${JSON.stringify(tmsg)}`, { encoding: 'utf8', timeout: 15000 });
      console.log('✅ Telegram alert sent directly');
    } catch(e) {
      console.log('⚠️  Telegram direct send failed:', e.message.slice(0,100));
    }

    console.log(`\n✅ ${verifiedDeals.length} verified deal(s) sent (${deals.length - verifiedDeals.length} rejected by verification gate)`);
    process.exit(0);
  } else {
    console.log('\nNo deals found this run.');
    process.exit(0);
  }
})();
