# 🎟️ Deal Scanner & Ticket Automation

Automated ticket arbitrage: find deals, list tickets, monitor prices, detect sales.

## Production Scripts

### Core Scanner
| Script | Purpose | Schedule |
|--------|---------|----------|
| `scanner.js` | Main deal scanner — SeatData + TickPick cross-reference | Every 20 min (cron) |
| `run.sh` | Shell wrapper for scanner.js | Called by cron |
| `seatdata-api.js` | SeatData REST API module (ready, not yet active) | — |

### StubHub Automation
| Script | Purpose |
|--------|---------|
| `stubhub-full-listing.js` | List a new ticket on StubHub |
| `stubhub-auto-reprice.js` | Auto-reprice a listing (used by listing-monitor) |
| `stubhub-refresh-cookies.js` | Refresh StubHub session cookies (requires OTP) |

### Monitoring & Detection
| Script | Purpose | Schedule |
|--------|---------|----------|
| `listing-monitor.js` | Monitor competitor prices, auto-adjust ours | Every 2h (cron) |
| `ticket-watch-checker.js` | Check prices for watched tickets across platforms | Every 6h (cron) |
| `sold-detector.js` | Detect StubHub sales via Gmail | — |
| `auto-delist.js` | Auto-delist from other platforms when sold | — |
| `post-sale-handler.js` | Post-sale workflow (update flip tracker, etc.) | — |

### Other Platforms
| Script | Purpose | Status |
|--------|---------|--------|
| `ticketmaster-login.js` | TM login flow | ✅ Working |
| `tm-transfer-ticket.js` | TM ticket transfer | ⚠️ Blocked on SMS MFA |
| `tm-try-voice-otp.js` | TM voice OTP experiment | ⚠️ Experimental |
| `vividseats-login.js` | Vivid Seats login | ⚠️ Needs cookie refresh |
| `vividseats-listing.js` | Vivid Seats listing | ⚠️ Blocked on login |

### Data Files
| File | Purpose |
|------|---------|
| `deals-found.json` | Tracked deals (deduplication) |
| `sold-state.json` | Sold detector state |
| `zone-cache.json` | Cached zone sales data |
| `stubhub-seller-cookies.json` | StubHub session |
| `ticketmaster-cookies.json` | TM session |
| `vividseats-cookies.json` | Vivid Seats session |
| `scanner.log` | Scanner execution log |

### Runbooks & Docs
| File | Purpose |
|------|---------|
| `PLATFORM-SCRIPTS.md` | **Master index** — all scripts documented |
| `MARKETPLACE-RULES.md` | Platform fee structures & rules |
| `CREDENTIALS.md` | Login credentials reference |
| `SEATDATA-DECISION.md` | SeatData Pro vs API cost analysis |
| `STUBHUB-LOGIN-RUNBOOK.md` | StubHub OTP login flow |
| `STUBHUB-LISTING-RUNBOOK.md` | StubHub listing flow |
| `STUBHUB-AUTO-REPRICE-RUNBOOK.md` | Auto-reprice flow |
| `STUBHUB-UPDATE-PRICE-RUNBOOK.md` | Manual price update flow |
| `TICKETMASTER-LOGIN-RUNBOOK.md` | TM login + transfer flow |
| `platform-audit.md` | Platform capability audit |

### Archive
`_archive/` — 71 deprecated experiment/debug scripts. Not needed for operations.

## How the Scanner Works

1. Logs into SeatData Pro → pulls SeatDeals (pre-flagged arbitrage opportunities)
2. Gets completed sales data by zone (last 7 days, max 15 sales)
3. Cross-references buy prices: TickPick (zero fees) + StubHub
4. Calculates real ROI: sell benchmark × 0.85 (after 15% seller fee) vs buy cost
5. Alerts only when: ROI > threshold, sufficient completed sales, event in date range
6. All thresholds controlled via Mission Control Rules tab (no code changes needed)

## Key Rules

- ❌ Never auto-buy — alert only, Douglas decides
- ✅ Auto-reprice on StubHub when overpriced (listing-monitor)
- ✅ Completed sales = sell benchmark (not active listings)
- ✅ TickPick = best buy source (zero buyer fees)
- ✅ All flows documented in runbooks — follow runbooks, don't improvise
