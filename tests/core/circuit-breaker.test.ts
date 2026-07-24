import { CircuitBreaker } from "../../src/core/circuit-breaker.js";
import { afterEach, describe, expect, setSystemTime, test } from "../helpers.js";

const cfg = { failureThreshold: 3, cooldownMs: 30_000, halfOpenMaxProbes: 1 };

afterEach(() => setSystemTime());

describe("CircuitBreaker", () => {
  test("starts closed and admits requests", () => {
    const cb = new CircuitBreaker(cfg);
    expect(cb.currentState).toBe("closed");
    expect(cb.canRequest()).toBe(true);
  });

  test("opens after threshold consecutive failures", () => {
    const cb = new CircuitBreaker(cfg);
    cb.onFailure();
    cb.onFailure();
    expect(cb.currentState).toBe("closed");
    cb.onFailure();
    expect(cb.currentState).toBe("open");
    expect(cb.canRequest()).toBe(false);
  });

  test("success resets consecutive failure count", () => {
    const cb = new CircuitBreaker(cfg);
    cb.onFailure();
    cb.onFailure();
    cb.onSuccess();
    cb.onFailure();
    cb.onFailure();
    expect(cb.currentState).toBe("closed");
  });

  test("transitions open -> half-open after cooldown", () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const cb = new CircuitBreaker(cfg);
    for (let i = 0; i < 3; i++) cb.onFailure();
    expect(cb.currentState).toBe("open");

    setSystemTime(new Date("2026-01-01T00:00:31Z"));
    expect(cb.currentState).toBe("half-open");
    expect(cb.canRequest()).toBe(true);
  });

  test("half-open limits concurrent probes", () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const cb = new CircuitBreaker(cfg);
    for (let i = 0; i < 3; i++) cb.onFailure();
    setSystemTime(new Date("2026-01-01T00:00:31Z"));

    expect(cb.canRequest()).toBe(true);
    cb.onAttempt();
    expect(cb.canRequest()).toBe(false);
  });

  test("half-open failure re-opens immediately", () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const cb = new CircuitBreaker(cfg);
    for (let i = 0; i < 3; i++) cb.onFailure();
    setSystemTime(new Date("2026-01-01T00:00:31Z"));
    cb.onAttempt();
    cb.onFailure();
    expect(cb.currentState).toBe("open");
    expect(cb.canRequest()).toBe(false);
  });

  test("openRemainingMs counts down cooldown", () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const cb = new CircuitBreaker(cfg);
    expect(cb.openRemainingMs()).toBe(0);
    for (let i = 0; i < 3; i++) cb.onFailure();
    expect(cb.openRemainingMs()).toBe(30_000);
    setSystemTime(new Date("2026-01-01T00:00:12Z"));
    expect(cb.openRemainingMs()).toBe(18_000);
    setSystemTime(new Date("2026-01-01T00:00:31Z"));
    expect(cb.openRemainingMs()).toBe(0); // half-open now
  });

  test("half-open success closes", () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const cb = new CircuitBreaker(cfg);
    for (let i = 0; i < 3; i++) cb.onFailure();
    setSystemTime(new Date("2026-01-01T00:00:31Z"));
    cb.onAttempt();
    cb.onSuccess();
    expect(cb.currentState).toBe("closed");
  });
});
