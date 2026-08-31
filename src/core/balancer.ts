import type { BreakerConfig, ChainConfig } from "../config.js";
import type { BreakerState } from "./circuit-breaker.js";
import { httpProbeFor, wsProbeFor } from "./probe.js";
import { type CallOutcome, Upstream } from "./upstream.js";
import type { UpstreamHealth } from "./upstream-health.js";
import { WsSession, WsUpstream } from "./ws-upstream.js";

const JSON_HEADERS = { "content-type": "application/json" };

export interface RequestAttempt {
  host: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface BalancerEvents {
  onRequest?: (info: {
    chain: string;
    method: string;
    attempts: RequestAttempt[];
    status: number;
  }) => void;
  onBreakerChange?: (
    chain: string,
    host: string,
    from: BreakerState,
    to: BreakerState,
    reason?: string,
  ) => void;
}

interface RequestMeta {
  id: string | number | null;
  method: string;
}

function parseRequestMeta(bodyText: string): RequestMeta {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (Array.isArray(parsed)) {
      return { id: null, method: `batch[${parsed.length}]` };
    }
    if (parsed && typeof parsed === "object") {
      const { id, method } = parsed as { id?: string | number | null; method?: string };
      return {
        id: id ?? null,
        method: typeof method === "string" ? method : "?",
      };
    }
  } catch {
    // fall through
  }
  return { id: null, method: "?" };
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  httpStatus: number,
): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status: httpStatus,
    headers: JSON_HEADERS,
  });
}

export class ChainBalancer {
  readonly cfg: ChainConfig;
  readonly upstreams: Upstream[];
  readonly wsUpstreams: WsUpstream[];
  private readonly maxLagBlocks: bigint;

  constructor(
    cfg: ChainConfig,
    breakerCfg: BreakerConfig,
    maxLagBlocks: number,
    private readonly events: BalancerEvents = {},
  ) {
    this.cfg = cfg;
    // A chain-level threshold wins over the global one: block times differ by
    // orders of magnitude across chains.
    this.maxLagBlocks = BigInt(cfg.maxLagBlocks ?? maxLagBlocks);
    const httpProbe = httpProbeFor(cfg.family);
    const wsProbe = wsProbeFor(cfg.family);
    this.upstreams = cfg.upstreams.map(
      (url) =>
        new Upstream(
          url,
          breakerCfg,
          (host, from, to, reason) =>
            this.events.onBreakerChange?.(cfg.slug, host, from, to, reason),
          httpProbe,
        ),
    );
    this.wsUpstreams = (cfg.wsUpstreams ?? []).map(
      (url) =>
        new WsUpstream(
          url,
          breakerCfg,
          (host, from, to, reason) =>
            this.events.onBreakerChange?.(cfg.slug, host, from, to, reason),
          wsProbe,
        ),
    );
  }

  /** Whether this chain accepts client WebSocket upgrades. */
  hasWs(): boolean {
    return this.wsUpstreams.length > 0;
  }

  private bestKnownBlock(): bigint {
    let best = 0n;
    for (const u of this.upstreams) if (u.lastBlock > best) best = u.lastBlock;
    return best;
  }

  private isLagging(u: { lastBlock: bigint }, bestBlock: bigint): boolean {
    if (u.lastBlock === 0n || bestBlock === 0n) return false;
    return bestBlock - u.lastBlock > this.maxLagBlocks;
  }

  /**
   * Available upstreams ordered by desirability:
   * in-sync before lagging, closed breaker before half-open, then lowest latency.
   */
  private orderedUpstreams(): Upstream[] {
    const bestBlock = this.bestKnownBlock();
    const rank = (u: Upstream): number => {
      let score = 0;
      if (this.isLagging(u, bestBlock)) score += 2;
      if (u.breaker.currentState === "half-open") score += 1;
      return score;
    };
    // Unknown latency (0 = never succeeded) sorts last; probes warm it up.
    const latency = (u: Upstream): number =>
      u.latencyMs === 0 ? Number.POSITIVE_INFINITY : u.latencyMs;
    return this.upstreams
      .filter((u) => u.breaker.canRequest())
      .sort((a, b) => rank(a) - rank(b) || latency(a) - latency(b));
  }

  /**
   * Available WS upstreams ordered by desirability: closed breaker before
   * half-open, then lowest latency. WS endpoints self-report their head via
   * probes, but lag is not used for admission here — a client WS is long-lived
   * and failing over mid-stream would drop subscriptions, so we simply pick the
   * healthiest reachable endpoint at connect time.
   */
  private orderedWsUpstreams(): WsUpstream[] {
    const rank = (u: WsUpstream): number =>
      u.breaker.currentState === "half-open" ? 1 : 0;
    const latency = (u: WsUpstream): number =>
      u.latencyMs === 0 ? Number.POSITIVE_INFINITY : u.latencyMs;
    return this.wsUpstreams
      .filter((u) => u.breaker.canRequest())
      .sort((a, b) => rank(a) - rank(b) || latency(a) - latency(b));
  }

  /**
   * Open a sticky client<->upstream WS proxy. Picks the best-ranked reachable
   * WS upstream, connects a backing {@link WsSession}, and wires the relay hooks
   * the caller supplies. Returns null when no WS upstream is admissible (all
   * circuits open / none configured), letting the caller reject the upgrade.
   */
  openWsSession(hooks: {
    onUpstreamMessage: (data: string) => void;
    onUpstreamClose: (code: number, reason: string) => void;
    onOpen?: () => void;
    onError?: (message: string) => void;
  }): { session: WsSession; host: string } | null {
    const candidate = this.orderedWsUpstreams()[0];
    if (!candidate) return null;

    candidate.breaker.onAttempt();
    candidate.markSessionStarted();

    const session = new WsSession(candidate.url, {
      onUpstreamMessage: hooks.onUpstreamMessage,
      onOpen: hooks.onOpen,
      onError: (message) => {
        candidate.markSessionFailed(message);
        hooks.onError?.(message);
      },
      onUpstreamClose: (code, reason) => {
        // Abnormal closes (1006 and friends) score against the breaker so a
        // flapping endpoint is deprioritized for the next client.
        if (code !== 1000 && code !== 1001) {
          candidate.markSessionFailed(reason || `closed ${code}`);
        }
        hooks.onUpstreamClose(code, reason);
      },
    });
    session.connect();
    return { session, host: candidate.host };
  }

  /** Sequentially try upstreams until one fulfills the request. */
  async handle(bodyText: string): Promise<Response> {
    const meta = parseRequestMeta(bodyText);
    const candidates = this.orderedUpstreams().slice(0, this.cfg.maxAttempts);
    const attempts: RequestAttempt[] = [];

    const finish = (res: Response): Response => {
      this.events.onRequest?.({
        chain: this.cfg.slug,
        method: meta.method,
        attempts,
        status: res.status,
      });
      return res;
    };

    if (candidates.length === 0) {
      return finish(
        jsonRpcError(
          meta.id,
          -32603,
          `all upstreams unavailable for ${this.cfg.slug} (circuits open)`,
          503,
        ),
      );
    }

    let lastOutcome: CallOutcome | null = null;
    for (const upstream of candidates) {
      const startedAt = performance.now();
      const outcome = await upstream.call(bodyText, this.cfg.requestTimeoutMs);
      attempts.push({
        host: upstream.host,
        ok: outcome.ok,
        ms: Math.round(performance.now() - startedAt),
        error: outcome.error,
      });

      if (outcome.ok) {
        return finish(
          new Response(outcome.bodyText, {
            status: 200,
            headers: { ...JSON_HEADERS, "x-upstream": upstream.host },
          }),
        );
      }

      // Non-retryable upstream response (e.g. 4xx for malformed request):
      // pass it through instead of hammering other upstreams with bad input.
      if (!outcome.retryable && outcome.bodyText !== undefined) {
        return finish(
          new Response(outcome.bodyText, {
            status: outcome.status ?? 502,
            headers: { ...JSON_HEADERS, "x-upstream": upstream.host },
          }),
        );
      }

      lastOutcome = outcome;
    }

    return finish(
      jsonRpcError(
        meta.id,
        -32603,
        `all ${candidates.length} upstream attempt(s) failed for ${this.cfg.slug}; last error: ${lastOutcome?.error ?? "unknown"}`,
        502,
      ),
    );
  }

  /** Probe every currently-admissible upstream (HTTP + WS). */
  async runHealthChecks(): Promise<void> {
    await Promise.all([
      ...this.upstreams
        .filter((u) => u.breaker.canRequest())
        .map((u) => u.probe(this.cfg.requestTimeoutMs)),
      ...this.wsUpstreams
        .filter((u) => u.breaker.canRequest())
        .map((u) => u.probe(this.cfg.requestTimeoutMs)),
    ]);
  }

  /** Snapshot every upstream's error rate into its history ring. */
  sampleErrRates(): void {
    for (const u of this.upstreams) u.sampleErrRate();
    for (const u of this.wsUpstreams) u.sampleErrRate();
  }

  /** Zero all per-upstream counters (used by the TUI's reset key). */
  resetStats(): void {
    for (const u of this.upstreams) u.resetStats();
    for (const u of this.wsUpstreams) u.resetStats();
  }

  private upstreamStatus(
    u: UpstreamHealth,
    kind: "http" | "ws",
    rank: number | null,
    bestBlock: bigint,
  ) {
    return {
      kind,
      url: u.url,
      state: u.breaker.currentState,
      rank,
      lagging: this.isLagging(u, bestBlock),
      latencyMs: Math.round(u.latencyMs),
      lastBlock: u.lastBlock.toString(),
      totalRequests: u.totalRequests,
      totalFailures: u.totalFailures,
      recentErrRate: u.liveErrRate(),
      errSpark: u.errHistory.series(),
      openRemainingMs: u.breaker.openRemainingMs(),
      lastError: u.lastError,
      lastErrorAt: u.lastErrorAt ? new Date(u.lastErrorAt).toISOString() : null,
    };
  }

  status() {
    const bestBlock = this.bestKnownBlock();
    // Routing preference right now: rank 1 gets the next request.
    const rankOf = new Map(this.orderedUpstreams().map((u, i) => [u.url, i + 1]));
    const wsRankOf = new Map(this.orderedWsUpstreams().map((u, i) => [u.url, i + 1]));
    return {
      name: this.cfg.name,
      slug: this.cfg.slug,
      family: this.cfg.family,
      // Omitted from the JSON entirely for families without a numeric ID.
      chainId: this.cfg.chainId,
      bestKnownBlock: bestBlock.toString(),
      upstreams: this.upstreams.map((u) =>
        this.upstreamStatus(u, "http", rankOf.get(u.url) ?? null, bestBlock),
      ),
      wsUpstreams: this.wsUpstreams.map((u) =>
        this.upstreamStatus(u, "ws", wsRankOf.get(u.url) ?? null, bestBlock),
      ),
    };
  }
}
