<p align="center">
  <img src="header.png" alt="sae — open-source self-hosted evm rpc load balancer" width="100%">
</p>

Self-hosted EVM RPC load balancer that pools upstream endpoints per chain behind a single stable local URL, spreading traffic across all of them with automatic failover, per-upstream circuit breaking, block-lag awareness, and latency-aware routing.

## Features

- **HTTP + WebSocket** JSON-RPC proxy per chain
- **Automatic failover** — sequential retry across ranked upstreams per request
- **Circuit breaker** — three-state breaker per upstream, isolates dead endpoints
- **Latency-aware routing** — EWMA-ranked, lagging upstreams deprioritized
- **Block-lag detection** — upstreams behind the best-known head are down-ranked
- **Live TUI dashboard** — per-chain and per-upstream metrics, sparklines, logs
- **13 chains, 169 HTTP + 27 WS upstreams** preconfigured out of the box

## Quick start

Requires [Bun](https://bun.sh).

```bash
bun install
bun run start              # start sae on http://0.0.0.0:8545
```

Then point any EVM client at a chain slug:

```bash
curl -X POST http://localhost:8545/eth \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

Use `http://localhost:8545/<slug>` as the RPC URL in your wallet, framework, or
scripts — e.g. `/eth` for Ethereum, `/arb` for Arbitrum. See
[Chains](#chains) for the full list.

## Building

Compile a self-contained, dependency-free binary — no Bun needed at runtime:

```bash
bun run build              # host platform -> dist/sae
./dist/sae                 # run it
```

Cross-compile for all supported platforms (darwin/linux, arm64/x64):

```bash
bun run build:all          # -> dist/sae-<os>-<arch>
```

Ship the single binary file and run it directly.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/<slug>` | Proxy JSON-RPC to a chain (e.g. `/eth`, `/arb`) |
| `WS`   | `/<slug>` | WebSocket JSON-RPC proxy (chains with WS upstreams) |
| `GET`  | `/status` | Full status JSON: all chains, upstreams, metrics |
| `GET`  | `/health` | `{ "ok": true }` |
| `GET`  | `/` | Same as `/status` |

Unknown slug → `404` with the list of available chains. Non-`POST` to a chain slug → `405`. `OPTIONS` preflight and CORS headers are handled automatically.

WebSocket upgrades are accepted on the same `/<slug>` path and proxied sticky to the best-ranked WS upstream, relaying both RPC replies and subscription pushes. A chain with no WS upstreams rejects the upgrade with `400`.

## Chains

sae works with **any EVM chain** — there's nothing chain-specific in the proxy.
A chain is just a config entry: a slug, a chain ID, and a list of upstream RPC
endpoints. Add, remove, or swap any of them in a [config file](#config-file).

The following ship preconfigured out of the box, each with a curated set of free
public RPCs:

| Chain | Slug | Chain ID | HTTP upstreams | WS upstreams |
|-------|------|---------:|---------------:|-------------:|
| Ethereum Mainnet | `eth` | 1 | 34 | 3 |
| BNB Smart Chain | `bnb` | 56 | 31 | 2 |
| Base | `base` | 8453 | 17 | 3 |
| Arbitrum One | `arb` | 42161 | 14 | 2 |
| Polygon | `polygon` | 137 | 14 | 2 |
| Monad | `monad` | 143 | 13 | 2 |
| OP Mainnet | `op` | 10 | 12 | 3 |
| Gnosis Chain | `gnosis` | 100 | 10 | 3 |
| HyperEVM | `hyperevm` | 999 | 9 | 1 |
| Berachain | `berachain` | 80094 | 5 | 3 |
| Plasma | `plasma` | 9745 | 5 | 1 |
| MegaETH | `megaeth` | 4326 | 4 | 2 |
| Robinhood Chain | `robinhood` | 4663 | 1 | 0 |

13 chains, 169 HTTP and 27 WebSocket upstreams out of the box. See
the [Config file](#config-file) to configure your own.

## How it works

### Upstream ranking

Each incoming request tries upstreams in order of preference:

1. **In-sync** before **lagging** (more than `maxLagBlocks` behind best-known head)
2. **Closed** breaker before **half-open**
3. Lowest EWMA latency first

Sequential failover up to the chain's `maxAttempts` per request. Stops early on non-retryable errors (e.g. `execution reverted`) — those pass through to the caller untouched.

### Circuit breaker

Classic three-state breaker per upstream:

```
closed ──(3 consecutive failures)──► open ──(30s cooldown)──► half-open
   ▲                                                             │
   └──────────────(1 success)────────────────────────────────────┘
   open ◄──────────(1 failure)───────────────────────────────────┘
```

- **Closed**: normal traffic
- **Open**: all requests rejected, upstream gets rest
- **Half-open**: 1 probe allowed; success closes, failure re-opens

Thresholds are configurable (see [Config file](#config-file)).

### Health probes

Every 30s (configurable), all admissible upstreams get an `eth_blockNumber` call. Updates:

- Head block per upstream (used for lag detection)
- Breaker state (probe success/failure counts)
- EWMA latency

### Retryable vs pass-through errors

Failover triggers on:
- Network errors (timeout, connection refused, DNS failure)
- HTTP 429, 403, 404, 5xx
- JSON-RPC error codes `-32005`, `-32016`, `-32042`, `-32603`
- Rate-limit-like messages in RPC error text

Everything else (revert errors, invalid params, etc.) returns directly to the caller — no point hammering other upstreams with the same bad request.

Batch JSON-RPC requests are proxied as-is without per-item error inspection.

## Configuration

### CLI flags

Flags override environment variables and defaults.

| Flag | Description |
|------|-------------|
| `-p, --port <number>` | Listen port (overrides `PORT`) |
| `-c, --chain <slug>` | Serve only this chain; repeatable or comma-separated (e.g. `-c eth -c arb` or `-c eth,arb`) |
| `--config <path>` | Path to a user config JSON file (overrides `SAE_CONFIG` and `config.json`) |
| `-h, --help` | Show usage |

```bash
./dist/sae --port 9000 --chain eth --chain arb      # production binary
bun dev -- -p 9000 -c eth,arb                        # development
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8545` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `HEALTH_CHECK_INTERVAL_MS` | `30000` | Health probe interval |
| `SAE_CONFIG` | — | Path to the user config file (see [Config file](#config-file)) |
| `NO_COLOR` | — | Disable ANSI colors |
| `FORCE_COLOR` | — | Force colors even without TTY |
| `NO_TUI` | — | Disable split-screen TUI, use plain logging |

### Config file

Config is plain JSON, loaded at **runtime** — so you tune the compiled binary
without rebuilding. Two files, resolved next to the binary (or the project root
when run from source):

- **`default.config.json`** — ships with the repo and the binary. The complete
  baseline: port, breaker, and all chains. Every field is required here.
- **`config.json`** — your override. **Gitignored**, so it never conflicts with
  updates. Create it to change any subset of the defaults; anything you omit
  falls back to `default.config.json`.

On startup sae reads `default.config.json`, overlays `config.json` (if present),
then applies `PORT` / `HEALTH_CHECK_INTERVAL_MS` env overrides and finally the
CLI flags. A malformed file is a fatal startup error with a clear message (no
requests are served).

Resolution of the user override, in order:

1. `--config <path>` flag
2. `SAE_CONFIG` environment variable
3. `config.json` beside the binary / in the project root

To customize, copy `default.config.json` to `config.json` and edit — or write a
minimal `config.json` with just the fields you want to change:

```json
{
  "port": 8545,
  "maxLagBlocks": 5,
  "breaker": {
    "failureThreshold": 3,
    "cooldownMs": 30000,
    "halfOpenMaxProbes": 1
  },
  "chains": [
    {
      "name": "Arbitrum One",
      "slug": "arb",
      "chainId": 42161,
      "requestTimeoutMs": 5000,
      "maxAttempts": 4,
      "upstreams": [
        "https://arb1.arbitrum.io/rpc",
        "https://arbitrum.drpc.org"
      ],
      "wsUpstreams": [
        "wss://arbitrum.drpc.org"
      ]
    }
  ]
}
```

Field notes: `slug` maps to `POST /arb` and `wss://.../arb` (lowercase letters,
digits, hyphens); `wsUpstreams` is optional (omit to disable WS for that chain);
`maxLagBlocks` deprioritizes (does not remove) upstreams more than N blocks
behind the best-known head. Providing `chains` replaces the list **wholesale**
(not merged per-chain), so include every chain you want served.

#### Validation

Config is validated on two levels:

- **Editor (before running).** `sae.schema.json` is a JSON Schema shipped with
  the repo and binary. Referencing it via `"$schema": "./sae.schema.json"` (as
  `default.config.json` does) gives autocomplete and inline error squiggles in
  VS Code and most editors.
- **Startup (before serving).** Every value is checked at load time and a bad
  config is a **fatal error** — the server refuses to start rather than serve a
  half-broken setup. Checks include: `port` in `1..65535`; all durations and
  counts are positive integers; `chainId` a positive integer; `upstreams` valid
  `http(s)` URLs and `wsUpstreams` valid `ws(s)` URLs; `slug` matches
  `[a-z0-9-]` and is unique. **Unknown keys are rejected**, so a typo like
  `maxAttempt` or `chian` fails loudly instead of being silently dropped.

The `ChainConfig` / `BreakerConfig` / `AppConfig` types live in `src/config.ts`.

## Developing

```bash
bun install
bun run start              # run once from source
bun dev                    # watch mode, restarts on file changes
```

Before committing:

```bash
bun run typecheck          # tsgo --noEmit
bun run lint               # oxlint
bun run format             # oxfmt (or format:check to verify only)
bun test                   # run the test suite
```

Tests cover the circuit breaker state machine, balancer failover logic,
WebSocket upstream handling, rolling stats, and sparkline rendering, using real
local Bun HTTP/WS servers as fake upstreams — no mocks.

## License

[MIT](LICENSE) © Lighthouse.one
