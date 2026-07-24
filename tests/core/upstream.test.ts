import type { BreakerConfig } from "../../src/config.js";
import { Upstream } from "../../src/core/upstream.js";
import { afterEach, describe, expect, setSystemTime, test } from "../helpers.js";

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
