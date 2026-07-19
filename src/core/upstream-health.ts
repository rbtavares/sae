import type { BreakerConfig } from "../config";
import { RollingWindow, SampleRing } from "../stats/stats";
import { type BreakerState, CircuitBreaker } from "./circuit-breaker";

export type BreakerChangeListener = (
  host: string,
  from: BreakerState,
  to: BreakerState,
  reason?: string,
) => void;

/** Smoothing factor for the successful-latency EWMA. */
const EWMA_ALPHA = 0.3;

/**
 * The rolling error rate is outcome-windowed (last 50 calls), not time-windowed,
 * so an upstream whose breaker just opened would otherwise show its final 100%
 * error rate forever while receiving zero traffic. Past this idle threshold the
 * live rate is treated as stale ("no current data") — the ERR% cell dims and the
 * history sparkline records a gap that scrolls the failure burst off.
 */
const ERR_RATE_STALE_MS = 10_000;

/**
 * Shared health, latency, and circuit-breaker bookkeeping for a single upstream
 * endpoint, independent of transport. {@link Upstream} (HTTP) and
 * {@link WsUpstream} (WebSocket) extend this and add their own `call`/`probe`
 * logic, calling {@link recordSuccess} / {@link recordFailure} to score attempts.
 */
export abstract class UpstreamHealth {
  readonly url: string;
  readonly breaker: CircuitBreaker;

  /** Exponentially weighted moving average of successful call latency. */
  latencyMs = 0;
  /** Latest block height seen via health checks. 0n = unknown. */
  lastBlock = 0n;
  totalRequests = 0;
  totalFailures = 0;
  lastError: string | null = null;
  lastErrorAt = 0;
  /** Rolling outcome window (traffic + probes) for a live error rate. */
  readonly recent = new RollingWindow(50);
  /** Wall-clock of the last recorded outcome; drives error-rate staleness. */
  lastActivityAt = 0;
  /**
   * Per-second snapshots of the rolling error rate, for the ERR% sparkline.
   * Back-fills with 0 so the chart is always a full flat baseline line, never
   * blank; idle/stale seconds also record 0.
   */
  readonly errHistory = new SampleRing(20);

  constructor(
    url: string,
    breakerCfg: BreakerConfig,
    private readonly onBreakerChange?: BreakerChangeListener,
  ) {
    this.url = url;
    this.breaker = new CircuitBreaker(breakerCfg);
  }

  get host(): string {
    return new URL(this.url).host;
  }

  private notifyIfChanged(before: BreakerState, reason?: string): void {
    const after = this.breaker.currentState;
    if (before !== after) this.onBreakerChange?.(this.host, before, after, reason);
  }

  protected recordSuccess(latencyMs: number): void {
    this.latencyMs =
      this.latencyMs === 0
        ? latencyMs
        : EWMA_ALPHA * latencyMs + (1 - EWMA_ALPHA) * this.latencyMs;
    this.recent.push(true);
    this.lastActivityAt = Date.now();
    const before = this.breaker.currentState;
    this.breaker.onSuccess();
    this.notifyIfChanged(before, "recovered");
  }

  protected recordFailure(error: string): void {
    this.totalFailures += 1;
    this.lastError = error;
    this.lastErrorAt = Date.now();
    this.recent.push(false);
    this.lastActivityAt = Date.now();
    const before = this.breaker.currentState;
    this.breaker.onFailure();
    this.notifyIfChanged(before, error);
  }

  /**
   * Current error rate, or null when there is no *recent* signal: either no
   * calls have happened yet, or the last outcome is older than the staleness
   * threshold (e.g. the breaker opened and traffic stopped). Prevents a frozen
   * pre-open error rate from being reported as the live one.
   */
  liveErrRate(): number | null {
    if (this.lastActivityAt === 0) return null;
    if (Date.now() - this.lastActivityAt > ERR_RATE_STALE_MS) return null;
    return this.recent.errRate();
  }

  /**
   * Snapshot the live error rate into the history ring, once per second, for
   * the ERR% sparkline. A stale/no-data reading records as 0 (baseline line),
   * so an idle upstream reads as a flat line and any earlier failure burst
   * scrolls away instead of pinning the bar at 100% forever.
   */
  sampleErrRate(): void {
    this.errHistory.push(this.liveErrRate() ?? 0);
  }

  /** Zero the visible counters (breaker state is left untouched). */
  resetStats(): void {
    this.totalRequests = 0;
    this.totalFailures = 0;
    this.lastError = null;
    this.lastErrorAt = 0;
    this.recent.reset();
    this.errHistory.reset();
  }
}
