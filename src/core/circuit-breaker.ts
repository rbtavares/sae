import type { BreakerConfig } from "../config.js";

export type BreakerState = "closed" | "open" | "half-open";

/**
 * Classic three-state circuit breaker.
 *
 * closed     -> normal traffic; consecutive failures >= threshold opens it.
 * open       -> all traffic rejected until cooldown elapses.
 * half-open  -> limited probe traffic; one success closes, one failure re-opens.
 */
export class CircuitBreaker {
  private state: BreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probesInFlight = 0;

  constructor(private readonly cfg: BreakerConfig) {}

  /** Current state, lazily transitioning open -> half-open after cooldown. */
  get currentState(): BreakerState {
    if (this.state === "open" && Date.now() - this.openedAt >= this.cfg.cooldownMs) {
      this.state = "half-open";
      this.probesInFlight = 0;
    }
    return this.state;
  }

  /** Milliseconds until an open circuit admits probes again (0 if not open). */
  openRemainingMs(): number {
    if (this.currentState !== "open") return 0;
    return Math.max(0, this.cfg.cooldownMs - (Date.now() - this.openedAt));
  }

  canRequest(): boolean {
    const state = this.currentState;
    if (state === "closed") return true;
    if (state === "half-open") return this.probesInFlight < this.cfg.halfOpenMaxProbes;
    return false;
  }

  onAttempt(): void {
    if (this.currentState === "half-open") this.probesInFlight += 1;
  }

  onSuccess(): void {
    this.consecutiveFailures = 0;
    this.probesInFlight = 0;
    this.state = "closed";
  }

  onFailure(): void {
    this.consecutiveFailures += 1;
    const state = this.currentState;
    if (state === "half-open" || this.consecutiveFailures >= this.cfg.failureThreshold) {
      this.state = "open";
      this.openedAt = Date.now();
      this.probesInFlight = 0;
    }
  }
}
