import type { BreakerConfig } from "../../src/config.js";
import { EVM_PROBE, SOLANA_HTTP_PROBE } from "../../src/core/probe.js";
import { Upstream } from "../../src/core/upstream.js";
import {
  afterEach,
  closeAllServers,
  describe,
  expect,
  fakeRpc,
  setSystemTime,
  test,
} from "../helpers.js";

const breakerCfg: BreakerConfig = {
  failureThreshold: 3,
  cooldownMs: 30_000,
  halfOpenMaxProbes: 1,
};

afterEach(() => setSystemTime());

/** Drive private outcome recording via the rolling window directly. */
function fail(u: Upstream): void {
  u.recent.push(false);
  u.lastActivityAt = Date.now();
}

describe("Upstream.liveErrRate", () => {
  test("null before any activity", () => {
    const u = new Upstream("https://x.test", breakerCfg);
    expect(u.liveErrRate()).toBeNull();
  });

  test("reports the rolling rate while traffic is recent", () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const u = new Upstream("https://x.test", breakerCfg);
    fail(u);
    fail(u);
    expect(u.liveErrRate()).toBe(1);
  });

  test("goes stale (null) once the last outcome ages past the threshold", () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const u = new Upstream("https://x.test", breakerCfg);
    fail(u); // 100% error rate, breaker-open scenario
    expect(u.liveErrRate()).toBe(1);

    // 11s later, no further traffic: the frozen 100% must not be reported live.
    setSystemTime(new Date("2026-01-01T00:00:11Z"));
    expect(u.liveErrRate()).toBeNull();
    // The underlying window is unchanged — only the *live* reading is gated.
    expect(u.recent.errRate()).toBe(1);
  });
});

describe("Upstream.sampleErrRate", () => {
  test("decays to a flat 0 line while idle so the burst scrolls off", () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const u = new Upstream("https://x.test", breakerCfg);
    fail(u);

    u.sampleErrRate();
    setSystemTime(new Date("2026-01-01T00:00:20Z")); // long idle after open
    for (let i = 0; i < 20; i++) u.sampleErrRate();

    const series = u.errHistory.series();
    // The single real 100% sample has scrolled out; all slots read as 0.
    expect(series.every((v) => v === 0)).toBe(true);
  });
});

describe("Upstream.probe", () => {
  afterEach(closeAllServers);

  /** Capture the probe body an upstream sends, answering with `result`. */
  function probeServer(result: unknown): { url: string; seen: { body?: string } } {
    const seen: { body?: string } = {};
    const url = fakeRpc(async (req) => {
      seen.body = await req.text();
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "healthcheck", result }), {
        headers: { "content-type": "application/json" },
      });
    });
    return { url, seen };
  }

  test("evm: asks eth_blockNumber and reads a hex head", async () => {
    const { url, seen } = probeServer("0x100");
    const u = new Upstream(url, breakerCfg, undefined, EVM_PROBE);

    await u.probe(2_000);

    expect(JSON.parse(seen.body!).method).toBe("eth_blockNumber");
    expect(u.lastBlock).toBe(256n);
  });

  test("evm is the default probe when none is supplied", async () => {
    const { url, seen } = probeServer("0x2a");
    await new Upstream(url, breakerCfg).probe(2_000);
    expect(JSON.parse(seen.body!).method).toBe("eth_blockNumber");
  });

  test("solana: asks getSlot at confirmed commitment and reads a decimal slot", async () => {
    const { url, seen } = probeServer(440_753_508);
    const u = new Upstream(url, breakerCfg, undefined, SOLANA_HTTP_PROBE);

    await u.probe(2_000);

    const sent = JSON.parse(seen.body!) as { method: string; params: unknown[] };
    expect(sent.method).toBe("getSlot");
    expect(sent.params).toEqual([{ commitment: "confirmed" }]);
    expect(u.lastBlock).toBe(440_753_508n);
    expect(u.breaker.currentState).toBe("closed");
  });

  test("leaves the head untouched when the probe result has the wrong shape", async () => {
    // A Solana node answering an EVM-shaped hex string, or vice versa.
    const { url } = probeServer("0x100");
    const u = new Upstream(url, breakerCfg, undefined, SOLANA_HTTP_PROBE);

    await u.probe(2_000);

    expect(u.lastBlock).toBe(0n);
    // Still a reachable endpoint: the round trip itself succeeded.
    expect(u.breaker.currentState).toBe("closed");
    expect(u.liveErrRate()).toBe(0);
  });
});

describe("Upstream.call retry classification", () => {
  afterEach(closeAllServers);

  /** Answer every call with a JSON-RPC error object, HTTP 200. */
  function rpcErrorServer(code: number, message = "boom"): string {
    return fakeRpc(
      () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message } }),
          { headers: { "content-type": "application/json" } },
        ),
    );
  }

  // Solana codes meaning "this node can't serve it, another might".
  for (const code of [-32004, -32005, -32011, -32016, -32019]) {
    test(`fails over on ${code}`, async () => {
      const u = new Upstream(rpcErrorServer(code), breakerCfg);
      const out = await u.call('{"jsonrpc":"2.0","id":1,"method":"getBlock"}', 2_000);
      expect(out.ok).toBe(false);
      expect(out.retryable).toBe(true);
    });
  }

  // Deterministic Solana outcomes: the analogue of `execution reverted`.
  // Retrying them elsewhere would waste attempts and return the same answer.
  for (const code of [-32002, -32007, -32009, -32015]) {
    test(`passes ${code} straight through without failing over`, async () => {
      const u = new Upstream(rpcErrorServer(code), breakerCfg);
      const out = await u.call('{"jsonrpc":"2.0","id":1,"method":"getBlock"}', 2_000);
      expect(out.ok).toBe(true);
      expect(out.retryable).toBe(false);
    });
  }
});
