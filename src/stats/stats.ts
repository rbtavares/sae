/** Lightweight rolling metrics used by the TUI. Zero dependencies. */

/** Per-second hit counter over a fixed ring, for RPS + sparklines + graphs. */
export class PerSecondCounter {
  /** Ring length in seconds. Sized so the graphs (2 samples per char) can fill
   *  a wide box with single-dot-column resolution. */
  static readonly SIZE = 120;
  private readonly buckets = new Uint32Array(PerSecondCounter.SIZE);
  private lastSec = Math.floor(Date.now() / 1000);

  /** Zero out buckets for seconds that elapsed since the last touch. */
  private advance(nowSec: number): void {
    const size = PerSecondCounter.SIZE;
    const gap = nowSec - this.lastSec;
    if (gap <= 0) return;
    const steps = Math.min(gap, size);
    for (let i = 1; i <= steps; i++) {
      this.buckets[(this.lastSec + i) % size] = 0;
    }
    this.lastSec = nowSec;
  }

  hit(count = 1): void {
    const nowSec = Math.floor(Date.now() / 1000);
    this.advance(nowSec);
    this.buckets[nowSec % PerSecondCounter.SIZE]! += count;
  }

  /** Counts for the last `n` seconds, oldest first (current second last). */
  series(n = 30): number[] {
    const size = PerSecondCounter.SIZE;
    const nowSec = Math.floor(Date.now() / 1000);
    this.advance(nowSec);
    const out: number[] = [];
    for (let i = n - 1; i >= 0; i--) {
      out.push(this.buckets[(((nowSec - i) % size) + size) % size]!);
    }
    return out;
  }

  /** Average requests/second over the trailing `window` complete seconds. */
  rps(window = 5): number {
    const s = this.series(window + 1);
    // Drop the current (partial) second for a stable reading.
    const complete = s.slice(0, -1);
    const sum = complete.reduce((a, b) => a + b, 0);
    return sum / window;
  }

  reset(): void {
    this.buckets.fill(0);
  }
}

/** Fixed-size ring of boolean outcomes -> rolling error rate. */
export class RollingWindow {
  private readonly ring: Uint8Array;
  private idx = 0;
  private filled = 0;

  constructor(size = 50) {
    this.ring = new Uint8Array(size);
  }

  push(ok: boolean): void {
    this.ring[this.idx] = ok ? 1 : 0;
    this.idx = (this.idx + 1) % this.ring.length;
    if (this.filled < this.ring.length) this.filled += 1;
  }

  get count(): number {
    return this.filled;
  }

  /** Error rate in [0,1], or null when no samples. */
  errRate(): number | null {
    if (this.filled === 0) return null;
    let okCount = 0;
    for (let i = 0; i < this.filled; i++) okCount += this.ring[i]!;
    return 1 - okCount / this.filled;
  }

  reset(): void {
    this.idx = 0;
    this.filled = 0;
  }
}

/**
 * Fixed-size ring of numeric samples for time-series sparklines
 * (e.g. periodic error-rate snapshots). Newest value is pushed last;
 * `series` returns oldest-first, back-filling not-yet-written slots with
 * `emptyValue` (0 by default; NaN to mark them as gaps in a sparkline).
 */
export class SampleRing {
  private readonly ring: Float64Array;
  private idx = 0;
  private filled = 0;

  constructor(
    size = 20,
    private readonly emptyValue = 0,
  ) {
    this.ring = new Float64Array(size);
  }

  push(value: number): void {
    this.ring[this.idx] = value;
    this.idx = (this.idx + 1) % this.ring.length;
    if (this.filled < this.ring.length) this.filled += 1;
  }

  /**
   * Values oldest-first, right-aligned: the newest sample is always the last
   * element and not-yet-written slots pad the *front* with `emptyValue`. This
   * makes a sparkline grow leftward from the right edge instead of filling in
   * from the left.
   */
  series(): number[] {
    const out: number[] = [];
    const size = this.ring.length;
    const empty = size - this.filled;
    // Oldest real sample sits `filled` steps behind the write cursor.
    const start = (this.idx - this.filled + size) % size;
    for (let i = 0; i < size; i++) {
      out.push(i < empty ? this.emptyValue : this.ring[(start + (i - empty)) % size]!);
    }
    return out;
  }

  get count(): number {
    return this.filled;
  }

  reset(): void {
    this.idx = 0;
    this.filled = 0;
    this.ring.fill(0);
  }
}

/** Fixed-size ring of latency samples -> approximate quantiles. */
export class RollingLatency {
  private readonly ring: Float64Array;
  private idx = 0;
  private filled = 0;

  constructor(size = 200) {
    this.ring = new Float64Array(size);
  }

  push(ms: number): void {
    this.ring[this.idx] = ms;
    this.idx = (this.idx + 1) % this.ring.length;
    if (this.filled < this.ring.length) this.filled += 1;
  }

  /** p in (0,1]; returns null when no samples. */
  quantile(p: number): number | null {
    if (this.filled === 0) return null;
    const sorted = Array.from(this.ring.subarray(0, this.filled)).sort((a, b) => a - b);
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[i]!;
  }

  reset(): void {
    this.idx = 0;
    this.filled = 0;
  }
}

/** Everything the TUI shows per chain, bundled. */
export class ChainMetrics {
  readonly counter = new PerSecondCounter();
  /** Failed (non-200 end-to-end) requests per second, for the error graph. */
  readonly errCounter = new PerSecondCounter();
  readonly outcomes = new RollingWindow(100);
  readonly latency = new RollingLatency(200);
  /** Lifetime count of requests handled (cleared by reset). */
  private total = 0;

  record(ok: boolean, totalMs: number): void {
    this.counter.hit();
    if (!ok) this.errCounter.hit();
    this.outcomes.push(ok);
    this.latency.push(totalMs);
    this.total += 1;
  }

  snapshot(): ChainMetricsSnapshot {
    // Per-second history for the graphs, oldest first. Request the full ring
    // and drop the current (partial) second; requesting exactly SIZE avoids any
    // ring wrap-around that would alias the current bucket back in as a ghost
    // spike on the left edge.
    const SIZE = PerSecondCounter.SIZE;
    const reqSeries = this.counter.series(SIZE).slice(0, -1);
    const errSeries = this.errCounter.series(SIZE).slice(0, -1);
    // End-to-end error fraction per second: failures / requests (0 when idle).
    const errRateSeries = reqSeries.map((n, i) => (n > 0 ? (errSeries[i] ?? 0) / n : 0));
    return {
      rps: this.counter.rps(),
      spark: this.counter.series(20),
      rpsSeries: reqSeries,
      errRateSeries,
      okRate: this.outcomes.errRate() === null ? null : 1 - this.outcomes.errRate()!,
      p50: this.latency.quantile(0.5),
      p95: this.latency.quantile(0.95),
      total: this.total,
    };
  }

  reset(): void {
    this.counter.reset();
    this.errCounter.reset();
    this.outcomes.reset();
    this.latency.reset();
    this.total = 0;
  }
}

export interface ChainMetricsSnapshot {
  rps: number;
  spark: number[];
  /** Per-second request counts, last 60 complete seconds, oldest first. */
  rpsSeries: number[];
  /** Per-second end-to-end error fraction (0..1), last 60s, oldest first. */
  errRateSeries: number[];
  okRate: number | null;
  p50: number | null;
  p95: number | null;
  /** Lifetime requests handled for this chain. */
  total: number;
}

const SPARK_CHARS = [
  "\u2581",
  "\u2582",
  "\u2583",
  "\u2584",
  "\u2585",
  "\u2586",
  "\u2587",
  "\u2588",
];

/** Unicode sparkline; zeros render as the lowest bar. */
export function sparkline(values: number[]): string {
  const max = Math.max(...values, 1);
  return values.map((v) => SPARK_CHARS[Math.min(7, Math.ceil((v / max) * 7))]!).join("");
}
