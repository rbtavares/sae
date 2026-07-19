import { afterEach, describe, expect, test, setSystemTime } from "bun:test";
import {
  PerSecondCounter,
  RollingLatency,
  RollingWindow,
  SampleRing,
  sparkline,
} from "../../src/stats/stats";

afterEach(() => setSystemTime());

describe("PerSecondCounter", () => {
  test("buckets hits per second and reports series oldest-first", () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const c = new PerSecondCounter();
    c.hit();
    c.hit();
    setSystemTime(new Date("2026-01-01T00:00:01Z"));
    c.hit();
    const s = c.series(3);
    expect(s).toEqual([0, 2, 1]);
  });

  test("rps averages complete seconds, excluding current partial", () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const c = new PerSecondCounter();
    for (let sec = 0; sec < 5; sec++) {
      setSystemTime(new Date(2026, 0, 1, 0, 0, sec));
      c.hit(10);
    }
    setSystemTime(new Date(2026, 0, 1, 0, 0, 5));
    expect(c.rps(5)).toBe(10);
  });

  test("stale buckets are zeroed after long gaps", () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const c = new PerSecondCounter();
    c.hit(42);
    setSystemTime(new Date("2026-01-01T00:05:00Z")); // 300s later
    expect(c.series(60).every((v) => v === 0)).toBe(true);
  });
});

describe("RollingWindow", () => {
  test("null before samples, tracks error rate", () => {
    const w = new RollingWindow(4);
    expect(w.errRate()).toBeNull();
    w.push(true);
    w.push(true);
    w.push(false);
    w.push(false);
    expect(w.errRate()).toBe(0.5);
  });

  test("old samples fall out of the window", () => {
    const w = new RollingWindow(2);
    w.push(false);
    w.push(true);
    w.push(true); // evicts the false
    expect(w.errRate()).toBe(0);
  });
});

describe("SampleRing", () => {
  test("right-aligns samples, padding the front with the empty value", () => {
    const r = new SampleRing(4);
    r.push(0.1);
    r.push(0.2);
    // Newest is last; unfilled slots pad the front so the graph grows leftward.
    expect(r.series()).toEqual([0, 0, 0.1, 0.2]);
    expect(r.count).toBe(2);
  });

  test("wraps and keeps the newest `size` samples oldest-first", () => {
    const r = new SampleRing(3);
    for (const v of [1, 2, 3, 4, 5]) r.push(v);
    expect(r.series()).toEqual([3, 4, 5]);
  });

  test("reset clears samples", () => {
    const r = new SampleRing(3);
    r.push(0.5);
    r.reset();
    expect(r.count).toBe(0);
    expect(r.series()).toEqual([0, 0, 0]);
  });
});

describe("RollingLatency", () => {
  test("quantiles from sorted samples", () => {
    const l = new RollingLatency(10);
    for (const v of [100, 200, 300, 400, 500]) l.push(v);
    expect(l.quantile(0.5)).toBe(300);
    expect(l.quantile(0.95)).toBe(500);
    expect(new RollingLatency(4).quantile(0.5)).toBeNull();
  });
});

describe("sparkline", () => {
  test("scales to max and renders zeros as lowest bar", () => {
    const s = sparkline([0, 1, 2, 4]);
    expect(s).toHaveLength(4);
    expect(s[0]).toBe("\u2581");
    expect(s[3]).toBe("\u2588");
  });
});
