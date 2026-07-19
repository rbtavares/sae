import { afterEach, describe, expect, test } from "bun:test";
import type { BreakerConfig } from "../../src/config";
import { WsSession, WsUpstream } from "../../src/core/ws-upstream";

const breakerCfg: BreakerConfig = {
  failureThreshold: 2,
  cooldownMs: 60_000,
  halfOpenMaxProbes: 1,
};

const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/**
 * A minimal JSON-RPC-over-WS echo/probe server. Answers eth_blockNumber with
 * `block`, and (when `pushSub` is set) emits an eth_subscription push after a
 * client eth_subscribe, letting us verify subscription frames relay through.
 */
function fakeWsRpc(opts: { block?: string; pushSub?: boolean } = {}): string {
  const block = opts.block ?? "0x64";
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("expected ws", { status: 426 });
    },
    websocket: {
      message(ws, msg) {
        const text = typeof msg === "string" ? msg : String(msg);
        const req = JSON.parse(text) as { id: unknown; method: string };
        if (req.method === "eth_blockNumber") {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: block }));
        } else if (req.method === "eth_subscribe") {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "0xsub" }));
          if (opts.pushSub) {
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "eth_subscription",
                params: { subscription: "0xsub", result: { number: block } },
              }),
            );
          }
        } else {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: null }));
        }
      },
    },
  });
  servers.push(server);
  return `ws://localhost:${server.port}`;
}

describe("WsUpstream.probe", () => {
  test("records head block, latency, and closes the breaker on success", async () => {
    const url = fakeWsRpc({ block: "0x100" });
    const u = new WsUpstream(url, breakerCfg);

    await u.probe(2_000);

    expect(u.lastBlock).toBe(256n);
    expect(u.latencyMs).toBeGreaterThan(0);
    expect(u.breaker.currentState).toBe("closed");
    expect(u.liveErrRate()).toBe(0);
  });

  test("scores a failure and opens the breaker when the endpoint is unreachable", async () => {
    // Nothing listening on this port.
    const u = new WsUpstream("ws://localhost:1", breakerCfg);

    await u.probe(1_000);
    await u.probe(1_000); // failureThreshold = 2 -> opens

    expect(u.totalFailures).toBeGreaterThanOrEqual(2);
    expect(u.breaker.currentState).toBe("open");
  });
});

describe("WsSession relay", () => {
  test("proxies requests and subscription pushes from upstream to caller", async () => {
    const url = fakeWsRpc({ pushSub: true });
    const received: string[] = [];

    const opened = Promise.withResolvers<void>();
    const session = new WsSession(url, {
      onUpstreamMessage: (data) => received.push(data),
      onUpstreamClose: () => {},
      onOpen: () => opened.resolve(),
    });
    session.connect();
    await opened.promise;

    session.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_subscribe",
        params: ["newHeads"],
      }),
    );

    // Wait for the subscribe reply + the push notification.
    await Bun.sleep(100);
    session.close();

    const parsed = received.map((r) => JSON.parse(r) as Record<string, unknown>);
    expect(parsed.some((m) => m.result === "0xsub")).toBe(true);
    expect(parsed.some((m) => m.method === "eth_subscription")).toBe(true);
  });

  test("queues client frames sent before the socket opens, then flushes", async () => {
    const url = fakeWsRpc({ block: "0xabc" });
    const received: string[] = [];
    const done = Promise.withResolvers<void>();

    const session = new WsSession(url, {
      onUpstreamMessage: (data) => {
        received.push(data);
        done.resolve();
      },
      onUpstreamClose: () => {},
    });
    // Send BEFORE connect resolves — must be buffered then flushed on open.
    session.connect();
    session.send(
      JSON.stringify({ jsonrpc: "2.0", id: 7, method: "eth_blockNumber", params: [] }),
    );

    await done.promise;
    session.close();

    const reply = JSON.parse(received[0]!) as { id: number; result: string };
    expect(reply.id).toBe(7);
    expect(reply.result).toBe("0xabc");
  });
});
