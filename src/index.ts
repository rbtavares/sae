import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket as WsClient } from "ws";
import { parseArgs, selectChains } from "./cli.js";
import { ConfigError, loadConfig } from "./config.js";
import { type BalancerEvents, ChainBalancer } from "./core/balancer.js";
import type { WsSession } from "./core/ws-upstream.js";
import { ChainMetrics } from "./stats/stats.js";
import * as tui from "./tui/tui.js";

/** Per-client-WS proxy state tracked for each accepted client socket. */
interface WsProxyState {
  chain: string;
  /** Backing upstream session; set once openWsSession succeeds. */
  session: WsSession | null;
  /** Client frames received before the backing session was attached. */
  backlog: string[];
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

// CLI flags win over env/defaults. `--port` overrides the listen port and
// `--chain` narrows the served chains (repeatable / comma-separated).
const cli = parseArgs(process.argv.slice(2));

// Load config from the external JSON file (if any), then apply CLI overrides.
// A malformed file is a fatal, clearly-reported startup error.
const config = await loadConfig(cli.configPath).catch((err: unknown) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`error: ${err.message}\n`);
  } else {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: failed to load config: ${message}\n`);
  }
  process.exit(1);
});

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

/** Read a Node request body to a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Relay a WHATWG `Response` (as produced by the balancer) to a Node response. */
async function sendResponse(res: ServerResponse, out: Response): Promise<void> {
  const headers: Record<string, string> = {};
  out.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = await out.text();
  res.writeHead(out.status, headers);
  res.end(body);
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

// Only enter the TUI once the listener is actually bound. Otherwise a failed
// bind (e.g. EADDRINUSE) would first paint a full-screen frame and then exit,
// leaving a stray board in the terminal scrollback above the error message.
startServer(() => {
  tui.start(allStatuses(), config.port, {
    onProbe: () => {
      void runAllHealthChecks().then(() => tui.renderStatus(allStatuses()));
    },
    onReset: () => {
      for (const b of balancers.values()) b.resetStats();
      for (const m of metrics.values()) m.reset();
      tui.renderStatus(allStatuses());
    },
  });
});

/** Normalize a request path: strip trailing slashes, default to "/". */
function normalizePath(rawUrl: string): string {
  const path = new URL(rawUrl, "http://localhost").pathname.replace(/\/+$/, "");
  return path || "/";
}

/**
 * Start the HTTP + WebSocket listener, turning startup failures into a short,
 * actionable message instead of an unhandled exception. The most common failure
 * is the port already being in use.
 */
function startServer(onListening: () => void) {
  const host = process.env.HOST ?? "0.0.0.0";
  const wss = new WebSocketServer({ noServer: true });

  const httpServer = createHttpServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json", ...CORS_HEADERS });
      }
      res.end(JSON.stringify({ error: "internal error", message }));
    });
  });

  // WebSocket upgrade: ws(s)://host/<slug>. Rejected here (before the handshake)
  // for unknown chains or chains without WS upstreams.
  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = normalizePath(req.url ?? "/");
    const balancer = balancers.get(path.slice(1));
    if (!balancer || !balancer.hasWs()) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachWsProxy(ws, balancer.cfg.slug);
    });
  });

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(
        `error: port ${config.port} is already in use on ${host}.\n` +
          `Pick another with --port <n> or the PORT env var, or stop the process using it:\n` +
          `  lsof -iTCP:${config.port} -sTCP:LISTEN -n -P\n`,
      );
    } else if (err.code === "EACCES") {
      process.stderr.write(
        `error: permission denied binding port ${config.port} on ${host} ` +
          `(ports below 1024 usually need elevated privileges).\n`,
      );
    } else {
      process.stderr.write(`error: failed to start server: ${err.message}\n`);
    }
    process.exit(1);
  });

  httpServer.listen(config.port, host, onListening);
  return httpServer;
}

/** Route and answer a single HTTP request. */
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = normalizePath(req.url ?? "/");

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (path === "/health") {
    return sendResponse(res, json({ ok: true }));
  }

  if (path === "/status" || path === "/") {
    return sendResponse(res, json({ chains: allStatuses() }));
  }

  const balancer = balancers.get(path.slice(1));
  if (!balancer) {
    return sendResponse(
      res,
      json(
        {
          error: "unknown chain",
          available: [...balancers.keys()].map((slug) => `/${slug}`),
        },
        404,
      ),
    );
  }

  if (req.method !== "POST") {
    return sendResponse(res, json({ error: "JSON-RPC requires POST" }, 405));
  }

  const bodyText = await readBody(req);
  if (!bodyText) {
    return sendResponse(
      res,
      json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "empty body" } },
        400,
      ),
    );
  }

  return sendResponse(res, withCors(await balancer.handle(bodyText)));
}

/**
 * Wire an accepted client WebSocket to a backing upstream session and relay
 * frames both ways. Mirrors the old Bun `websocket` handlers.
 */
function attachWsProxy(ws: WsClient, chain: string): void {
  const state: WsProxyState = { chain, session: null, backlog: [] };
  const balancer = balancers.get(chain);
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
        // client gone; close handler below tears down
      }
    },
    onUpstreamClose: (code, reason) => {
      // Reserved close codes (e.g. 1006) can't be sent; normalize to a safe
      // application code when relaying upstream closes to the client.
      const safe = code >= 3000 && code <= 4999 ? code : 1011;
      try {
        ws.close(safe, reason.slice(0, 123));
      } catch {
        // already closed
      }
    },
    onError: (message) => {
      tui.logBreaker(chain, opened?.host ?? "ws", "closed", "open", message);
    },
  });

  if (!opened) {
    ws.close(1013, "no ws upstream available");
    return;
  }
  state.session = opened.session;

  // Client -> upstream. Queue until the backing session exists.
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    const text = isBinary ? data.toString("utf8") : data.toString();
    if (state.session) {
      state.session.send(text);
    } else {
      state.backlog.push(text);
    }
  });
  ws.on("close", () => {
    state.session?.close();
    state.session = null;
  });

  // Flush any client frames that arrived before the session attached.
  for (const msg of state.backlog) opened.session.send(msg);
  state.backlog.length = 0;
}
