# Pokémon Card Arbitrage

A local TypeScript system that scans marketplace and retailer listings, estimates resale margins, and manages purchase review, inventory, and realized P&L. It runs on Node.js 26 with built-in SQLite and no external runtime dependencies.

## Architecture

1. **Supply connectors** normalize configured eBay, Best Buy, Costco Wholesale, Pokémon Center, Shopify storefront, and TCGplayer feeds into USD listings. The pipeline deduplicates unchanged listings before evaluation. The mock connector provides a repeatable fixture feed.
2. **Catalog and matching** resolve listings to canonical SKUs using identifiers and listing text. The resolver checks seller reputation, print and language variants, condition, certification, and listing red flags.
3. **Valuation and risk** use recent comparable sales and an outlier-trimmed, time-weighted median. The risk engine evaluates liquidity and expected net profit across eBay, TCGplayer, Cardmarket, and buylist exits, accounting for tax, shipping, fees, packaging, and risk reserves.
4. **Execution** applies the operating mode, records decisions and orders, and rechecks availability and cost before sanctioned API checkout. SQLite backs purchase locks, idempotency, order history, and the audit trail.
5. **Inventory** tracks acquisitions through intake QC and sale, provides exit recommendations, and reports predicted and realized profit. The CLI, dashboard, and MCP server share these operations.

| Asset class | Matching and evaluation |
| --- | --- |
| Sealed | Match UPC and product form where available. Check for empty boxes and misleading bundle descriptions. Evaluate sealed comps and shipping costs. |
| Graded | Match the card, grader, grade, and variant. An unverified certificate requires human review. The real runtime supports PSA certificate verification. |
| Raw | Match set, card number, language, print variant, and condition. Review photos and condition before purchase. Automatic raw checkout is disabled by default. |

### Operating modes and guardrails

| Mode | Behavior |
| --- | --- |
| shadow | Records opportunities for paper trading and blocks checkout. |
| hitl | Queues eligible orders for review. An explicit autopilot pass, daemon, or triage call can approve eligible orders within the autonomous policy. |
| live | Permits eligible automatic checkout. Review gates apply to anomalies, order size, raw cards by default, and sources without sanctioned checkout. |

The system applies profit, ROI, liquidity, match-confidence, seller-trust, and comp-freshness thresholds. Portfolio checks enforce the daily spend cap, cash reserve, and per-SKU position limit. The kill switch blocks new checkout in every mode, and the circuit breaker can engage it after consecutive connector failures. Anomaly-flagged orders require operator review and explicit confirmation. The real checkout adapter uses the eBay Order API for eBay listings. For other sources, review the listing and complete any purchase through the source's authorized checkout.

All amounts named with a `Cents` suffix use integer USD cents. ROI, fee rates, and discounts use ratios such as 0.15 for 15 percent. Seller positive feedback uses a 0–100 scale.

## CLI

Run commands from the repository root with Node.js 26. Install the development dependencies with `npm install` to run the typechecker.

| Command | Purpose |
| --- | --- |
| `npm run demo` | Run a simulated live scan in memory and print purchases, review items, and skipped listings. |
| `npm run scan -- --mock --db :memory: --mode shadow` | Run one scan and print the results. |
| `npm run serve -- --mock --db :memory: --mode hitl --port 3000` | Serve the loopback dashboard and MCP HTTP endpoint. Add `--poll-ms 60000` for recurring scans. |
| `npm run autopilot -- --mock --db :memory: --once` | Run the Buy Book, concurrent scan, triage, and repricing in one pass. |
| `node src/cli.ts mcp --mock --db :memory: --mode hitl` | Start a simulated MCP server over stdio. |
| `npm run typecheck` / `npm test` | Check TypeScript and run the test files. |

The default database path is `data/arbitrage.sqlite`. `serve` defaults to HITL and disables polling. `scan`, `mcp`, and `autopilot` use the persisted mode unless an explicit mode is configured. A new database starts in shadow mode. `--mock` seeds fixture SKUs and sales and uses simulated verification and checkout. Use an in-memory or separate database for fixture runs. Load real SKUs and comparable sales before running real feeds.

## Autonomous Competitive Engine

The Buy Book precomputes fair market value, liquidity, momentum, and exact zero-shipping ask ceilings for each SKU. The primary and buylist ceilings each satisfy the configured profit and ROI thresholds. Hot SKUs have fresh comps, at least 0.70 liquidity, and FMV of at least $100. Other fresh SKUs above the configured liquidity minimum are standard. The rest are cold. A drop of at least 15% between median comparable sales from the past 10 days and sales more than 10 through 60 days old blocks new eligible Wave 5 decisions. Each comparison window requires at least two sales.

Push intake and priority scans recover curated typos and known missing card-number slashes before matching. The engine reports buylist margin and raw-to-graded expected value without changing the existing risk decision thresholds. The grading model defaults to a $25 fee, a 60% top-grade probability, a 30% runner-up probability at 55% of top-grade FMV, and raw resale for the remaining outcomes. It applies selling fees, shipping, and packaging to each outcome. Treat those assumptions as estimates.

Run `node src/cli.ts autopilot --mode shadow --db :memory: --mock --once` for a summary of polling tiers, triage, repricing, and latency. Omit `--once` for recurring hot and standard polling at 5 and 30 seconds, with repricing every 60 seconds. Set `--hot-ms`, `--standard-ms`, and `--reprice-ms` to change those intervals. A full pass includes the cold tier. The engine polls enabled connectors concurrently through their existing API rate limiters and backoff.

Triage can approve eligible queued orders with a landed cost up to $500 by default. It checks the kill switch, momentum, authorized checkout and cached listing details. Raw approvals also require a trusted seller and at least two photos. Anomalies remain available for operator review unless an explicit triage call opts into rejection. A source is throttled after at least three sales with negative aggregate realized P&L, or after at least three completed checkout attempts if more than half failed. Telemetry reports p50, p95, p99, and max processing and checkout latency plus signal counts, execution rates, and source P&L. Latency samples and intake counters are process-local. Completed orders and sales are read from SQLite.

Fulfillment recommends immediate buylist when its net profit clears the configured minimum and is within 10% of the top exit. For other exits, raw and graded items with at least $250 FMV qualify for vault consignment. Repricing records the route and updates local listing records for QC-passed or listed inventory. The default price discount grows with time since acquisition, up to 8% over 14 days, with a $5 minimum modeled net profit after selling fees, shipping, packaging, and purchase cost. Vault routing is a recommendation. Marketplace listing and vault submission are separate operator actions.

### Loopback HTTP

`serve` exposes these endpoints to local clients. Push requests use the dashboard's local host and same-origin protections.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/buy-book?tier=hot&refresh=true` | Read entries, optionally filtering by hot, standard, or cold and rebuilding the book. |
| `GET /api/telemetry` | Read alpha, latency, and source performance metrics. |
| `POST /api/webhooks/listing` | Push a listing through the fast path under the persisted operating mode. |
| `POST /api/autopilot/pass` | Run a pass using optional JSON field `tier` with `all`, `hot`, `standard`, or `cold`. |

For example, push a fixture from the same host while running `serve --mock --mode shadow`.

```sh
curl http://127.0.0.1:3000/api/webhooks/listing \
  -H 'Content-Type: application/json' \
  -d '{"listingId":"local-example","title":"Surging Spaks Boster Box","priceCents":9500,"upc":"820650859120"}'
```

Supply the source's stable `listingId`, actual seller profile, and checkout capability when integrating a feed. Omitted seller details default to an unknown seller. Set `force: true` to bypass unchanged-listing deduplication. Checkout idempotency still applies.

## MCP integration

The server negotiates `2025-03-26` and `2024-11-05`. It exposes 21 tools, 8 resources, and 4 prompts over both transports.

**Stdio.** Launch `node src/cli.ts mcp` directly from a client. The process reads one JSON-RPC frame per line from stdin and writes only JSON-RPC frames to stdout. Use the Node command in client configuration to keep npm's script banner out of the stream.

The repository's `.mcp.json` configures a local HITL server. Set absolute paths for the CLI and database if your client launches it from another directory.

```json
{
  "mcpServers": {
    "pokemon-arbitrage": {
      "command": "node",
      "args": ["src/cli.ts", "mcp", "--db", "data/arbitrage.sqlite", "--mode", "hitl"]
    }
  }
}
```

**HTTP.** `serve` exposes a local JSON endpoint at `http://127.0.0.1:3000/mcp`. Send JSON-RPC requests, notifications, or batch arrays with `POST` and `Content-Type: application/json`. Requests return HTTP 200 with a JSON-RPC body. Notification-only messages return HTTP 202 with an empty body. Both include `Mcp-Protocol-Version`. The endpoint uses plain request/response JSON for trusted local clients. It requires no login, rejects foreign browser origins, and has no SSE session support.

### Tools

Use `tools/list` for input schemas and `tools/call` with `params.name` and `params.arguments` to invoke a tool. Validation failures return JSON-RPC invalid-params errors. Operational failures return tool results with `isError: true`. Successful results include JSON in text content and structured content.

| Tool | Purpose |
| --- | --- |
| `get_system_state` | Read dashboard metrics, P&L, active feeds, and risk thresholds. |
| `set_operating_mode` | Set shadow, HITL, or live mode. |
| `set_kill_switch` | Engage or clear the purchase stop and record an optional reason. |
| `run_scan_cycle` | Run a scan and return the summary and recent queued and filled orders. |
| `list_catalog_skus` | Filter SKUs by asset class, language, or text. Optionally include valuations and position counts. |
| `upsert_catalog_sku` | Create or update a SKU and optionally load sold comps. Supply a stable ID for each comp. |
| `evaluate_listing` | Evaluate a hypothetical listing without checkout. `persistDecision: true` saves the decision. |
| `list_decisions` | Read recent decisions by action and limit. |
| `list_orders` | Read recent orders by status and limit. |
| `approve_hitl_order` | Submit a pending order to the checkout path. Pass `confirmAnomaly: true` after operator review of an anomaly. |
| `reject_hitl_order` | Reject a pending order with an operator reason. |
| `list_inventory` | Read inventory by status and portfolio P&L. |
| `record_intake_qc` | Record an intake inspection and observed condition. |
| `recommend_exit_channel` | Compare exit channels and estimated net proceeds. |
| `record_inventory_sale` | Record an actual sale and realized profit. |
| `list_audit_events` | Read recent operational events. |
| `get_buy_book` | Read buy thresholds and momentum with optional `tier` and `refresh`. |
| `get_alpha_telemetry` | Read latency percentiles, signal counts, rates, and source throttling. |
| `ingest_webhook_listing` | Push a listing through the current operating mode, with optional `skipDeduplication`. |
| `run_autonomous_triage` | Process the review queue with optional `maxApproveCents` and `autoRejectAnomalies`. |
| `run_repricing_cycle` | Update local listing records based on item age, exit channel, and profit floor. |

`run_scan_cycle` with `useMock: true` selects the fixture feed and seeds an empty catalog. The runtime's verifier and checkout adapter are selected at startup. Launch with `--mock` to simulate the whole workflow. `evaluate_listing` supplies a hypothetical trusted seller when seller data is omitted. Supply the actual seller profile when assessing seller trust.

### Resources

Read these JSON snapshots with `resources/read`.

| URI | Content |
| --- | --- |
| `pokemon-arbitrage://state` | Dashboard, risk thresholds, connectors, and P&L. |
| `pokemon-arbitrage://hitl-queue` | Pending orders awaiting review. |
| `pokemon-arbitrage://catalog` | Canonical catalog SKUs. |
| `pokemon-arbitrage://inventory` | Inventory and P&L attribution. |
| `pokemon-arbitrage://decisions/recent` | Recent arbitrage decisions. |
| `pokemon-arbitrage://audit/recent` | Recent audit events. |
| `pokemon-arbitrage://buy-book` | SKU buy thresholds, momentum, and polling tiers. |
| `pokemon-arbitrage://telemetry` | Latency, alpha signal counts, and source execution outcomes. |

### Prompts

Retrieve a prompt with `prompts/get`.

| Prompt | Content |
| --- | --- |
| `review_hitl_queue` | Pending orders and risk guardrails for operator review. Optionally supply `focusOrderId`. |
| `daily_arbitrage_briefing` | Current metrics, P&L attribution, and recent decisions. |
| `incident_triage` | System state, kill switch status, recent audit events, and failed orders. |
| `autopilot_optimization` | Buy Book tiers, alpha telemetry, settings, and system state. |

## Costco Wholesale and Pokémon Center feeds

Use an authorized HTTPS JSON feed for each retailer. Feed URLs and product links require HTTPS without embedded credentials. Feed requests reject redirects. Both connectors provide listing links for human review and manual checkout.

| Source | Feed format and filtering |
| --- | --- |
| Costco Wholesale (`costco`) | Returns an `items` or `products` array. Each item supplies `itemNumber`, `title`, `url`, and a positive `priceCents` or a USD `price`. The connector filters for Pokémon by catalog UPC or text in the title, brand, or category. It skips out-of-stock items and items unavailable online. Review the warehouse, membership requirement, and any per-member limit before checkout. |
| Pokémon Center (`pokemon_center`) | Returns a `products` or `items` array. Each product supplies `productSku` (or `sku`), `title`, `url`, and a positive integer `priceCents`. The connector accepts `available: true`, `in_stock`, and `preorder`, and skips listings marked unavailable, out of stock, or sold out. Listing metadata includes region and any supplied exclusivity, availability, or purchase limit fields. |

Both feeds accept optional `upc`, `description`, `imageUrl`, and `shippingCents` fields. Prices are in USD. Shipping defaults to zero if the feed omits it. Verify final cost and availability when reviewing the listing.

## Environment variables

Export connector credentials for the process that launches the CLI or MCP server.

| Variable | Use |
| --- | --- |
| `EBAY_ACCESS_TOKEN` | eBay Browse API access. |
| `EBAY_ORDER_API_TOKEN` | eBay Order API checkout access. |
| `BESTBUY_API_KEY` | Best Buy catalog API access. |
| `COSTCO_FEED_URL` | Authorized Costco HTTPS JSON feed. Set this to enable the connector. |
| `COSTCO_API_KEY` | Optional bearer token for the Costco feed. |
| `COSTCO_WAREHOUSE_ID` | Optional Costco `warehouseId` query parameter. |
| `POKEMON_CENTER_FEED_URL` | Authorized Pokémon Center HTTPS JSON feed. Set this to enable the connector. |
| `POKEMON_CENTER_API_KEY` | Optional bearer token for the Pokémon Center feed. |
| `POKEMON_CENTER_REGION` | Region sent in `X-Pokemon-Center-Region`. Defaults to `US`. |
| `LGS_SHOPIFY_DOMAINS` | Comma- or whitespace-separated Shopify storefront domains. |
| `TCGPLAYER_API_TOKEN` | TCGplayer pricing feed access. |
| `PSA_API_TOKEN` | PSA certificate lookup. |

| Setting | Default |
| --- | --- |
| `ARBITRAGE_DB_PATH` | `data/arbitrage.sqlite` |
| `ARBITRAGE_MODE` | New databases start in `shadow`. `serve` defaults to `hitl`. |
| `ARBITRAGE_MIN_PROFIT_CENTS` | `1500` |
| `ARBITRAGE_MIN_NET_ROI` | `0.15` |
| `ARBITRAGE_MIN_LIQUIDITY_SCORE` | `0.30` |
| `ARBITRAGE_MIN_MATCH_CONFIDENCE` | `0.80` |
| `ARBITRAGE_MAX_ANOMALY_DISCOUNT` | `0.60` |
| `ARBITRAGE_ALLOW_RAW_AUTO_BUY` | Disabled. Set `true` or `1` to enable. |
| `ARBITRAGE_AUTO_BUY_MAX_ORDER_CENTS` | `50000` |
| `ARBITRAGE_DAILY_CAP_CENTS` | `100000` |
| `ARBITRAGE_MAX_POSITION_PER_SKU` | `5` |
| `ARBITRAGE_CASH_BALANCE_CENTS` | `500000` |
| `ARBITRAGE_MIN_CASH_RESERVE_CENTS` | `50000` |
| `ARBITRAGE_SALES_TAX_RATE` | `0.08` |
| `ARBITRAGE_STALE_COMP_MAX_AGE_DAYS` | `21` |
| `ARBITRAGE_MIN_COMP_COUNT` | `3` |
| `ARBITRAGE_SELLER_MIN_FEEDBACK` | `50` |
| `ARBITRAGE_SELLER_MIN_POSITIVE_PERCENT` | `98.5` |
| `ARBITRAGE_SELLER_MIN_ACCOUNT_AGE_DAYS` | `90` |
| `ARBITRAGE_CIRCUIT_BREAKER_MAX_ERRORS_PER_WINDOW` | `5` |

The optional vision verifier supports `VISION_API_URL`, `VISION_API_KEY`, and `VISION_MODEL` when explicitly injected. The CLI runtime uses the heuristic verifier.
