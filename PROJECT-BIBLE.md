# 🎟️ Ticket Flip Scanner — Project Bible

**Last Updated:** 2026-04-01  
**Author:** Mr. Shmack (autonomous documentation task)  
**Purpose:** Complete handoff document. Any agent should be able to recreate or maintain this project from this file alone.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [The Three-Price Framework](#3-the-three-price-framework)
4. [SeatData Integration](#4-seatdata-integration)
5. [Scanner Code Walkthrough](#5-scanner-code-walkthrough)
6. [Mission Control](#6-mission-control)
7. [Database Schema](#7-database-schema)
8. [Cron Jobs](#8-cron-jobs)
9. [Scripts Reference](#9-scripts-reference)
10. [Platform Integrations](#10-platform-integrations)
11. [Rules & Lessons Learned](#11-rules--lessons-learned)
12. [Source Code & Git Repository](#12-source-code--git-repository)
13. [Credentials & Configuration](#13-credentials--configuration)

---

## 1. Project Overview

### What This Is

An automated ticket arbitrage system. It finds underpriced tickets on secondary marketplaces (StubHub, TickPick, Gametime), determines if they can be resold at a profit on StubHub, and alerts Douglas via email and Telegram so he can decide whether to buy.

### The Business Model

1. **Find deals:** The scanner runs every 20 minutes, scraping SeatData (which aggregates StubHub data) and cross-referencing TickPick (zero buyer fees) and Gametime (low fees) for cheaper buy prices.
2. **Buy low:** Douglas buys underpriced tickets — usually on TickPick (no fees) or Gametime (low fees), where the all-in price is cheaper than the equivalent StubHub listing.
3. **List high:** Tickets are listed for resale on StubHub (primary resale platform) at or just below the zone's market rate.
4. **Sell:** When someone buys, StubHub takes a 15% seller fee. Douglas keeps 85% of the sale price.
5. **Profit = (sale price × 0.85) - buy cost.** The system only alerts when estimated ROI exceeds a configurable threshold (default: 20%).

### Who

- **Douglas** — the human. Makes all buy decisions. No auto-purchasing.
- **Mr. Shmack** — AI assistant (OpenClaw/Claude). Runs the scanner, monitors listings, handles repricing, sends alerts.
- **Scout** — Dedicated agent identity for the scanner on the Mission Control Factory page. Updates status during scans.

### Revenue Example

Buy a ticket on TickPick for $50 all-in (zero fees). List on StubHub for $85. Buyer pays ~$110 (with ~30% StubHub buyer fee). StubHub sends Douglas $85 × 0.85 = $72.25. Profit = $72.25 - $50 = $22.25 per ticket (44.5% ROI).

---

## 2. Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    DATA SOURCES (Buy Side)                   │
│                                                              │
│  SeatData Pro ──→ SeatDeals widget (pre-flagged deals)       │
│       │          ──→ events_appstack (top 500 events)        │
│       │          ──→ salesdata API (completed sales by zone) │
│       │          ──→ event_stats_zones (active listing floor)│
│       │                                                      │
│  TickPick API ──→ Event search + listings (zero buyer fees)  │
│  Gametime API ──→ Mobile API listings (low fees)             │
│  StubHub ─────→ Final verification scrape only               │
└──────────────────────────┬──────────────────────────────────┘
                           │
                    ┌──────▼──────┐
                    │  scanner.js  │  ← Runs every 20 min via cron
                    │  (Playwright │     
                    │   + Node.js) │     
                    └──────┬──────┘
                           │
              ┌────────────┼────────────────┐
              │            │                │
         ┌────▼────┐  ┌───▼────┐    ┌──────▼──────┐
         │ Gmail   │  │Telegram│    │  Neon DB     │
         │ (HTML   │  │ (short │    │ mc_deal_log  │
         │ email)  │  │ alert) │    │ mc_scanner_  │
         │         │  │        │    │   rules      │
         └─────────┘  └────────┘    └──────────────┘
                                           │
                                    ┌──────▼──────┐
                                    │  Mission     │
                                    │  Control     │
                                    │  Web App     │
                                    └─────────────┘
```

### Component Map

| Component | Location | Purpose |
|-----------|----------|---------|
| **scanner.js** | `deal-scanner/scanner.js` | Core scanner — finds deals, sends alerts |
| **listing-monitor.js** | `deal-scanner/listing-monitor.js` | Monitors competitor prices, auto-reprices |
| **ticket-watch-checker.js** | `deal-scanner/ticket-watch-checker.js` | Checks prices for watched tickets |
| **stubhub-auto-reprice.js** | `deal-scanner/stubhub-auto-reprice.js` | Auto-reprices StubHub listings |
| **stubhub-full-listing.js** | `deal-scanner/stubhub-full-listing.js` | Lists new tickets on StubHub |
| **stubhub-refresh-cookies.js** | `deal-scanner/stubhub-refresh-cookies.js` | Refreshes StubHub session cookies |
| **sold-detector.js** | `deal-scanner/sold-detector.js` | Detects sales via Gmail confirmation emails |
| **auto-delist.js** | `deal-scanner/auto-delist.js` | Auto-delists from other platforms on sale |
| **post-sale-handler.js** | `deal-scanner/post-sale-handler.js` | Post-sale workflow (update flip tracker) |
| **seatdata-api.js** | `deal-scanner/seatdata-api.js` | SeatData official REST API module (pre-built, not active) |
| **rebuild-zone-cache-final.js** | `deal-scanner/rebuild-zone-cache-final.js` | Rebuilds zone-cache.json from SeatData |
| **auto-idle.js** | `scripts/auto-idle.js` | Resets agent status when sessions go quiet |
| **Mission Control** | `mission-control/` | Next.js web dashboard |
| **Neon DB** | Cloud (Neon Postgres) | All persistent state |

### Data Flow

1. **Scanner starts** → loads rules from `mc_scanner_rules` in Neon DB
2. **Logs into SeatData** via Playwright (email/password auth)
3. **PATH 1 (SeatDeals):** Fetches `/api/seatdeals/widget` — pre-flagged underpriced StubHub listings with zone sales data embedded
4. **PATH 2 (Top Events):** Fetches `/api/events_appstack` — top 500 events; loads zone sales from `zone-cache.json` or fetches live from `/api/salesdata`
5. **For each deal candidate:**
   - Analyze completed sales (recency-weighted, outlier-filtered)
   - Collect buy-side listings from TickPick + Gametime APIs
   - Compute sell benchmark using Three-Price Framework
   - Calculate ROI — skip if below threshold
   - Dedup check (permanent — never re-send same deal)
   - Verification gate (7 checks)
   - Fetch live StubHub listings for final verification
   - If deal passes → write to `mc_deal_log`, send HTML email, send Telegram alert

---

## 3. The Three-Price Framework

**STATUS: LOCKED (Douglas approved March 31, 2026). Do not modify without explicit approval.**

This is the core pricing logic. Every deal evaluation uses this framework.

### The Three Prices

For any deal, we evaluate three prices, ALL in the **same zone** and ALL for the **same quantity**:

| # | Price | Source | Meaning |
|---|-------|--------|---------|
| 1 | **Buy price** | TickPick, Gametime, or StubHub (cheapest) | The outlier — cheapest available ticket in the zone we could buy right now |
| 2 | **Completed sales avg** | SeatData `/api/salesdata` | What people actually paid recently (recency-weighted average, half-life 3 days) |
| 3 | **Active listings floor** | SeatData `/api/event_stats_zones` or StubHub scrape | Cheapest current listing in same zone from other sellers |

### Sell Price Formula

```
IF active_listings_floor < completed_sales_avg:
    sell_price = active_listings_floor × (1 - undercut_pct)
    # Market is dropping — you're competing with live sellers, undercut them

ELSE:  # completed_sales_avg ≤ active_listings_floor
    sell_price = completed_sales_avg
    # You're already below all active listings, price at what actually sells
    # NO undercut applied — you're already the cheapest
```

**Undercut settings** (stored in DB `mc_scanner_rules`):
- `auto_list_undercut_mode` = `percent`
- `auto_list_undercut_pct` = 5 (5%)
- `auto_list_undercut_dollars` = 2

### Why This Works (Douglas's Reasoning)

> "Active listings tell you the CEILING of what you could ask, not what you'll actually get. Completed sales tell you what ACTUALLY SELLS."

- If active listings ($125) are below completed sales ($150) → use active listings. Market dropped.
- If active listings ($250) are above completed sales ($150) → use completed sales. Nobody's buying at $250.
- Always use the **LOWER** of the two, then undercut only when competing with live sellers.

### Deal Signal

A deal exists when the buy price is **significantly below** the sell price (after 15% seller fee). If every listing in the zone is the same price, there's no deal — you're just buying at market rate.

### ROI Formula

```
ROI = ((sell_benchmark × 0.85) - buy_all_in) / buy_all_in × 100
```

Where:
- `sell_benchmark` = the sell price from the formula above
- `0.85` = (1 - 15% StubHub seller fee)
- `buy_all_in` = buy price including all platform fees

### Recency-Weighted Average

Completed sales are weighted by recency using exponential decay with a 3-day half-life:

```
weight = e^(-daysAgo / 3)
```

| Days Ago | Weight |
|----------|--------|
| 0 (today) | 1.00 |
| 1 | 0.72 |
| 3 | 0.37 |
| 7 | 0.10 |
| 14 | 0.01 |

"Most recent sale is king." — Douglas, March 30

### Data Rules (STRICT)

- Use ONLY last 14 days of completed sales (`salesWindowDays` in DB, default 7)
- Max 15 sales used per analysis (`maxSalesUsed`)
- Minimum 5 same-quantity sales required (`minCompletedSales`, default 5)
- **Same quantity ALWAYS.** If the deal is for qty 2, only use qty-2 completed sales. No fallbacks.
- **Same zone ALWAYS.** GA and GA Plus are DIFFERENT zones. Never mix.
- Unknown quantity (0 or null) = reject the sale, not "assume qty 2"
- Outliers filtered: strip sales >2.5× median and <0.2× median
- Active listings come from SeatData first. StubHub scrape = final verification only.

---

## 4. SeatData Integration

### Overview

SeatData.io is the primary data source. Douglas has a Pro subscription ($129/mo) under `ddweck14@gmail.com`. The scanner uses their web session API (free with Pro), not the official REST API ($0.10/call).

### Authentication

The scanner logs into SeatData via Playwright:
1. Navigate to `https://seatdata.io/login/`
2. Fill email: `ddweck14@gmail.com`
3. Fill password: `Openclaw99!`
4. Click submit
5. Wait for redirect to `/dashboard`
6. All subsequent API calls use the authenticated browser context (cookies)

### API Endpoints (Discovered & Confirmed)

#### ✅ Working (Authenticated Session — Free with Pro)

| Endpoint | Method | Purpose | Params |
|----------|--------|---------|--------|
| `/api/seatdeals/widget` | GET | **SeatDeals** — pre-flagged underpriced tickets with zone sales embedded | None |
| `/api/salesdata?eventId={id}&zoneName=ALL` | GET | **Completed sales for an event** — flat JSON array of sale objects | `eventId` = SeatData internal ID (NOT StubHub ID), `zoneName=ALL` |
| `/api/event_stats?eventId={id}` | GET | **Event-level stats:** total_listings_active, event_average, event_lowest_price | `eventId` |
| `/api/event_stats_zones?eventId={id}` | GET | **Zone list** for an event | `eventId` |
| `/api/event_stats_zones?eventId={id}&zone={name}` | GET | **Zone-level active listings:** lowest_price, mean, median (latest array entry = current) | `eventId`, `zone` |
| `/api/events_appstack?{DataTables params}` | GET | **Event catalog** — paginated, DataTables protocol | See below |
| `/api/snapshot_appstack` | GET | Historical median price data | None |

#### ❌ Broken / Removed

| Endpoint | Status | Notes |
|----------|--------|-------|
| `/api/zone_sales?event_id={id}&days=7` | **404** | Worked until ~March 25, 2026. Removed. |
| `/api/salesdata?event_id={id}` (snake_case) | **404** | Wrong param name — web app uses camelCase `eventId` |
| `/api/salesdata/get?event_id={stubhubId}` | **401** | Official REST API — requires API key (separate $0.10/call subscription) |

#### 🔑 Key Difference: `eventId` vs `event_id`

| Auth Method | Param Style | Cost |
|-------------|-------------|------|
| Web session (Playwright cookies) | `eventId` (camelCase) | Free with Pro |
| API key (`api-key` header) | `event_id` (snake_case) | $0.10/call |

### events_appstack DataTables Query

**Critical:** Columns 0-3 must have `searchable=false` and `orderable=false`. The API returns HTTP 500 otherwise.

**Must be called from the Event Analytics page context** (`/dashboard/sold-listings`). The scanner navigates there before calling this endpoint.

```javascript
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
params.set('order[0][column]', '5');  // sort by date
params.set('order[0][dir]', 'asc');
params.set('start', '0');
params.set('length', '500');
params.set('showHistorical', 'false');
params.set('showRecAddedAndActive', 'false');
params.set('showPinnedEvents', 'false');
params.set('_', Date.now().toString());
```

### events_appstack Column Layout

| Col | Content |
|-----|---------|
| 0 | SeatData internal event ID |
| 1 | Pin button HTML |
| 2 | StubHub link HTML (contains `/event/{stubhubId}`) |
| 3 | Ticketmaster link HTML |
| 4 | Event name (plain text or HTML) |
| 5 | Date (e.g., "2026-03-31 (Tue)") |
| 6 | Time |
| 7 | Venue |
| 8 | Capacity |
| 9 | City |
| 10 | Country |
| 11 | Activity level badge |
| 12 | Sales counts (CSV) |
| 13 | Active listings count |
| 14 | Get-in price |
| 15 | Get-in trend (CSV of date,price pairs) |
| 16 | Median listing price |
| 17 | Days tracked |

### salesdata Response Format

Flat JSON array:
```json
[
  {
    "timestamp": "03-30-26 / 07:26 PM",
    "quantity": 2,
    "price": 74.0,
    "zone": "Lower Sideline",
    "section": "101",
    "row": "G"
  }
]
```

### SeatDeals Widget Response

```json
{
  "deals": [
    {
      "event_name": "...",
      "event_date": "2026-04-15",
      "event_time": "19:00:00",
      "venue": "...",
      "zone": "Lower Sideline",
      "section": "101",
      "row": "A",
      "quantity": 2,
      "price": 50.00,
      "listing_id": "...",
      "event_id": "12345678",
      "event_url": "https://www.stubhub.com/event/...",
      "checkout_url": "https://www.stubhub.com/checkout/...",
      "zone_sales": [...],
      "next_prices_in_zone": {
        "listings": [...]
      }
    }
  ]
}
```

### Zone Cache

**File:** `deal-scanner/zone-cache.json`

Pre-fetched completed sales data for top events. Used by the Top Events path to avoid fetching sales data live for every event on every scan.

**Format:**
```json
{
  "{seatdata_internal_id}": {
    "sales": [
      {
        "timestamp": "03-30-26 / 07:26 PM",
        "quantity": 0,
        "price": 74.0,
        "zone": "",
        "section": "01",
        "row": "G"
      }
    ],
    "cachedAt": "2026-03-31T06:14:42.413Z"
  }
}
```

**Rebuild:** `node rebuild-zone-cache-final.js` (~90 seconds for 500 events)  
**When to rebuild:** If cache is 3-5+ days old, or scanner shows "no cached sales" for most events  
**Full runbook:** `deal-scanner/ZONE-CACHE-RUNBOOK.md`

---

## 5. Scanner Code Walkthrough

### File: `deal-scanner/scanner.js` (~3,200 lines)

### Entry Point

```
(async () => {
  await loadRulesFromDB();   // Override CONFIG from mc_scanner_rules
  if (!CONFIG.scannerEnabled) process.exit(0);
  const deals = await runScanner();
  // Verify + email + Telegram for each deal
})();
```

### Configuration Loading

`loadRulesFromDB()` queries `mc_scanner_rules WHERE id = 'default'` and overwrites every value in the `CONFIG` object:
- Fees: stubhub_buyer_fee, tickpick_buyer_fee, seatgeek_buyer_fee, vivid_buyer_fee, gametime_buyer_fee, seller_fee, stubhub_seller_fee, vivid_seller_fee, seatgeek_seller_fee
- Thresholds: min_roi, min_completed_sales, sales_window_days, max_sales_used, min_hours_out, max_days_out, floor_divergence_flag
- Auto-buy: auto_buy_enabled, auto_buy_min_roi, auto_buy_min_sales, auto_buy_max_cost, auto_buy_min_days_out, auto_buy_max_days_out
- Flags: scanner_enabled, top_events_enabled, scan_frequency_min

### PATH 1: SeatDeals Widget Flow

1. Call `getSeatDeals(page)` → fetches `/api/seatdeals/widget`
2. Returns array of deal objects, each with `zone_sales` embedded
3. For each deal, call `processDealCandidate(deal, page, 'SeatDeals')`

### PATH 2: Top Events Flow

1. Navigate to `/dashboard/sold-listings` (required page context)
2. Call `getTopEvents(page, 500)` → fetches `events_appstack`
3. Parse HTML-laden response into structured events (name, date, venue, stubhubEventId)
4. Load `zone-cache.json` for sales data; fetch live for cache misses
5. **Pre-check:** For each event, group sales by zone. Skip events where no zone has enough same-qty sales.
6. Fetch listings from TickPick + Gametime **once per event** (not per zone — performance optimization)
7. **Zone matching:** Build `zoneSections` map — zone name → Set of section numbers from completed sales. A buy listing matches a zone if its section appears in that zone's section set. This works across platforms regardless of zone naming differences.
8. For each zone with viable sales data:
   - Find cheapest buy listing whose section is in this zone
   - Analyze completed sales with `analyzeZoneSales()`
   - Compute sell benchmark with `computeSellBenchmark()`
   - Calculate ROI — skip if below threshold
   - Dedup check
   - **Lazy StubHub fetch:** Only scrape StubHub if this zone already passes ROI on SeatData alone
   - Build deal alert, write to DB, save to dedup store

### Zone Matching (Section-in-Zone)

This is the critical mechanism that prevents cross-zone comparisons. SeatData completed sales include both a `zone` name and a `section` number. We build a mapping:

```
"Lower Sideline" → {101, 102, 103, 104, 105, 106}
"Upper Deck"     → {301, 302, 303, 304}
```

A TickPick listing for Section 103 matches zone "Lower Sideline" because 103 is in that zone's section set. A listing for Section 301 would NOT match "Lower Sideline" — it belongs to "Upper Deck."

**Bug that was fixed (March 31):** Previously, a $43 Section 313 upper-bowl ticket was being used as the "buy" for Club/Lower zones because there was no section-to-zone mapping. This created phantom 100%+ ROI deals.

### Gametime Matching

Gametime has no zone data. The scanner matches events by:

1. **Category inference:** NBA/NHL/NFL/MLB/concert from event name keywords
2. **Geo-location:** Home team → lat/lon from `TEAM_COORDS` lookup table (~150 entries)
3. **Search:** `GET /v1/events?category={cat}&lat={lat}&lon={lon}&per_page=50` with mobile User-Agent
4. **Name matching:** Compare source event terms with Gametime event name. Score based on term overlap + date proximity.
5. **Minimum requirements:** `nameHits >= 2` AND `bestScore >= 2`. A date-only match is NOT sufficient.
6. **Team validation:** For sports events with "at"/"vs" format, both team short names must appear in the matched Gametime event.
7. **Word overlap for non-separator format:** At least 60% of source words must match.

**Bug that was fixed (March 31):** "Washington Capitals vs NJ Devils" was matching "Boston Bruins at Florida Panthers" because a date-only match scored +10 with zero name overlap. Fix: require `nameHits >= 2`.

### TickPick Integration

1. Search: `GET https://api.tickpick.com/1.0/events?performerName={query}&limit=20`
2. Match by name + date using `matchTickPickEvent()`
3. Listings: `GET https://api.tickpick.com/1.0/listings/internal/event-v2/{eventId}?trackView=false` (uses Playwright page context)
4. **Key advantage:** TickPick prices are all-in (zero buyer fees). `price = allInPrice`.
5. **Zone filtering:** Only accept listings whose section appears in the deal's zone_sales sections.

### Verification Gate (7 Checks)

Every deal must pass ALL checks before an email is sent:

| # | Check | Condition to REJECT |
|---|-------|---------------------|
| 1 | Event match | Reserved for future use |
| 2 | **Zone match** | Buy section not found in completed sales sections |
| 3 | **Qty match** | Any completed sales have wrong quantity |
| 4 | **Benchmark sanity** | Sell benchmark > 2× most recent sale |
| 5 | **ROI sanity** | ROI > 500% (almost certainly bad data) |
| 6 | **Zone floor divergence** | Sell benchmark > 50% above live StubHub zone floor |
| 7 | **Benchmark vs buy gap** | Sell benchmark > 2.5× buy price (stale market data) |

### Dedup Logic

**Permanent dedup — no time window.** Douglas explicitly said: "Never send the same deal again, even after 2 hours."

Two layers:
1. **Local file:** `deals-found.json` → `sentDeals[]` array. Match by `eventName + buyPlatform + buyAllIn within $5`.
2. **Database:** `mc_deal_log` → match by `stubhub_event_id + zone` with status `presented`. If found, UPDATE instead of INSERT.

The `sentDeals` array is written **incrementally** per deal (not batched at end) so concurrent cron runs see each other's deals immediately.

Capped at 200 entries — oldest pruned when exceeded.

### Email Formatting

Rich HTML email with dark theme design. Sections:
- **Header card:** Event name, date, venue, ROI badge, zone badge, days-away badge
- **Ticket details:** Zone, section, row, quantity, platform
- **Buy price:** All-in price with fee breakdown, delivery cost, total cost, BUY NOW button
- **Cheapest venue alternative:** Cheapest same-qty ticket anywhere in the venue (context)
- **Active listings in zone:** Table with rank, price, section, row, qty, source badge (SH/GT/TP)
- **Completed sales in zone:** Table with date, price, section, row, qty
- **P&L calculation:** Buy cost, gross revenue, seller fee, net revenue, total profit, ROI
- **Links:** Buy tickets, StubHub event page, Ticketmaster search, venue map
- **Flags:** All warnings and validations

Email sent via `gog` CLI (Google Workspace): `gog gmail send --to ddweck14@gmail.com --body-html {html}`

### Scout Status Updates

The scanner updates the `scout` agent on the Factory page:
- **Scan start:** `status='active'`, `task_summary='Scanning for deals...'`
- **During scan:** `touchScout()` every 10 events to prevent auto-idle from flipping it
- **Scan end:** `status='idle'`, `task_summary='✅ {N} deal | {duration} — next scan in {N}m'`

---

## 6. Mission Control

### Overview

Next.js web application hosted on Netlify. Two instances:
- **Personal:** https://shmack-hq.netlify.app (site ID: `69590f6b`)
- **Business:** https://shmack-biz.netlify.app (site ID: `ed08851e`) — shared with Morris + Paul

Both use Neon Postgres for data. Personal has all features; Business has a subset.

### Pages (Personal Instance)

#### Factory (`/factory`) — **HOME PAGE**
The agent workspace. Shows:
- **Agent desks:** Each registered agent (Shmack, Scout, Monitor, etc.) has a nameplate desk. Shows status (idle/active), current task, model, last active time.
- **In Progress zone:** Agents with `status='active'` float here. Empty chair shows at their desk.
- **Done zone:** Completed sub-agents (24h retention, then auto-removed).
- **Three agent types:**
  - **Primary Agent** — Main AI on a machine (Mr. Shmack, Paul). Always has a desk.
  - **Dedicated Agent** — Always-on, single purpose (Scout, Monitor, Watcher). Blue DEDICATED badge. Has a desk.
  - **Sub-Agent** — Spawned for specific task, finishes and disappears. Yellow SUB-AGENT badge. No desk — appears directly in In Progress.

#### Deal Log (`/deals` via API)
All deals found by the scanner. Columns: event name, date, zone, buy price, buy platform, sell benchmark, ROI, profit, status (presented/bought/passed/expired), found timestamp.

#### Flip Tracker (`/flips`)
Active ticket flips Douglas is managing. Columns: event, section/row, buy price, buy platform, sell price, platform listings (JSONB), status, profit. Includes:
- **Platform listings column:** Shows which platforms the ticket is listed on (StubHub, Vivid, etc.) with price and status
- **Ticket Watch tab:** Monitored tickets not yet purchased. Table: `mc_ticket_watch`

#### Scanner Rules (`/scanner-rules` via API)
Every field in `mc_scanner_rules` is editable from this page:
- **Fees:** StubHub buyer fee, TickPick buyer fee, seller fee, etc.
- **Thresholds:** Min ROI (%), min completed sales count, sales window (days), max sales used, min hours out, max days out, floor divergence flag (%)
- **Auto-buy settings:** Enabled toggle, min ROI, min sales, max cost, min/max days out
- **Scanner flags:** Scanner enabled, top events enabled, scan frequency (min)
- **Undercut settings:** Mode (percent/dollars), undercut percentage, undercut dollars

#### Heartbeat (`/heartbeat`)
Shows heartbeat and cron job status. When Shmack last checked in, what was checked, any issues found.

#### Cron Jobs (`/cron`)
Weekly calendar view + Today view. Shows all scheduled cron jobs with timing, status, last run, consecutive errors. "Always Running" pills for recurring jobs.

#### Inbox (`/inbox`)
Email inbox integration. Shows recent emails from Gmail.

#### Chat (`/chat`)
Chat mirror — shows conversation history between Douglas and Shmack. Messages mirrored from Telegram via `chat-mirror.js`.

#### Board (`/board`)
Task/project board.

#### Projects (`/projects`)
Project cards with progress bars, status badges, priority indicators, agent avatars.

#### Documents (`/docs`)
Two-panel document browser. Browse files on left, read markdown-rendered content on right. Search and category filters.

#### Memory (`/memory`)
Browse memory files (daily notes + MEMORY.md).

#### Notes (`/notes`)
Quick notes.

#### R&D Team (`/rd-team`)
Research & development team page. "Run" button (local only).

#### Team (`/team`)
Team member management.

#### Setup (`/setup`)
System configuration.

### API Routes

All under `/api/`:
- `scanner-rules` — GET/PUT scanner rules
- `deals` — GET deal log
- `flips` — GET/POST/PATCH flip tracker
- `ticket-watch` — GET/POST/PATCH ticket watches
- `factory/agents` — GET/POST/PATCH agent registry
- `listing-history` — GET listing price history
- `activity` — GET system activity log
- `chat` — GET/POST chat messages
- `cron` — GET cron job info
- `docs` — GET documents
- `heartbeat` — GET/POST heartbeat status
- `inbox` — GET email inbox
- `memory` — GET memory files
- `notes` — GET/POST notes
- `projects` — GET/POST projects
- `rd-team` — GET R&D team
- `requests` — GET/POST requests
- `setup` — GET/POST setup config
- `tasks` — GET/POST tasks
- `team` — GET/POST team members

### Deploy Commands

**Personal (shmack-hq):**
```bash
cd /Users/douglasdweck/.openclaw/workspace/mission-control && \
NETLIFY_AUTH_TOKEN=nfp_H7A3Hi16T3QVg8NML64aaXhzd9VYtZwy4bec \
npx netlify-cli deploy --prod --site 69590f6b-c319-4e4d-9e50-a771706e36e4
```

**Business (shmack-biz) — ALWAYS use deploy script:**
```bash
cd /Users/douglasdweck/.openclaw/workspace/mission-control && bash deploy-biz.sh
```
**NEVER deploy biz directly with netlify-cli** — `deploy-biz.sh` strips personal credentials before deploying.

---

## 7. Database Schema

### Connection

**Neon Postgres:**
```
postgresql://neondb_owner:npg_QW2a7wnADpOs@ep-dry-term-advgll07-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require
```

All Mission Control tables use `mc_` prefix.

### mc_scanner_rules

Controls all scanner behavior. Single row with `id = 'default'`.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | text PK | Always 'default' |
| `scanner_enabled` | boolean | Master on/off switch for scanner |
| `top_events_enabled` | boolean | Enable PATH 2 (top events scan) |
| `scan_frequency_min` | integer | How often scanner runs (minutes) |
| `min_roi` | numeric | Minimum ROI % to alert (default: 20) |
| `min_completed_sales` | integer | Min same-qty completed sales needed (default: 5) |
| `sales_window_days` | integer | Lookback window for completed sales (default: 7) |
| `max_sales_used` | integer | Max sales to use in benchmark (default: 15) |
| `min_hours_out` | numeric | Min hours until event (default: 48) |
| `max_days_out` | integer | Max days until event (default: 30) |
| `min_quantity` | integer | Minimum ticket quantity (default: 2) |
| `floor_divergence_flag` | numeric | Flag threshold: active vs sales floor divergence (default: 0.50) |
| `stubhub_buyer_fee` | numeric | StubHub buyer fee estimate (default: 0.30) |
| `tickpick_buyer_fee` | numeric | TickPick buyer fee (default: 0 — zero fees) |
| `seatgeek_buyer_fee` | numeric | SeatGeek buyer fee estimate |
| `vivid_buyer_fee` | numeric | Vivid Seats buyer fee estimate |
| `gametime_buyer_fee` | numeric | Gametime buyer fee estimate |
| `seller_fee` | numeric | Default seller fee (default: 0.15 = 15%) |
| `stubhub_seller_fee` | numeric | StubHub seller fee (default: 0.15) |
| `vivid_seller_fee` | numeric | Vivid Seats seller fee (default: 0.10) |
| `seatgeek_seller_fee` | numeric | SeatGeek seller fee (default: 0.10) |
| `auto_buy_enabled` | boolean | Auto-buy toggle (default: false — NEVER auto-buy) |
| `auto_buy_min_roi` | numeric | Auto-buy min ROI |
| `auto_buy_min_sales` | integer | Auto-buy min completed sales |
| `auto_buy_max_cost` | numeric | Auto-buy max total cost |
| `auto_buy_min_days_out` | integer | Auto-buy min days before event |
| `auto_buy_max_days_out` | integer | Auto-buy max days before event |
| `auto_list_undercut_mode` | text | 'percent' or 'dollars' |
| `auto_list_undercut_pct` | numeric | Undercut percentage (default: 5) |
| `auto_list_undercut_dollars` | numeric | Undercut dollar amount (default: 2) |

### mc_deal_log

Every deal the scanner has ever found.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | serial PK | Auto-increment |
| `deal_id` | text | Unique deal ID (format: `deal_{eventId}_{section}_{row}_{timestamp}`) |
| `event_name` | text | Event name |
| `event_date` | text | Event date (YYYY-MM-DD) |
| `event_time` | text | Event time |
| `venue` | text | Venue name |
| `zone` | text | Zone name |
| `section` | text | Section number |
| `row` | text | Row |
| `quantity` | integer | Ticket quantity |
| `buy_price` | numeric | Base buy price per ticket |
| `buy_platform` | text | Platform to buy on (TickPick, Gametime, StubHub) |
| `buy_all_in` | numeric | All-in buy price per ticket |
| `buy_url` | text | Direct link to buy listing |
| `sell_benchmark` | numeric | Sell benchmark price per ticket |
| `sell_benchmark_source` | text | How benchmark was calculated |
| `roi_pct` | numeric | ROI percentage |
| `profit_est` | numeric | Estimated profit per ticket |
| `source` | text | 'scanner' |
| `status` | text | 'presented', 'bought', 'passed', 'expired' |
| `scanner_data` | jsonb | Full deal alert object |
| `event_url` | text | StubHub event page URL |
| `stubhub_event_id` | text | StubHub event ID |
| `found_at` | timestamp | When first found |
| `updated_at` | timestamp | Last update |

### mc_factory_agents

Agent registry for the Factory page.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | text PK | Agent ID (e.g., 'shmack', 'scout', 'monitor') |
| `session_key` | text | OpenClaw session key |
| `name` | text | Display name (e.g., 'Mr. Shmack', 'Scout') |
| `emoji` | text | Agent emoji |
| `role` | text | 'Primary Agent', 'Dedicated Agent', 'Sub-Agent' |
| `model` | text | AI model (opus, sonnet, haiku) |
| `status` | text | 'active', 'idle', 'standby', 'scheduled', 'completed' |
| `task_summary` | text | Current task or last result |
| `started_at` | timestamp | When current session started |
| `updated_at` | timestamp | Last heartbeat/update |

**Status rules (LOCKED):**
- `active` → shows in In Progress zone
- `idle` / `standby` / `scheduled` → shows at desk only
- `completed` → shows in Done zone (24h retention)

### mc_flips

Active ticket flips being managed.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | serial PK | Auto-increment |
| `event_name` | text | Event name |
| `event_date` | text | Event date |
| `venue` | text | Venue |
| `section` | text | Section |
| `row` | text | Row |
| `quantity` | integer | Ticket count |
| `buy_price` | numeric | Total buy price |
| `buy_platform` | text | Where purchased |
| `sell_price` | numeric | Current list price |
| `sell_platform` | text | Where listed |
| `listings` | jsonb | Multi-platform listing data: `[{"platform":"StubHub","code":"SH","price":125,"status":"listed","listedAt":"..."}]` |
| `status` | text | 'active', 'sold', 'expired', 'delisted' |
| `listing_id` | text | StubHub listing ID |
| `profit` | numeric | Realized profit (after sale) |
| `roi_pct` | numeric | Realized ROI |
| `notes` | text | Notes |
| `created_at` | timestamp | When flip started |
| `updated_at` | timestamp | Last update |

**Listing status values:** `"listed"`, `"pending"`, `"sold"`, `"delisted"`

### mc_ticket_watch

Tickets Douglas wants to monitor but hasn't bought yet.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | serial PK | Auto-increment |
| `event_name` | text | Event name |
| `event_date` | text | Event date |
| `venue` | text | Venue |
| `section` | text | Section/zone target (e.g., "Floor GA") |
| `quantity` | integer | Desired ticket count |
| `max_price` | numeric | Maximum price per ticket |
| `status` | text | 'watching', 'alerted', 'bought', 'completed', 'cancelled' |
| `last_checked` | timestamp | When last price-checked |
| `last_price` | numeric | Most recent price found |
| `last_platform` | text | Where the price was found |
| `notes` | text | Notes |
| `created_at` | timestamp | Watch created |
| `updated_at` | timestamp | Last update |

### mc_listing_price_history

Every price check and adjustment logged for monitoring.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | serial PK | Auto-increment |
| `flip_id` | integer FK | References mc_flips |
| `platform` | text | Platform checked |
| `our_price` | numeric | Our current price |
| `competitor_price` | numeric | Cheapest competitor |
| `new_price` | numeric | Price we changed to (null if no change) |
| `action` | text | 'check', 'adjust', 'alert' |
| `notes` | text | Details |
| `checked_at` | timestamp | When this check happened |

### Other mc_* Tables

| Table | Purpose |
|-------|---------|
| `mc_tasks` | Task board items |
| `mc_chat_messages` | Chat mirror messages (Telegram ↔ MC web) |
| `mc_email_events` | Email event tracking (Gmail push notifications) |
| `mc_memory_files` | Memory file metadata |
| `mc_team` | Team members |

### Non-MC Tables (same Neon DB)

| Table | Purpose |
|-------|---------|
| `bracket_picks` | NCAA bracket picks |
| `bracket_players` | NCAA bracket players |
| `bracket_removed_players` | Removed NCAA players |
| `bracket_lock` | Bracket lock state |

---

## 8. Cron Jobs

All managed via OpenClaw cron system.

### deal-scanner
- **Schedule:** `*/20 * * * *` (every 20 minutes) with 5-min stagger
- **Session:** Isolated
- **Model:** Default (Sonnet)
- **Timeout:** 300 seconds
- **Payload:** Runs `node scanner.js`
- **Delivery:** Silent (scanner handles its own email/Telegram delivery)
- **Agent ID on Factory:** `scout`

### listing-monitor
- **Schedule:** Every 2 hours (`everyMs: 7200000`)
- **Session:** Isolated
- **Model:** Haiku
- **Timeout:** 180 seconds
- **Payload:** Runs `node listing-monitor.js`
- **Delivery:** Silent
- **Purpose:** Checks competitor prices for active StubHub listings, auto-adjusts via `stubhub-auto-reprice.js`

### ticket-watch-checker
- **Schedule:** Every 6 hours (`everyMs: 21600000`)
- **Session:** Isolated
- **Model:** Haiku
- **Timeout:** 120 seconds
- **Payload:** Runs `node ticket-watch-checker.js`
- **Delivery:** Silent (script handles Telegram alerts internally)
- **Purpose:** Checks prices for all active watches in `mc_ticket_watch`

### auto-idle
- **Schedule:** Every 2 minutes (`everyMs: 120000`)
- **Session:** Isolated
- **Model:** Haiku
- **Timeout:** 30 seconds
- **Payload:** Runs `node scripts/auto-idle.js`
- **Delivery:** Silent
- **Purpose:** Detects when Shmack/Scout sessions have ended without cleanup, resets status to idle
- **Status as of Apr 1:** Has 11 consecutive errors (Telegram resolution issue) — functionally works but logs errors

### autonomous-employee-2am
- **Schedule:** `0 2 * * *` (2:00 AM ET daily)
- **Session:** Isolated
- **Model:** Default
- **Timeout:** 1200 seconds (20 minutes)
- **Payload:** Executes a pre-assigned task (updated per session)
- **Delivery:** Announce to Telegram (`8684069023`)
- **Purpose:** Nightly autonomous work — picks one high-impact task and executes it

### daily-memory-note
- **Schedule:** `5 0 * * *` (12:05 AM ET daily)
- **Session:** Isolated
- **Model:** Default
- **Timeout:** 120 seconds
- **Payload:** Creates `memory/YYYY-MM-DD.md` if it doesn't exist
- **Delivery:** Announce to Telegram

### doc-writer-3am
- **Schedule:** `0 3 * * *` (3:00 AM ET daily)
- **Session:** Isolated
- **Model:** Default
- **Timeout:** 1200 seconds
- **Payload:** Documentation tasks
- **Delivery:** Announce to Telegram
- **Note:** This is the job that created THIS document

---

## 9. Scripts Reference

### deal-scanner/ — Production Scripts

| Script | Size | Purpose | How to Run |
|--------|------|---------|------------|
| `scanner.js` | 141KB | Core deal scanner | `node scanner.js` or `DRY_RUN=1 node scanner.js` |
| `run.sh` | 878B | Shell wrapper for scanner.js | `bash run.sh` |
| `listing-monitor.js` | 28KB | Monitor + auto-reprice active listings | `node listing-monitor.js` |
| `ticket-watch-checker.js` | 22KB | Check prices for watched tickets | `node ticket-watch-checker.js` |
| `stubhub-auto-reprice.js` | 18KB | Auto-reprice a StubHub listing | `node stubhub-auto-reprice.js --listing-id 12138999106 --new-price 98 [--flip-id <id>] [--dry-run]` |
| `stubhub-full-listing.js` | 6KB | Create a new StubHub listing | `node stubhub-full-listing.js` (interactive) |
| `stubhub-refresh-cookies.js` | 7KB | Refresh StubHub session cookies | `node stubhub-refresh-cookies.js` (requires OTP) |
| `sold-detector.js` | 10KB | Detect StubHub sales via Gmail | `node sold-detector.js` |
| `auto-delist.js` | 27KB | Auto-delist from other platforms when sold | `node auto-delist.js` |
| `post-sale-handler.js` | 1.3KB | Post-sale workflow | `node post-sale-handler.js` |
| `seatdata-api.js` | 10KB | SeatData official REST API module | Not yet active — pre-built for future use |
| `rebuild-zone-cache-final.js` | 12KB | Rebuild zone-cache.json from SeatData | `node rebuild-zone-cache-final.js` (~90s) |
| `rebuild-zone-cache-full.js` | 8KB | Earlier version of cache rebuild | Superseded by `-final` version |
| `ticketmaster-login.js` | 1.7KB | Ticketmaster login flow | `node ticketmaster-login.js` |
| `tm-transfer-ticket.js` | 7KB | Ticketmaster ticket transfer | Blocked on SMS MFA |
| `tm-try-voice-otp.js` | 5KB | Ticketmaster voice OTP experiment | Experimental |
| `vividseats-login.js` | 2KB | Vivid Seats login | Needs cookie refresh |
| `vividseats-listing.js` | 11KB | Vivid Seats listing | Blocked on login |

### deal-scanner/ — Data Files

| File | Purpose |
|------|---------|
| `deals-found.json` | Dedup tracking — all sent deals |
| `zone-cache.json` | Cached zone sales data (~18MB) |
| `stubhub-seller-cookies.json` | StubHub authenticated session |
| `ticketmaster-cookies.json` | Ticketmaster session |
| `vividseats-cookies.json` | Vivid Seats session |
| `sold-state.json` | Sold detector state |
| `scanner.log` | Scanner execution log |
| `latest-alerts.txt` | Most recent Telegram alert text |
| `dry-run-output.json` | Last dry run results |

### deal-scanner/ — Documentation

| File | Purpose |
|------|---------|
| `README.md` | Script inventory and overview |
| `PROJECT-BIBLE.md` | This file — comprehensive project documentation |
| `PLATFORM-SCRIPTS.md` | Master index of all platform scripts |
| `MARKETPLACE-RULES.md` | Per-platform fees, confirmations, rules |
| `CREDENTIALS.md` | Login credentials reference |
| `ZONE-CACHE-RUNBOOK.md` | Zone cache rebuild procedures |
| `SEATDATA-DECISION.md` | SeatData Pro vs API cost analysis |
| `STUBHUB-LOGIN-RUNBOOK.md` | StubHub OTP login flow |
| `STUBHUB-LISTING-RUNBOOK.md` | StubHub new listing flow |
| `STUBHUB-AUTO-REPRICE-RUNBOOK.md` | Auto-reprice operational runbook |
| `STUBHUB-UPDATE-PRICE-RUNBOOK.md` | Manual price update flow |
| `TICKETMASTER-LOGIN-RUNBOOK.md` | Ticketmaster login + transfer flow |
| `platform-audit.md` | Platform capability audit |

### scripts/ — Utility Scripts

| Script | Purpose |
|--------|---------|
| `auto-idle.js` | Resets agent status when sessions go quiet (runs every 2 min) |

### deal-scanner/_archive/

71 deprecated experiment/debug scripts. Not needed for operations. Kept for reference.

---

## 10. Platform Integrations

### StubHub (Primary Resale Platform)

**Role:** Primary sell-side platform. Occasionally buy-side when it's the cheapest option.

**Login Flow:**
1. Navigate to `stubhub.com` → Enter email `ddweck14@gmail.com` → Click Continue
2. StubHub sends 6-digit OTP to Gmail (`noreply@stubhub.com`, subject: "Your StubHub One Time Pin: ######")
3. Fetch OTP from Gmail via `gog` CLI
4. Enter OTP in `input[name="accessCode"]`
5. Click submit (use `page.mouse.click()` on bounding box — reCAPTCHA blocks normal `.click()`)
6. Wait for seller dashboard: `View all listings` / `Sales` / `Payments` / `Douglas Dweck`
7. Save cookies to `stubhub-seller-cookies.json` immediately

**Key Facts:**
- Seller fee: **15%** (fixed)
- Buyer fee: **VARIABLE 10-30%+** depending on event/price. NEVER assume fixed.
- Cookies expire in ~20-24 hours
- `headless: false` REQUIRED — StubHub blocks headless browsers
- Price edit: pencil SVG icon (path starts `M9.883 2.583a2 2 0 0 1 2.828 0`) → triple-click → type new price → Save → Confirm modal
- After listing or price change: verify via email (listings get email, price edits do NOT)

**Safety Rules:**
- 50% price drop safety limit — auto-reprice rejects drops >50%
- Always verify listing ID before any price change
- Read current price from input field — abort if doesn't match

### TickPick (Best Buy-Side Platform)

**Role:** Primary buy-side source. Zero buyer fees = cheapest all-in prices.

**API Endpoints:**
- Search: `GET https://api.tickpick.com/1.0/events?performerName={query}&limit=20`
- Listings: `GET https://api.tickpick.com/1.0/listings/internal/event-v2/{eventId}?trackView=false`
- Stats (used by ticket-watch-checker): search API returns min/max/avg/count

**Key Facts:**
- **Zero buyer fees** — listed price = all-in price
- No auth needed for search and basic listing access
- Listings endpoint uses Playwright page context to avoid Cloudflare
- `l.p` = price (all-in), `l.q` = quantity, `l.sid` = section, `l.r` = row
- Seller access: applied for broker portal, pending

### Gametime (Mobile API)

**Role:** Secondary buy-side source. Low fees, mobile API.

**API Endpoints:**
- Events: `GET https://mobile.gametime.co/v1/events?category={cat}&lat={lat}&lon={lon}&per_page=50`
- Listings: `GET https://mobile.gametime.co/v1/listings?event_id={id}`

**Key Facts:**
- Mobile User-Agent required: `Gametime/12.34.0 (iPhone; iOS 17.0; Scale/3.00)`
- **Prices in CENTS** — divide by 100 for dollars
- `l.price.prefee` = base price (cents), `l.price.total` = all-in (cents)
- `l.seats` = array (length = ticket count)
- `l.section`, `l.row`, `l.section_group` (zone)
- No auth required
- Buy-only platform (no seller access)
- Category codes: `mlb`, `nba`, `nhl`, `nfl`, `concert`

### SeatData (Data Provider)

**Role:** Primary data source for completed sales, active listing stats, event catalog.

**Plan:** Pro subscription at $129/mo  
**Login:** `ddweck14@gmail.com` / `Openclaw99!`  
**Auth method:** Playwright browser session (web session cookies, free with Pro)

**Also available (not currently used):**
- Official REST API: `api-key` header auth, $0.10/call
- Generate key from seatdata.io dashboard → API Keys
- Module pre-built: `seatdata-api.js`
- Decision memo: `SEATDATA-DECISION.md`

### Vivid Seats

**Role:** Secondary sell-side platform.  
**Status:** ⚠️ Cookies expired. Login needs refresh.  
**Seller fee:** 10%  
**Login:** `ddweck14@gmail.com`, address 102 Sherman Ave, Deal NJ, phone (848) 466-8516, PayPal: `spiceit@aol.com`

### SeatGeek

**Role:** Potential sell-side platform.  
**Status:** ❌ Pending — need to email `sellers@seatgeek.com` for seller API access.

### Ticketmaster

**Role:** Ticket transfer (fulfillment after sale).  
**Login:** `ddweck14@gmail.com` / `Openclaw99!!`  
**MFA:** SMS to phone ending 4950 (forwarded to Gmail via MacroDroid)  
**Transfer email format:** `ddweck14-{LISTING_ID}@ticketpreupload.com`  
**Status:** ✅ Login works, ⚠️ Transfer blocked on SMS MFA automation

---

## 11. Rules & Lessons Learned

### Pricing Rules (LOCKED)

| Rule | Detail | Source |
|------|--------|--------|
| **Same zone ALWAYS** | Buy section must be in the same zone as completed sales. No cross-zone comparisons ever. | Douglas, Mar 31 |
| **Same quantity ALWAYS** | Only use completed sales with exact same qty as the deal. No fallback to unknown qty. | Douglas, Mar 30 |
| **GA ≠ GA Plus** | "GA" and "GA Plus" are different zones. Never mix them. | Douglas, multiple times |
| **GA has NO row numbers** | Any listing with a row number is NOT General Admission. Hard rule. | Douglas, Mar 30 (told 3x) |
| **Recency-weighted benchmark** | Exponential decay, half-life 3 days. Most recent sale dominates. | Douglas, Mar 30 |
| **Never auto-buy** | Scanner alerts only. Douglas makes all purchase decisions. | Always |
| **50% price drop safety** | Auto-reprice rejects any drop >50%. Ask Douglas. | Mar 26 lesson |
| **Verify listing ID** | Before ANY price change: read listing ID from DOM, confirm match, read event name. Abort if mismatch. | TWICE incident, Mar 26 |

### Operational Rules

| Rule | Detail |
|------|--------|
| **OC- prefix on HA automations** | All Home Assistant automations created by OpenClaw must be prefixed "OC -" |
| **Biz deploys via deploy-biz.sh ONLY** | Never deploy to biz Netlify site directly — credential leakage risk |
| **Telegram messages SHORT** | No tables, no per-deal breakdowns. Just summary + "check email." |
| **Every platform script documented** | First time it works → save a runbook. Never re-derive a working flow. |
| **Follow saved runbooks** | Never improvise a flow that has a saved runbook. |
| **Check browser console myself** | Don't ask Douglas to debug. Use Playwright dev tools. |
| **Verify both MC instances** | When fixing one, verify the other still works. |
| **Register sub-agents on Factory** | Every spawned sub-agent gets a curl POST to `/api/factory/agents`. |
| **Shmack status active on every reply** | UPDATE mc_factory_agents at session start AND every incoming message. |

### Communication Rules

| Rule | Detail |
|------|--------|
| **No profanity** | Keep communication professional at all times. |
| **Wait for confirmation** | If asking yes/no, wait for reply before proceeding. |
| **Verified prices only** | Never show unverified ticket prices. |
| **Two links for every ticket** | Event name → event page, Price → direct purchase/checkout. |
| **SeatDeals is the template** | Copy their alert format exactly for our alerts. |

### Lessons Learned (Mistakes That Became Rules)

| Date | Mistake | Lesson | Rule Added |
|------|---------|--------|------------|
| Mar 26 | Clicked "Adjust price" on wrong listing, lost $64 on TWICE ticket | Always verify listing ID in DOM before any action | Listing ID verification required |
| Mar 26 | Price dropped $125→$23 (82% drop) without question | Sanity check: reject any drop >50% | 50% safety limit |
| Mar 30 | Used qty-0 sales as fallback for qty-2 deals | Strict qty matching, no fallbacks | Same qty always |
| Mar 30 | Gametime buy link pointed to StubHub checkout URL | Use `bestBuy.checkoutUrl` not SeatDeals checkout URL | Platform-correct links |
| Mar 31 | $43 upper-bowl ticket paired with Club zone (100%+ phantom ROI) | Buy listing must be in same zone as sales data | Zone matching via section-in-zone |
| Mar 31 | "Washington Capitals vs NJ Devils" matched "Boston Bruins at Florida Panthers" | Require nameHits >= 2, not just date match | Gametime team validation |
| Mar 31 | CONFIG.minROI typo (undefined) silently skipped ROI check | Always use `CONFIG.thresholds.minROI` | Fixed path |
| Mar 31 | Scanner sent 17 deals, then resent all 17 as duplicates 3 min later | In-memory dedup resets each run. Made dedup permanent (file-based). | Permanent dedup, no time window |
| Mar 31 | StubHub scraped for ALL events before knowing if any deal existed | Only scrape StubHub after ROI passes on SeatData data alone | Lazy StubHub fetch |
| Mar 25 | Springsteen $82 false alert (venue-wide stats, not Floor GA) | Exclude `isStats` results from filtered watch alerts | Stats-based price excluded from watches |
| Mar 25 | Scanner UI rules were decorative — no effect on behavior | Scanner must load all rules from DB on every run | `loadRulesFromDB()` |
| Mar 24 | `node: command not found` in cron jobs | Use full NVM path in all cron payloads | `/Users/douglasdweck/.nvm/versions/node/v22.22.1/bin/node` |
| Mar 24 | SeatData `/api/zone_sales?event_id=...` started returning 404 | Endpoint changed to `/api/salesdata?eventId=...` (camelCase) | Document API changes in runbook |

---

## 12. Source Code & Git Repository

### Getting the Code

The scanner source code is hosted on GitHub:

**Repository:** https://github.com/spiceit1/ticket-flip-scanner

```bash
# Clone the repository
git clone https://github.com/spiceit1/ticket-flip-scanner.git
cd ticket-flip-scanner

# Install dependencies
npm install

# Or if already on the machine, just pull latest
git pull
```

### Key Files Location

| File | Path | Purpose |
|------|------|---------|
| **scanner.js** | `deal-scanner/scanner.js` | Main scanner (~3,200 lines) |
| **rebuild-zone-cache-final.js** | `deal-scanner/rebuild-zone-cache-final.js` | Zone cache rebuild script |
| **seatdata-api.js** | `deal-scanner/seatdata-api.js` | SeatData REST API module |
| **zone-cache.json** | `deal-scanner/zone-cache.json` | Cached zone sales (~18MB) |
| **PROJECT-BIBLE.md** | `deal-scanner/PROJECT-BIBLE.md` | This documentation |

### Git Workflow

```bash
# Check status
git status

# Add new files
git add deal-scanner/new-file.js

# Commit changes
git commit -m "Description of changes"

# Push to remote
git push origin main
```

**Note:** The workspace is a git repository at `/Users/douglasdweck/.openclaw/workspace`. Always commit significant changes.

---

## 13. Credentials & Configuration

### Where Credentials Are Stored (NOT the values)

| Credential | Location |
|------------|----------|
| Neon DB connection string | Hardcoded in `scanner.js`, `auto-idle.js`, `listing-monitor.js` |
| SeatData email/password | Hardcoded in `scanner.js` CONFIG object |
| StubHub session cookies | `deal-scanner/stubhub-seller-cookies.json` |
| Ticketmaster cookies | `deal-scanner/ticketmaster-cookies.json` |
| Vivid Seats cookies | `deal-scanner/vividseats-cookies.json` |
| Netlify auth token | `MEMORY.md` (per-project) |
| Netlify site IDs | `MEMORY.md` (per-project) |
| Gmail account | `ddweck14@gmail.com` (used everywhere) |
| Anthropic API key | `~/.openclaw/agents/main/agent/models.json` → `providers.anthropic.apiKey` |
| Home Assistant token | `TOOLS.md` |
| GitHub credentials | `~/.git-credentials` |
| Google Workspace (gog) | Authenticated via `gog` CLI |
| All platform logins | `deal-scanner/CREDENTIALS.md` |

### Environment

| Setting | Value |
|---------|-------|
| Machine | Douglas's iMac |
| OS | macOS (Darwin 21.6.0 x64) |
| Node | v22.22.1 (NVM) |
| Node path | `/Users/douglasdweck/.nvm/versions/node/v22.22.1/bin/node` |
| Workspace | `/Users/douglasdweck/.openclaw/workspace` |
| Scanner directory | `/Users/douglasdweck/.openclaw/workspace/deal-scanner` |
| Timezone | America/New_York (EDT) |
| Default AI model | Claude Opus 4 (Anthropic Max subscription) |
| Sub-agent default | Claude Sonnet |

### Key URLs

| Resource | URL |
|----------|-----|
| Mission Control (personal) | https://shmack-hq.netlify.app |
| Mission Control (business) | https://shmack-biz.netlify.app |
| Mission Control (Tailscale) | https://douglass-imac-openclaw.tailff4bf.ts.net |
| SeatData | https://seatdata.io |
| Flip tracker sheet | https://docs.google.com/spreadsheets/d/1kJHbhB-VKnzwKCr52UrWMHVYDDhEgeCjN8yRMSwsubg/edit |
| Season ticket analysis | https://docs.google.com/spreadsheets/d/13V_wBI6244Xs1IFtV2V8TEZkBrrw4wFSGhhqHuHuqqc/edit |

### Operational Cadence

| Task | Frequency |
|------|-----------|
| Deal scanner | Every 20 minutes |
| Listing monitor | Every 2 hours |
| Ticket watch checker | Every 6 hours |
| Auto-idle | Every 2 minutes |
| Autonomous employee | Daily at 2 AM |
| Daily memory note | Daily at 12:05 AM |
| Zone cache rebuild | Manual, every 3-5 days |
| StubHub cookie refresh | Every ~20-24 hours (when needed) |

---

## Appendix A: Listing Monitor Urgency Schedule

| Time Until Event | Check Frequency |
|-----------------|-----------------|
| 7+ days | Every 6 hours |
| 3-7 days | Every 2 hours |
| 1-3 days | Every 30 min |
| Under 24 hours | Every 15 min |
| Day of event | Every 10 min |

## Appendix B: Fee Quick Reference

| Platform | Buyer Fee | Seller Fee | Notes |
|----------|-----------|------------|-------|
| StubHub | 10-30% (variable) | 15% | Buyer fee varies by event/price |
| TickPick | 0% | TBD (no seller access) | Zero fees = cheapest buy source |
| Gametime | 0-15% | N/A (buy only) | Prices in cents via API |
| Vivid Seats | ~20-30% | 10% | Cookies expired |
| SeatGeek | ~20% | TBD (no seller access) | Cloudflare protected |
| Ticketmaster | ~20% | N/A (transfer only) | Not a resale platform |

## Appendix C: Douglas's Phone Numbers

| Number | Service | Purpose |
|--------|---------|---------|
| (908) 309-4950 | Verizon (main) | Primary cell, MacroDroid forwards TM SMS to Gmail |
| (848) 466-8516 | Google Fi | Pixel 10 Pro, rejected by TM (but used for Vivid Seats) |
| (732) 655-9976 | Google Voice | Rejected by TM (VoIP) |

---

_This document is the single source of truth for the Ticket Flip Scanner project. Keep it updated as the system evolves._

---

## ADDENDUM: Three-Price Framework Implementation (April 1, 2026)

*This section was added after the 3am documentation run to capture the scanner rebuild completed that morning.*

### What Changed

The sell benchmark logic was completely rewritten to implement Douglas's three-price framework:

### New SeatData API Integration

The scanner now calls `/api/event_stats_zones?eventId={id}&zone={zoneName}` for each zone of each candidate event. This returns:
- `lowest_price` — cheapest active listing in the zone right now
- `median` — median price of all active listings in the zone
- `mean` — average price of all active listings

These come from the Pro plan's web portal API (no extra cost). The latest entry in the response array = current data.

### Outlier Detection

Before calculating ROI, the scanner checks if there's actually a price outlier in the zone:

```
gap = (median - lowest) / median
if gap < 30% → no outlier → skip zone
```

Examples:
- lowest=$275, median=$275 → 0% gap → skip (everything same price)
- lowest=$173, median=$189 → 8% gap → skip (normal price spread)
- lowest=$654, median=$1279 → 49% gap → outlier! → proceed to ROI check

### Three-Price Sell Benchmark

```javascript
function computeSellBenchmark(salesAnalysis, allListings, buyCost, dealQty, zoneActiveStats) {
  completedSalesAvg = recency-weighted avg from SeatData zone_sales
  activeFloor = zoneActiveStats.lowestPrice (from /api/event_stats_zones)

  if (activeFloor < completedSalesAvg):
    // Market dropped — undercut active sellers
    sell = activeFloor × (1 - undercutPct)
  else:
    // Sales price is lower — use proven sell level, no undercut needed
    sell = completedSalesAvg
}
```

### Undercut Settings (from mc_scanner_rules)
- `auto_list_undercut_mode`: "percent" or "dollars"
- `auto_list_undercut_pct`: 5 (meaning 5%)
- `auto_list_undercut_dollars`: 2 (meaning $2)

### `fetchZoneActiveStats()` Function

Located in scanner.js, calls SeatData's zone stats API:
```
/api/event_stats_zones?eventId={internalId}&zone={zoneName}
```
Note: `page.evaluate()` only accepts ONE argument — params must be wrapped in an object.

### Test Results (April 1, 2026 8:02 AM)

- Scan time: ~1.5 minutes for 30 events
- Events with zone stats fetched: ~15-20 zones across 10+ events
- Outlier detection correctly filtered:
  - Zones with 0-8% lowest/median gap → skipped
  - Zones with 30%+ gap → proceeded to ROI check
  - No false positives in this run
- Result: 0 deals (no genuine outliers in current market)
- This is CORRECT — the previous scanner was sending 15+ bad deals per run

### Key Discovery: SeatData Pro Plan API Endpoints

All available without API Access subscription (free with $129/mo Pro):
1. `/api/seatdeals/widget` — flagged deals with zone listings (next_prices_in_zone)
2. `/api/salesdata?eventId={id}&zoneName=ALL` — completed sales per zone
3. `/api/event_stats?eventId={id}` — event-level stats (total active listings, avg, lowest)
4. `/api/event_stats_zones?eventId={id}&zone={zoneName}` — **zone-level**: lowest, mean, median
5. `/api/events_appstack` — event catalog (DataTables format)

The Pro plan does NOT give individual listing-level data (section, row, price per listing).
That requires the API Access tier ($0.10/call first 500, scaling down).

For outlier detection, zone-level stats (lowest vs median) are sufficient.
