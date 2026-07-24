import type { BreakerConfig, ChainConfig } from "../../src/config.js";
import { ChainBalancer } from "../../src/core/balancer.js";
import {
  afterEach,
  closeAllServers,
  describe,
  expect,
  fakeRpc,
  fakeWsRpc,
  sleep,
  test,
} from "../helpers.js";

const breakerCfg: BreakerConfig = {
  failureThreshold: 2,
  cooldownMs: 60_000,
  halfOpenMaxProbes: 1,
};

afterEach(async () => {
  await closeAllServers();
});

function makeBalancer(
  upstreams: string[],
  maxAttempts = upstreams.length,
  wsUpstreams?: string[],
) {
  const cfg: ChainConfig = {
    name: "Test",
    slug: "test",
    chainId: 1337,
    upstreams,
    wsUpstreams,
    requestTimeoutMs: 1_000,
    maxAttempts,
  };
  return new ChainBalancer(cfg, breakerCfg, 5);
}

const RPC_REQ = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "eth_blockNumber",
  params: [],
});

const ok = (result: string) => Response.json({ jsonrpc: "2.0", id: 1, result });

describe("ChainBalancer failover", () => {
  test("returns first healthy upstream response", async () => {
    const url = fakeRpc(() => ok("0x64"));
    const balancer = makeBalancer([url]);

    const res = await balancer.handle(RPC_REQ);
    const body = (await res.json()) as { result: string };
    expect(res.status).toBe(200);
    expect(body.result).toBe("0x64");
  });

  test("fails over when first upstream returns 500", async () => {
    let firstHits = 0;
    const bad = fakeRpc(() => {
      firstHits += 1;
      return new Response("boom", { status: 500 });
    });
    const good = fakeRpc(() => ok("0xaa"));
    const balancer = makeBalancer([bad, good]);

    const res = await balancer.handle(RPC_REQ);
    const body = (await res.json()) as { result: string };
    expect(res.status).toBe(200);
    expect(body.result).toBe("0xaa");
    expect(firstHits).toBe(1);
  });

  test("fails over on rate-limit JSON-RPC error", async () => {
    const limited = fakeRpc(() =>
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32005, message: "rate limit exceeded" },
      }),
    );
    const good = fakeRpc(() => ok("0xbb"));
    const balancer = makeBalancer([limited, good]);

    const res = await balancer.handle(RPC_REQ);
    const body = (await res.json()) as { result: string };
    expect(body.result).toBe("0xbb");
  });

  test("passes through legitimate RPC errors without failover", async () => {
    let goodHits = 0;
    const reverting = fakeRpc(() =>
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        error: { code: 3, message: "execution reverted" },
      }),
    );
    const good = fakeRpc(() => {
      goodHits += 1;
      return ok("0xcc");
    });
    const balancer = makeBalancer([reverting, good]);

    const res = await balancer.handle(RPC_REQ);
    const body = (await res.json()) as { error: { message: string } };
    expect(res.status).toBe(200);
    expect(body.error.message).toBe("execution reverted");
    expect(goodHits).toBe(0);
  });

  test("opens breaker after repeated failures and stops sending traffic", async () => {
    let hits = 0;
    const bad = fakeRpc(() => {
      hits += 1;
      return new Response("down", { status: 503 });
    });
    const balancer = makeBalancer([bad]);

    await balancer.handle(RPC_REQ); // failure 1
    await balancer.handle(RPC_REQ); // failure 2 -> opens
    expect(hits).toBe(2);

    const res = await balancer.handle(RPC_REQ); // circuit open, no upstream hit
    expect(hits).toBe(2);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("circuits open");
  });

  test("returns 502 JSON-RPC error when all attempts fail", async () => {
    const bad1 = fakeRpc(() => new Response("x", { status: 500 }));
    const bad2 = fakeRpc(() => new Response("y", { status: 502 }));
    const balancer = makeBalancer([bad1, bad2]);

    const res = await balancer.handle(RPC_REQ);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { id: number; error: { code: number } };
    expect(body.id).toBe(1);
    expect(body.error.code).toBe(-32603);
  });

  test("batch requests are proxied without rpc-error inspection", async () => {
    const url = fakeRpc(() =>
      Response.json([
        { jsonrpc: "2.0", id: 1, result: "0x1" },
        { jsonrpc: "2.0", id: 2, error: { code: -32005, message: "rate limit" } },
      ]),
    );
    const balancer = makeBalancer([url]);

    const res = await balancer.handle(
      JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
        { jsonrpc: "2.0", id: 2, method: "eth_chainId", params: [] },
      ]),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(2);
  });

  test("health probe records head block and lagging node deprioritized", async () => {
    const ahead = fakeRpc(() => ok("0x100"));
    const behind = fakeRpc(() => ok("0x10"));
    const balancer = makeBalancer([behind, ahead]);

    await balancer.runHealthChecks();
    const status = balancer.status();
    expect(status.bestKnownBlock).toBe("256");
    const behindStatus = status.upstreams.find((u) => u.url === behind);
    expect(behindStatus?.lagging).toBe(true);
  });
});

describe("ChainBalancer WebSocket routing", () => {
  test("hasWs reflects whether ws upstreams are configured", () => {
    expect(makeBalancer([fakeRpc(() => ok("0x1"))]).hasWs()).toBe(false);
    const ws = fakeWsRpc("0x1");
    expect(makeBalancer([fakeRpc(() => ok("0x1"))], 1, [ws]).hasWs()).toBe(true);
  });

  test("health checks probe ws upstreams and surface them in status", async () => {
    const http = fakeRpc(() => ok("0x1"));
    const ws = fakeWsRpc("0x100");
    const balancer = makeBalancer([http], 1, [ws]);

    await balancer.runHealthChecks();
    const status = balancer.status();
    expect(status.wsUpstreams).toHaveLength(1);
    expect(status.wsUpstreams![0]!.lastBlock).toBe("256");
    expect(status.wsUpstreams![0]!.rank).toBe(1);
  });

  test("openWsSession relays upstream frames to the client hooks", async () => {
    const ws = fakeWsRpc("0xdead");
    const balancer = makeBalancer([fakeRpc(() => ok("0x1"))], 1, [ws]);

    const received: string[] = [];
    const opened = Promise.withResolvers<void>();
    const result = balancer.openWsSession({
      onUpstreamMessage: (d) => received.push(d),
      onUpstreamClose: () => {},
      onOpen: () => opened.resolve(),
    });
    expect(result).not.toBeNull();
    await opened.promise;

    result!.session.send(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    );
    await sleep(80);
    result!.session.close();

    const reply = JSON.parse(received[0]!) as { result: string };
    expect(reply.result).toBe("0xdead");
  });

  test("openWsSession returns null when no ws upstream is admissible", () => {
    const balancer = makeBalancer([fakeRpc(() => ok("0x1"))], 1);
    const result = balancer.openWsSession({
      onUpstreamMessage: () => {},
      onUpstreamClose: () => {},
    });
    expect(result).toBeNull();
  });
});
