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
endpoints. Add, remove, or swap any of them in `src/config.ts`.

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
[Adding a chain](#adding-a-chain) to configure your own.

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

Thresholds are configurable (see [Breaker tuning](#breaker-tuning)).

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
| `NO_COLOR` | — | Disable ANSI colors |
| `FORCE_COLOR` | — | Force colors even without TTY |
| `NO_TUI` | — | Disable split-screen TUI, use plain logging |

### Adding a chain

Add an entry to `config.chains` in `src/config.ts`:

```ts
{
  name: "Arbitrum One",
  slug: "arb",           // -> POST /arb  and  wss://.../arb
  chainId: 42161,
  requestTimeoutMs: 5_000,
  maxAttempts: 4,
  upstreams: [
    "https://arb1.arbitrum.io/rpc",
    "https://arbitrum.drpc.org",
    // ...
  ],
  wsUpstreams: [           // optional; omit to disable WS for this chain
    "wss://arbitrum.drpc.org",
  ],
},
```

### Breaker tuning

In `src/config.ts`:

```ts
breaker: {
  failureThreshold: 3,    // consecutive failures to open
  cooldownMs: 30_000,     // open duration before half-open probe
  halfOpenMaxProbes: 1,   // concurrent probes in half-open state
},
```

`maxLagBlocks: 5` — upstreams more than 5 blocks behind the best head are deprioritized (not removed).

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
