import { parseArgs, selectChains } from "./cli";
import { config } from "./config";
import { type BalancerEvents, ChainBalancer } from "./core/balancer";
import type { WsSession } from "./core/ws-upstream";
import { ChainMetrics } from "./stats/stats";
import * as tui from "./tui/tui";

/** Per-client-WS proxy state stored on the Bun ServerWebSocket. */
interface WsProxyData {
  chain: string;
  /** Backing upstream session; set once openWsSession succeeds. */
  session: WsSession | null;
  /** Client frames received before the backing session was attached. */
  backlog: string[];
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

// CLI flags win over env/defaults. `--port` overrides the listen port and
// `--chain` narrows the served chains (repeatable / comma-separated).
const cli = parseArgs(Bun.argv.slice(2));
if (cli.port !== null) config.port = cli.port;
config.chains = selectChains(config.chains, cli.chains);

tui.registerChains(config.chains.map((c) => c.slug));

// Per-chain rolling metrics (rps, ok-rate, latency quantiles) for the TUI.
const metrics = new Map<string, ChainMetrics>(
  config.chains.map((c) => [c.slug, new ChainMetrics()]),
);

const events: BalancerEvents = {
  onRequest: (info) => {
    tui.logRequest(info);
    // Client-observed latency = every attempt the request burned through.
    const totalMs = info.attempts.reduce((sum, a) => sum + a.ms, 0);
    metrics.get(info.chain)?.record(info.status === 200, totalMs);
  },
  onBreakerChange: (chain, host, from, to, reason) => {
    tui.logBreaker(chain, host, from, to, reason);
  },
};

const balancers = new Map<string, ChainBalancer>(
  config.chains.map((chain) => [
    chain.slug,
    new ChainBalancer(chain, config.breaker, config.maxLagBlocks, events),
  ]),
);

function allStatuses(): tui.ChainStatus[] {
  return [...balancers.values()].map((b) => ({
    ...b.status(),
    metrics: metrics.get(b.cfg.slug)?.snapshot(),
  }));
}

function withCors(res: Response): Response {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.headers.set(key, value);
  }
  return res;
}

function json(body: unknown, status = 200): Response {
  return withCors(
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

async function runAllHealthChecks(): Promise<void> {
  await Promise.all([...balancers.values()].map((b) => b.runHealthChecks()));
}

// Warm upstream state on boot, then keep probing in the background.
void runAllHealthChecks().then(() => tui.renderStatus(allStatuses()));
setInterval(() => void runAllHealthChecks(), config.healthCheckIntervalMs);

// The pinned pane re-renders once per second (clock, uptime, rps, countdowns)
// regardless of traffic; in plain (non-TTY) mode this is skipped and the
// board is printed only after each health-check round instead.
function sampleErrRates(): void {
  for (const b of balancers.values()) b.sampleErrRates();
}

if (process.stdout.isTTY && !process.env.NO_TUI) {
  setInterval(() => {
    sampleErrRates();
    tui.renderStatus(allStatuses());
  }, 1_000);
} else {
  // Keep the error-rate sparkline moving at 1s even when the board only
  // prints once a minute in plain mode.
  setInterval(sampleErrRates, 1_000);
  setInterval(() => tui.renderStatus(allStatuses()), 60_000);
}

const server = startServer();

tui.start(allStatuses(), server.port ?? config.port, {
  onProbe: () => {
    void runAllHealthChecks().then(() => tui.renderStatus(allStatuses()));
  },
  onReset: () => {
    for (const b of balancers.values()) b.resetStats();
    for (const m of metrics.values()) m.reset();
    tui.renderStatus(allStatuses());
  },
});

/**
 * Start the listener, turning startup failures into a short, actionable message
 * instead of an unhandled exception (which, in the compiled binary, dumps the
 * whole minified bundle as a stack trace). The most common failure is the port
 * already being in use.
 */
function startServer() {
  try {
    return createServer();
  } catch (err) {
    const host = process.env.HOST ?? "0.0.0.0";
    const code = (err as { code?: string }).code;
    if (code === "EADDRINUSE") {
      process.stderr.write(
        `error: port ${config.port} is already in use on ${host}.\n` +
          `Pick another with --port <n> or the PORT env var, or stop the process using it:\n` +
          `  lsof -iTCP:${config.port} -sTCP:LISTEN -n -P\n`,
      );
    } else if (code === "EACCES") {
      process.stderr.write(
        `error: permission denied binding port ${config.port} on ${host} ` +
          `(ports below 1024 usually need elevated privileges).\n`,
      );
    } else {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error: failed to start server: ${message}\n`);
    }
    process.exit(1);
  }
}

function createServer() {
  return Bun.serve<WsProxyData>({
    port: config.port,
    // Bind IPv4 all-interfaces so both 127.0.0.1 and ::1 clients connect.
    hostname: process.env.HOST ?? "0.0.0.0",
    idleTimeout: 30,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      // WebSocket upgrade: ws(s)://host/<slug>. Handled before the OPTIONS/CORS
      // and method gates since upgrade requests are GETs with special headers.
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const balancer = balancers.get(path.slice(1));
        if (!balancer) {
          return json({ error: "unknown chain for WebSocket" }, 404);
        }
        if (!balancer.hasWs()) {
          return json(
            { error: `WebSocket not available for /${balancer.cfg.slug}` },
            400,
          );
        }
        const ok = srv.upgrade(req, {
          data: {
            chain: balancer.cfg.slug,
            session: null,
            backlog: [],
          },
        });
        if (ok) return undefined;
        return json({ error: "WebSocket upgrade failed" }, 500);
      }

      if (req.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }));
      }

      if (path === "/health") {
        return json({ ok: true });
      }

      if (path === "/status" || path === "/") {
        return json({ chains: allStatuses() });
      }

      const balancer = balancers.get(path.slice(1));
      if (!balancer) {
        return json(
          {
            error: "unknown chain",
            available: [...balancers.keys()].map((slug) => `/${slug}`),
          },
          404,
        );
      }

      if (req.method !== "POST") {
        return json({ error: "JSON-RPC requires POST" }, 405);
      }

      const bodyText = await req.text();
      if (!bodyText) {
        return json(
          { jsonrpc: "2.0", id: null, error: { code: -32700, message: "empty body" } },
          400,
        );
      }

      return withCors(await balancer.handle(bodyText));
    },
    websocket: {
      idleTimeout: 300,
      // Client WS opened: attach a backing upstream session and relay both ways.
      open(ws) {
        const balancer = balancers.get(ws.data.chain);
        if (!balancer) {
          ws.close(1011, "unknown chain");
          return;
        }
        const opened = balancer.openWsSession({
          onUpstreamMessage: (data) => {
            // Relay every upstream frame (RPC replies + subscription pushes).
            try {
              ws.send(data);
            } catch {
              // client gone; close() below handles teardown
            }
          },
          onUpstreamClose: (code, reason) => {
            // Bun rejects some reserved close codes (e.g. 1006); normalize to a
            // safe application code when relaying upstream closes to the client.
            const safe = code >= 3000 && code <= 4999 ? code : 1011;
            try {
              ws.close(safe, reason.slice(0, 123));
            } catch {
              // already closed
            }
          },
          onError: (message) => {
            tui.logBreaker(
              ws.data.chain,
              opened?.host ?? "ws",
              "closed",
              "open",
              message,
            );
          },
        });

        if (!opened) {
          ws.close(1013, "no ws upstream available");
          return;
        }
        ws.data.session = opened.session;
        // Flush any client frames that arrived before the session attached.
        for (const msg of ws.data.backlog) opened.session.send(msg);
        ws.data.backlog.length = 0;
      },
      // Client -> upstream. Queue until the backing session exists.
      message(ws, message) {
        const text =
          typeof message === "string" ? message : new TextDecoder().decode(message);
        const session = ws.data.session;
        if (session) {
          session.send(text);
        } else {
          ws.data.backlog.push(text);
        }
      },
      close(ws) {
        ws.data.session?.close();
        ws.data.session = null;
      },
    },
  });
}
