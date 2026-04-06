#!/usr/bin/env node
/**
 * Final Zone Cache Rebuild
 * Gets events via DataTable pagination, fetches sales via /api/salesdata
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SEATDATA_EMAIL = 'ddweck14@gmail.com';
const SEATDATA_PASS = 'Openclaw99!';
const SEATDATA_BASE = 'https://seatdata.io';
const CACHE_PATH = path.join(__dirname, 'zone-cache.json');

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function safeFetch(page, url) {
  return page.evaluate(async (u) => {
    try {
      const resp = await fetch(u);
      const text = await resp.text();
      return { status: resp.status, text };
    } catch (e) {
      return { error: e.message, status: -1, text: '' };
    }
  }, url);
}

async function main() {
  log('=== Zone Cache Rebuild (Final) ===');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // ─── Login ─────────────────────────────────────────────────────────────────
  log('Logging in...');
  await page.goto(`${SEATDATA_BASE}/login/`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"], input[name="email"], #email', SEATDATA_EMAIL);
  await page.fill('input[type="password"], input[name="password"], #password', SEATDATA_PASS);
  const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
  if (submitBtn) await submitBtn.click();
  await page.waitForURL('**/dashboard/**', { timeout: 15000 });
  log('Login successful.');

  // ─── Navigate to Event Analytics page ─────────────────────────────────────
  log('Navigating to Event Analytics...');
  await page.click('a:has-text("Event Analytics")', { timeout: 5000 });
  await page.waitForTimeout(5000);

  // ─── Extract events from all pages ────────────────────────────────────────
  log('\nExtracting events via DataTable pagination...');

  // Set page size to 100 using the dropdown
  await page.selectOption('select[name="datatables-events_length"]', '100');
  await page.waitForTimeout(5000);

  const allEvents = [];
  let pageNum = 0;

  while (true) {
    // Extract events from current page via DataTables API
    const pageEvents = await page.evaluate(() => {
      try {
        // @ts-ignore
        const dt = window.$('#datatables-events').DataTable();
        const data = dt.rows({ page: 'current' }).data().toArray();
        return data.map(row => {
          if (!Array.isArray(row)) return null;
          const shMatch = String(row[2] || '').match(/event\/(\d+)/);
          return {
            internalId: String(row[0]),
            stubhubEventId: shMatch ? shMatch[1] : null,
            name: String(row[4] || '').replace(/<[^>]+>/g, '').trim().substring(0, 80),
            date: String(row[5] || '').replace(/\s*\([^)]*\)\s*/g, '').trim().substring(0, 10),
            venue: String(row[7] || '').replace(/<[^>]+>/g, '').trim(),
          };
        }).filter(Boolean);
      } catch (e) {
        return [];
      }
    });

    if (pageEvents.length === 0) break;

    // Deduplicate
    const newEvents = pageEvents.filter(e => !allEvents.some(a => a.internalId === e.internalId));
    allEvents.push(...newEvents);
    log(`Page ${pageNum}: ${pageEvents.length} events (${newEvents.length} new, ${allEvents.length} total)`);

    if (newEvents.length === 0) break;

    // Click Next page
    const nextClicked = await page.evaluate(() => {
      const nextBtn = document.querySelector('#datatables-events_next:not(.disabled), .paginate_button.next:not(.disabled)');
      if (nextBtn) {
        const link = nextBtn.querySelector('a') || nextBtn;
        // @ts-ignore
        link.click();
        return true;
      }
      return false;
    });

    if (!nextClicked) {
      log('No next page available.');
      break;
    }

    pageNum++;
    await page.waitForTimeout(4000);

    if (pageNum >= 10) break; // Safety limit
  }

  // If pagination didn't work (only 1 page), try alternative: use DataTables to change page via API
  if (allEvents.length <= 100) {
    log('\nPagination via DOM didn\'t get more events. Trying DataTable API pagination...');

    // Check total records
    const totalInfo = await page.evaluate(() => {
      try {
        // @ts-ignore
        const dt = window.$('#datatables-events').DataTable();
        const info = dt.page.info();
        return info;
      } catch (e) {
        return { error: e.message };
      }
    });
    log(`DataTable info: ${JSON.stringify(totalInfo)}`);

    if (totalInfo?.pages > 1) {
      for (let p = 1; p < Math.min(totalInfo.pages, 10); p++) {
        // Change page via API
        await page.evaluate((pg) => {
          // @ts-ignore
          window.$('#datatables-events').DataTable().page(pg).draw('page');
        }, p);
        await page.waitForTimeout(4000);

        const pageEvents = await page.evaluate(() => {
          try {
            // @ts-ignore
            const dt = window.$('#datatables-events').DataTable();
            return dt.rows({ page: 'current' }).data().toArray().map(row => {
              if (!Array.isArray(row)) return null;
              const shMatch = String(row[2] || '').match(/event\/(\d+)/);
              return {
                internalId: String(row[0]),
                stubhubEventId: shMatch ? shMatch[1] : null,
                name: String(row[4] || '').replace(/<[^>]+>/g, '').trim().substring(0, 80),
                date: String(row[5] || '').replace(/\s*\([^)]*\)\s*/g, '').trim().substring(0, 10),
                venue: String(row[7] || '').replace(/<[^>]+>/g, '').trim(),
              };
            }).filter(Boolean);
          } catch { return []; }
        });

        const newEvents = pageEvents.filter(e => !allEvents.some(a => a.internalId === e.internalId));
        allEvents.push(...newEvents);
        log(`API Page ${p}: ${pageEvents.length} events (${newEvents.length} new, ${allEvents.length} total)`);

        if (newEvents.length === 0) break;
      }
    } else {
      log('DataTable is server-side — try custom AJAX request');

      // The DataTable is server-side, so we need to make our own AJAX calls with pagination
      // But events_appstack returns 500... Let's try it from the page context (with cookies)
      for (let start = 100; start < 600; start += 100) {
        const result = await page.evaluate(async (s) => {
          const params = new URLSearchParams();
          params.set('draw', String(Math.floor(s / 100) + 1));
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
          params.set('start', s.toString());
          params.set('length', '100');
          params.set('search[value]', '');
          params.set('search[regex]', 'false');
          params.set('showHistorical', 'false');
          params.set('showRecAddedAndActive', 'false');
          params.set('showPinnedEvents', 'false');
          params.set('_', Date.now().toString());

          try {
            const resp = await fetch(`/api/events_appstack?${params.toString()}`);
            if (!resp.ok) return { status: resp.status, text: '' };
            const text = await resp.text();
            return { status: resp.status, text };
          } catch (e) {
            return { status: -1, text: '', error: e.message };
          }
        }, start);

        if (result.status !== 200) {
          log(`AJAX page start=${start}: status=${result.status}`);
          // If 500, the DataTable itself loaded fine from the page JS,
          // so the issue might be CSRF or specific params. Try using DataTable's internal draw.
          break;
        }

        try {
          const data = JSON.parse(result.text);
          if (!data?.data?.length) {
            log(`No more data at start=${start}`);
            break;
          }

          for (const row of data.data) {
            const shMatch = String(row[2] || '').match(/event\/(\d+)/);
            const evt = {
              internalId: String(row[0]),
              stubhubEventId: shMatch ? shMatch[1] : null,
              name: String(row[4] || '').replace(/<[^>]+>/g, '').trim().substring(0, 80),
              date: String(row[5] || '').replace(/\s*\([^)]*\)\s*/g, '').trim().substring(0, 10),
              venue: String(row[7] || '').replace(/<[^>]+>/g, '').trim(),
            };
            if (!allEvents.some(a => a.internalId === evt.internalId)) {
              allEvents.push(evt);
            }
          }
          log(`AJAX page start=${start}: ${data.data.length} events (${allEvents.length} total)`);
        } catch (e) {
          log(`Parse error at start=${start}: ${e.message}`);
          break;
        }
      }
    }
  }

  const withBothIds = allEvents.filter(e => e.internalId && e.stubhubEventId);
  log(`\nTotal events with both IDs: ${withBothIds.length}`);

  // ─── Build zone cache ─────────────────────────────────────────────────────
  log(`\n=== Fetching sales data ===`);

  const cache = {};
  let success = 0, empty = 0, fail = 0;
  const t0 = Date.now();

  for (let i = 0; i < withBothIds.length; i++) {
    const evt = withBothIds[i];

    if (i > 0 && i % 50 === 0) {
      const sec = ((Date.now() - t0) / 1000).toFixed(0);
      log(`Progress: ${i}/${withBothIds.length} (${success} ✓) — ${sec}s`);
    }

    try {
      const r = await safeFetch(page, `/api/salesdata?eventId=${evt.internalId}&zoneName=ALL`);
      if (r.status !== 200) { fail++; continue; }

      const raw = JSON.parse(r.text);
      const arr = Array.isArray(raw) ? raw : (raw.data || raw.sales || []);
      if (!Array.isArray(arr) || arr.length === 0) { empty++; continue; }

      cache[evt.internalId] = {
        sales: arr.map(s => ({
          timestamp: s.timestamp || s.date || '',
          quantity: parseInt(s.quantity) || 2,
          price: parseFloat(s.price) || 0,
          zone: s.zone || '',
          section: s.section || '',
          row: s.row || '',
        })).filter(s => s.price > 0),
        cachedAt: new Date().toISOString(),
      };
      success++;
    } catch {
      fail++;
    }

    if (i % 15 === 0 && i > 0) await page.waitForTimeout(300);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  log(`\n=== Results ===`);
  log(`Checked: ${withBothIds.length} | Success: ${success} | Empty: ${empty} | Failed: ${fail}`);
  log(`Time: ${elapsed}s`);

  if (success > 0) {
    let totalSales = 0;
    for (const entry of Object.values(cache)) totalSales += entry.sales.length;
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
    const kb = (fs.statSync(CACHE_PATH).size / 1024).toFixed(1);
    log(`\nCache: ${Object.keys(cache).length} events, ${totalSales} sales, ${kb} KB`);
  }

  await browser.close();
  log('=== Done ===');
}

main().catch(e => {
  log(`Fatal: ${e.message}`);
  process.exit(1);
});
