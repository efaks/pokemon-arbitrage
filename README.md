# Pokémon Card Arbitrage

A local TypeScript system that scans marketplace and retailer listings, estimates resale margins, and manages purchase review, inventory, and realized P&L. It runs on Node.js 26 with built-in SQLite and no external runtime dependencies.

See [AGENTS.md](AGENTS.md) for Muse and MCP setup, the autonomous buying loop, and operator guardrails. Copy [.env.example](.env.example) to a local `.env` to configure credentials and optional limits.

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
| `npm run doctor` | Review configuration, comp freshness, and operating readiness. Use `npm run --silent doctor -- --json` for JSON-only output. |
| `npm run bootstrap` | Upsert 20 starter SKUs without fixture sales. Run market sync afterward. |
| `npm run scan -- --mock --db :memory: --mode shadow` | Run one scan and print the results. |
| `npm run sync -- --db data/arbitrage.sqlite --limit 50` | Import market data from configured providers and print a JSON summary. |
| `npm run import-comps -- --file sales.csv --db data/arbitrage.sqlite` | Import historical sales from a CSV or JSON file and report accepted, duplicate, and rejected rows. |
| `npm run serve -- --mock --db :memory: --mode hitl --port 3000` | Serve the loopback dashboard and MCP HTTP endpoint. Add `--poll-ms 60000` for recurring scans. |
| `npm run autopilot -- --mock --db :memory: --once` | Run the Buy Book, concurrent scan, triage, and repricing in one pass. |
| `node src/cli.ts mcp --mock --db :memory: --mode hitl` | Start a simulated MCP server over stdio. |
| `npm run typecheck` / `npm test` | Check TypeScript and run the test files. |

The default database path is `data/arbitrage.sqlite`. `serve` disables polling by default. `serve`, `scan`, `mcp`, and `autopilot` use the persisted mode unless an explicit mode is configured. A new database starts in shadow mode. `--mock` seeds fixture SKUs and sales and uses simulated verification and checkout. Use an in-memory or separate database for fixture runs. Load real SKUs and comparable sales before running real feeds.

## Autonomous Competitive Engine

The Buy Book precomputes fair market value, liquidity, momentum, and exact zero-shipping ask ceilings for each SKU. The primary and buylist ceilings each satisfy the configured profit and ROI thresholds. Hot SKUs have fresh comps, at least 0.70 liquidity, and FMV of at least $100. Other fresh SKUs above the configured liquidity minimum are standard. The rest are cold. A drop of at least 15% between median comparable sales from the past 10 days and sales more than 10 through 60 days old blocks new eligible Wave 5 decisions. Each comparison window requires at least two sales.

Push intake and priority scans recover curated typos and known missing card-number slashes before matching. The engine reports buylist margin and raw-to-graded expected value without changing the existing risk decision thresholds. The grading model defaults to a $25 fee, a 60% top-grade probability, a 30% runner-up probability at 55% of top-grade FMV, and raw resale for the remaining outcomes. It applies selling fees, shipping, and packaging to each outcome. Treat those assumptions as estimates.

Run `node src/cli.ts autopilot --mode shadow --db :memory: --mock --once` for a summary of polling tiers, triage, repricing, and latency. Omit `--once` for recurring hot and standard polling at 5 and 30 seconds, with repricing every 60 seconds. Set `--hot-ms`, `--standard-ms`, and `--reprice-ms` to change those intervals. Add `--sync-ms 3600000` to sync market data and refresh the Buy Book hourly in daemon mode. A full pass includes the cold tier. The engine polls enabled connectors concurrently through their existing API rate limiters and backoff.

Triage can approve eligible queued orders with a landed cost up to $500 by default. It checks the kill switch, momentum, authorized checkout and cached listing details. Raw approvals also require a trusted seller and at least two photos. Anomalies remain available for operator review unless an explicit triage call opts into rejection. A source is throttled after at least three sales with negative aggregate realized P&L, or after at least three completed checkout attempts if more than half failed. Telemetry reports p50, p95, p99, and max processing and checkout latency plus signal counts, execution rates, and source P&L. Latency samples and intake counters are process-local. Completed orders and sales are read from SQLite.

Fulfillment recommends immediate buylist when its net profit clears the configured minimum and is within 10% of the top exit. For other exits, raw and graded items with at least $250 FMV qualify for vault consignment. The default repricing discount grows with time since acquisition, up to 8% over 14 days, with a $5 minimum modeled net profit after selling fees, shipping, packaging, and purchase cost. Vault routing is a recommendation.

In live mode with the kill switch clear, asynchronous repricing pushes eligible price changes to active eBay offers. Set `ARBITRAGE_AUTO_PUBLISH_LISTINGS=true` to also publish QC-passed items whose direct marketplace route is eBay. Manual publish calls use the chosen channel and an explicit price or the item's FMV. With a configured eBay adapter, an explicit call can publish to eBay. Set `pushLive: false` to record a local listing for a QC-passed item. For eBay publication, provide item photos in `imageUrls` or set a suitable catalog reference image. eBay requires an image and can require category-specific listing details. Withdrawal clears active listing fields and returns the item to QC-passed status, making it eligible for future automatic publication if enabled. [eBay publishing requirements](https://developer.ebay.com/api-docs/sell/static/inventory/publishing-offers.html)

### Loopback HTTP

`serve` exposes these endpoints to local clients. Push requests use the dashboard's local host and same-origin protections.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/buy-book?tier=hot&refresh=true` | Read entries, optionally filtering by hot, standard, or cold and rebuilding the book. |
| `GET /api/telemetry` | Read alpha, latency, and source performance metrics. |
| `GET /api/readiness` | Read the same configuration and catalog readiness report as `doctor --json`. |
| `POST /api/webhooks/listing` | Push a listing through the fast path under the persisted operating mode. |
| `POST /api/autopilot/pass` | Run a pass using optional JSON field `tier` with `all`, `hot`, `standard`, or `cold`. |
| `POST /api/sync` | Run market sync using an optional positive integer `limit`, then refresh the Buy Book. |
| `POST /api/comps/import` | Import historical sales with `comps`, `csv`, or both. |
| `POST /api/inventory/:id/publish` | Publish a listing with optional `channel`, `listedPriceCents`, `title`, `description`, `imageUrls`, and `pushLive`. |
| `POST /api/inventory/:id/withdraw` | Withdraw a listing with an optional `reason`. |
| `GET /api/setup-guide` | Read the interactive onboarding guide, target profile, checkpoints, and readiness. |
| `POST /api/setup-guide/workflow` | Select a profile, acknowledge or skip a step with a note or reason, clear a step checkpoint, or reset onboarding. Returns the refreshed guide. |
| `POST /api/catalog/expand` | Install a catalog `pack` (defaults to `all_curated`). |
| `POST /api/inventory/reconcile-sales` | Record paid eBay sales. Accepts optional `sinceIso` and `limit` (1–200). |

For example, push a fixture from the same host while running `serve --mock --mode shadow`.

```sh
curl http://127.0.0.1:3000/api/webhooks/listing \
  -H 'Content-Type: application/json' \
  -d '{"listingId":"local-example","title":"Surging Spaks Boster Box","priceCents":9500,"upc":"820650859120"}'
```

Supply the source's stable `listingId`, actual seller profile, and checkout capability when integrating a feed. Omitted seller details default to an unknown seller. Set `force: true` to bypass unchanged-listing deduplication. Checkout idempotency still applies.

## MCP integration

The server negotiates `2025-03-26` and `2024-11-05`. It exposes 37 tools, 10 resources, and 6 prompts over both transports.

**Stdio.** Launch `node src/cli.ts mcp` directly from a client. The process reads one JSON-RPC frame per line from stdin and writes only JSON-RPC frames to stdout. Use the Node command in client configuration to keep npm's script banner out of the stream.

The repository's `.mcp.json` uses the persisted SQLite mode unless `ARBITRAGE_MODE` sets the startup mode. Use the repository root as the launch directory for automatic `.env` loading. Set absolute paths for the CLI and database if your client launches it from another directory.

```json
{
  "mcpServers": {
    "pokemon-arbitrage": {
      "command": "node",
      "args": ["src/cli.ts", "mcp", "--db", "data/arbitrage.sqlite"]
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
| `run_repricing_cycle` | Calculate listing prices and push eligible changes to active eBay offers in live mode. |
| `import_sold_comps` | Import `comps`, `csv`, or both, and refresh the Buy Book. |
| `publish_inventory_listing` | Publish a QC-passed item. Accepts `inventoryId` and optional listing fields. Use `pushLive: false` for local publication. |
| `withdraw_inventory_listing` | Withdraw an active listing by `inventoryId` with an optional `reason`. |
| `sync_market_data` | Import market data and refresh the Buy Book. Accepts an optional positive integer `limit`. |
| `check_readiness` | Check operating mode, kill switch, comp freshness, feed configuration, and checkout capability. |
| `bootstrap_catalog` | Upsert the starter SKUs and refresh the Buy Book. Set `includeDemoComps: true` only in a demo database. |
| `run_autopilot_pass` | Scan, triage, reconcile sales, and reprice. Accepts optional `tier` (`all`, `hot`, `standard`, or `cold`), `syncFirst`, and positive integer `syncLimit`. Returns the pass and optional sync summary. |
| `get_setup_guide` | Read the eight-step interactive onboarding workflow, target profile, current step, and readiness. |
| `update_setup_workflow` | Checkpoint `targetProfile`, `acknowledgeStep` with `note`, or `skipStep` with `reason`. Use `clearStep` to remove a step checkpoint or `reset: true` by itself to reset onboarding. Returns the refreshed guide. |
| `configure_settings` | Store allowlisted `settings` in a private `.env` file. Use `null` to remove a key and `reloadRuntime: false` to defer applying changes. |
| `start_ebay_oauth` | Build the operator consent URL using the registered RuName and selected scopes. |
| `complete_ebay_oauth` | Exchange the code or pasted redirect URL and save the refresh token to the selected buy and/or sell settings. |
| `discover_ebay_policies` | Read seller policies and locations. Optionally save defaults or create an approved warehouse. |
| `test_provider_connection` | Probe eBay, market data, retail feeds, PSA, vision, and webhook connectivity. |
| `reconcile_ebay_sales` | Record paid eBay sales and return current available cash in USD cents. |
| `expand_catalog` | Install a curated catalog pack and optionally sync market data for a limited number of SKUs. |

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
| `pokemon-arbitrage://readiness` | Live readiness report with blockers, warnings, and next actions. |
| `pokemon-arbitrage://setup-guide` | Interactive onboarding guide with target profiles, saved checkpoints, progress, and the next step. |

### Prompts

Retrieve a prompt with `prompts/get`.

| Prompt | Content |
| --- | --- |
| `review_hitl_queue` | Pending orders and risk guardrails for operator review. Optionally supply `focusOrderId`. |
| `daily_arbitrage_briefing` | Current metrics, P&L attribution, and recent decisions. |
| `incident_triage` | System state, kill switch status, recent audit events, and failed orders. |
| `autopilot_optimization` | Buy Book tiers, alpha telemetry, settings, and system state. |
| `autonomous_buyer` | Current readiness and the setup, shadow, and buying loop for Muse and MCP agents. |
| `guided_setup_wizard` | Live checklist and an interactive onboarding playbook for Muse. |

## Costco Wholesale and Pokémon Center feeds

Use an authorized HTTPS JSON feed for each retailer. Feed URLs and product links require HTTPS without embedded credentials. Feed requests reject redirects. Both connectors provide listing links for human review and manual checkout.

| Source | Feed format and filtering |
| --- | --- |
| Costco Wholesale (`costco`) | Returns an `items` or `products` array. Each item supplies `itemNumber`, `title`, `url`, and a positive `priceCents` or a USD `price`. The connector filters for Pokémon by catalog UPC or text in the title, brand, or category. It skips out-of-stock items and items unavailable online. Review the warehouse, membership requirement, and any per-member limit before checkout. |
| Pokémon Center (`pokemon_center`) | Returns a `products` or `items` array. Each product supplies `productSku` (or `sku`), `title`, `url`, and a positive integer `priceCents`. The connector accepts `available: true`, `in_stock`, and `preorder`, and skips listings marked unavailable, out of stock, or sold out. Listing metadata includes region and any supplied exclusivity, availability, or purchase limit fields. |

Both feeds accept optional `upc`, `description`, `imageUrl`, and `shippingCents` fields. Prices are in USD. Shipping defaults to zero if the feed omits it. Verify final cost and availability when reviewing the listing.

## Environment variables

The CLI loads `.env` from the working directory, including when launched over MCP stdio. Shell variables take precedence. Set `ARBITRAGE_SKIP_DOTENV=1` in the shell to skip loading. Explicit MCP settings changes apply to the running process by default. Keep `.env` at mode `0600` and out of version control.

| Variable | Use |
| --- | --- |
| `EBAY_CLIENT_ID` | eBay OAuth client ID. Browse mints an application access token when both client credentials are set. |
| `EBAY_RU_NAME` | Registered eBay OAuth redirect name used by the consent and code exchange tools. |
| `EBAY_CLIENT_SECRET` | eBay OAuth client secret. OAuth tokens are cached in memory and refreshed near expiry. |
| `EBAY_REFRESH_TOKEN` | Consented user refresh token for eBay member checkout. Requires both client credentials and approved Order API access. |
| `EBAY_ACCESS_TOKEN` | Static Browse access token for use without OAuth client credentials. |
| `EBAY_ORDER_API_TOKEN` | Static Order API user access token for use without member OAuth credentials. |
| `EBAY_SELL_API_TOKEN` | Static eBay Sell Inventory user access token with the `sell.inventory` scope. |
| `EBAY_SELL_REFRESH_TOKEN` | Sell Inventory user refresh token. A blank value falls back to `EBAY_REFRESH_TOKEN` when configured. OAuth also requires the client ID, client secret, and Sell Inventory scope. |
| `EBAY_FULFILLMENT_POLICY_ID` | Seller's eBay US shipping policy ID. |
| `EBAY_PAYMENT_POLICY_ID` | Seller's eBay US payment policy ID. |
| `EBAY_RETURN_POLICY_ID` | Seller's eBay US return policy ID. |
| `EBAY_MERCHANT_LOCATION_KEY` | Key of the seller's registered eBay inventory location. |
| `EBAY_SELL_SANDBOX` | Set to `true` to use eBay sandbox Sell Inventory and OAuth endpoints. |
| `POKEMON_TCG_API_KEY` | Enables the Pokémon TCG API catalog and TCGplayer market price sync. |
| `PRICECHARTING_API_TOKEN` | Enables PriceCharting price snapshots. |
| `EBAY_INSIGHTS_ENABLED` | Set to `true` to enable sold comps with an approved Marketplace Insights token or OAuth credentials. |
| `EBAY_INSIGHTS_CATEGORY_IDS` | Optional comma-separated category IDs approved for the Marketplace Insights application. |
| `VISION_API_KEY` | API key for live listing photo assessment. |
| `VISION_API_URL` | OpenAI-compatible API base or chat completions endpoint. The runtime selects live vision when both URL and key are set. |
| `VISION_MODEL` | Vision model name. Defaults to `gpt-4o-mini`. |
| `ARBITRAGE_WEBHOOK_URL` | Sends live decision, order, and circuit breaker alerts to the configured webhook. MCP stdio reserves stdout for JSON-RPC. |
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
| `ARBITRAGE_MODE` | New databases start in `shadow`. Existing databases retain their mode when this setting is blank. |
| `ARBITRAGE_AUTO_PUBLISH_LISTINGS` | Disabled. Set to `true` to enable automatic publication on the eBay route in live mode. |
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

## Market data sync

Sync runs configured providers in order and returns per-provider import counts and errors. The default limit is 50 catalog results for Pokémon TCG API and 50 catalog SKUs each for PriceCharting and eBay. A repeated sync on the same UTC day skips existing pricing snapshots, and eBay sales deduplicate by item ID. The HTTP and MCP entry points also refresh the in-process Buy Book.

```sh
npm run sync -- --db data/arbitrage.sqlite --limit 10
curl http://127.0.0.1:3000/api/sync -H 'Content-Type: application/json' -d '{"limit":10}'
```

TCGplayer and PriceCharting imports are market price snapshots that feed valuation. Marketplace Insights provides eBay sales and requires limited-release access and approved search categories. [Pokémon TCG card data](https://docs.pokemontcg.io/api-reference/cards/card-object/) · [eBay Buy API requirements](https://developer.ebay.com/api-docs/buy/buy-requirements.html)

| SKU tier | PriceCharting field |
| --- | --- |
| Raw | `loose-price` |
| Sealed | `new-price` |
| PSA 10 | `manual-only-price` |
| BGS 10 | `bgs-10-price` |
| CGC 10 | `condition-17-price` |
| Grade 9.5 | `box-only-price` |
| Grade 9 | `graded-price` |
| Grade 8 or 8.5 | `new-price` |
| Grade 7 or 7.5 | `cib-price` |

Wave 8 skips unsupported tiers, including SGC 10, whose `condition-18-price` is recognized as an API field. Existing snapshots stay in the database. [PriceCharting price fields](https://www.pricecharting.com/api-documentation)

### Importing historical sales

Use catalog SKU IDs, a supported source such as `ebay` or `tcgplayer`, a positive sale price, and a timezone-qualified ISO 8601 sale timestamp. CSV supports `soldPriceCents` or `soldPriceUsd` and optional `shippingCents` or `shippingUsd`. JSON uses a top-level array with integer-cent fields. Both accept optional `condition`, `grader`, `grade`, and `id`. The importer defaults to zero shipping, uses the SKU's grader and grade when omitted, and derives a stable ID for rows without one.

```csv
skuId,source,soldPriceUsd,shippingUsd,soldAt,id
sealed-ssp-bb,ebay,165.50,5.00,2026-11-26T16:00:00Z,sale-001
```

```sh
npm run import-comps -- --file sales.csv --db data/arbitrage.sqlite
```

Check the returned `inserted`, `duplicatesSkipped`, and `rejected` counts. Fresh sales affect FMV as soon as enough eligible comps are present. HTTP and MCP imports refresh the in-process Buy Book immediately.

## Going Live Checklist

1. Run `npm test` and `npm run demo`, then create a separate database for real data. Keep it in shadow mode while validating feeds.
2. Configure eBay application credentials. For member checkout, confirm production Order API approval and obtain a refresh token with the appropriate member permissions. Enable Marketplace Insights only after confirming entitlement and category access. [eBay Order API](https://developer.ebay.com/api-docs/buy/api-order.html)
3. Run `npm run bootstrap` to seed the starter catalog. Configure the market data providers you use, run a small sync, and review its errors, catalog matches, prices, and Buy Book entries. Use `npm run doctor` to check comp freshness and setup blockers.
4. Set the vision URL and key if you use live photo assessment. Configure your webhook and confirm it receives alerts during a pilot scan.
5. Review spend caps, cash reserve, per-SKU limits, and the kill switch. Review real decisions in shadow and then in HITL before enabling live checkout. In HITL, the autopilot daemon can approve eligible orders under its autonomous policy.

## Guided setup and deployment

Open `guided_setup_wizard` in Muse and confirm the database you plan to use. Muse calls `get_setup_guide` and works through one step at a time using `currentStep`, its operator actions, questions, and verification checks. `update_setup_workflow` saves the selected profile, operator acknowledgements, and allowed skips in SQLite so the guide resumes across sessions. From the CLI, run `setup` for the checklist and current walkthrough or add `--json` for the full report.

```sh
npm run --silent setup -- --db data/arbitrage.sqlite
npm run --silent setup -- --db data/arbitrage.sqlite --json
npm run --silent expand-catalog -- --pack all_curated --db data/arbitrage.sqlite
npm run --silent reconcile-sales -- --mock --db :memory:
```

Choose `hitl_alerts` for alerts with operator-managed checkout, including while eBay Buy Order API approval is pending. Choose `live_auto_buy` for approved eBay checkout with operator-managed selling, or `live_closed_loop` to add eBay selling and paid-sale reconciliation. Changing profiles updates which steps are required. The operating mode is set separately after operator approval.

Load the starter or curated catalog, then use `import_sold_comps` on day one with verified CSV or JSON sales to avoid the three-day cold start. Run a small authorized market data sync and verify comp freshness with `check_readiness`. Confirm bankroll, spending caps, and cash reserve, and set `ARBITRAGE_SALES_TAX_RATE=0` where the operator confirms a state resale certificate applies. Agree on physical receiving, intake QC, and shipping or vault consignment.

Use `configure_settings` in Muse for approved settings and enter credentials privately. The tool preserves unrelated settings, masks secrets in results, and rebuilds the active runtime against the same SQLite connection. For seller rehearsal, use a dedicated `.env` and SQLite database with sandbox credentials and `EBAY_SELL_SANDBOX=true`. Production checkout requires approved eBay Order API access. [eBay consent and token exchange](https://developer.ebay.com/develop/guides/sell/authorization)

Call `discover_ebay_policies` before enabling `autoSave`. Review the shipping, payment, and return rules and verify the warehouse is enabled. Fulfillment reconciliation records each matching paid inventory sale once. Review the summary for skipped orders and provider errors. Call reconciliation with a date and a limit up to 200 if the default recent page needs narrowing. [eBay inventory locations](https://developer.ebay.com/api-docs/sell/static/inventory/managing-inventory-locations.html)

Review a shadow pass and confirm the kill switch is clear before requesting explicit approval for the target mode. Obtain separate approval before enabling automatic publication. Select exactly one continuous runner per database from the deployment options below. The dashboard reuses the database mode and leaves polling off by default. Keep its unauthenticated HTTP interface on a trusted local endpoint.

- **Docker Compose** Set up the host `.env`, create `./data` writable by the image's `node` user (UID 1000), and run `docker compose up -d --build`. Both services read the host `.env` at container creation and share `./data`. The dashboard is published on `127.0.0.1:3000`. Apply durable settings through the host file, then run `docker compose up -d --force-recreate`. MCP edits inside a dashboard container affect that process and its local file.
- **Linux systemd** Edit the unit for the installation directory, service account, and absolute Node 26 path. Give the service account access to `.env` and the database directory. Install the unit in `/etc/systemd/system` and run `systemctl enable --now pokemon-arbitrage`. Use `systemctl reload pokemon-arbitrage` after editing the host file. [service unit](deploy/pokemon-arbitrage.service)
- **macOS launchd** Edit the LaunchAgent for the checkout and absolute Node 26 path. Place it in `~/Library/LaunchAgents` and use `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pokemon-arbitrage.autopilot.plist`. Use `launchctl kill SIGHUP gui/$(id -u)/com.pokemon-arbitrage.autopilot` after editing the host file. [LaunchAgent plist](deploy/com.pokemon-arbitrage.autopilot.plist)
- **Scheduled Muse passes** Schedule `run_autopilot_pass` for the approved runtime. Use the schedule as the only polling runner for that database.
