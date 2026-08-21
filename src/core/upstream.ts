import type { BreakerConfig } from "../config.js";
import { EVM_PROBE, type ProbeSpec } from "./probe.js";
import { type BreakerChangeListener, UpstreamHealth } from "./upstream-health.js";

export type { BreakerChangeListener } from "./upstream-health.js";

export interface CallOutcome {
  ok: boolean;
  /** Whether the next upstream should be tried. */
  retryable: boolean;
  status?: number;
  bodyText?: string;
  error?: string;
}

/**
 * JSON-RPC error codes worth failing over for (rate limits, node-side issues).
 *
 * The Solana entries are all "this node cannot serve it, another might":
 * -32004 block not available, -32005 node unhealthy / behind, -32011 no
 * transaction history (pruned vs archive), -32016 minimum context slot not
 * reached, -32019 long-term storage query failed.
 *
 * Deliberately absent are Solana's deterministic outcomes — -32002 (preflight
 * failure), -32007 / -32009 (slot skipped), -32015 (unsupported transaction
 * version) — which are legitimate answers, the analogue of `execution
 * reverted`, and must reach the caller untouched.
 */
const RETRYABLE_RPC_CODES = new Set([
  -32004, -32005, -32011, -32016, -32019, -32042, -32603,
]);
const RETRYABLE_RPC_MESSAGE = /rate.?limit|too many request|capacity|try again/i;

/**
 * Inspect a single (non-batch) JSON-RPC response body for errors that
 * indicate an upstream problem rather than a legitimate RPC error
 * (e.g. execution reverted), which must be passed through untouched.
 */
function findRetryableRpcError(bodyText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return "invalid JSON from upstream";
  }
  // Batch responses are passed through as-is; per-item retry is out of scope.
  if (Array.isArray(parsed) || parsed === null || typeof parsed !== "object") {
    return null;
  }
  const error = (parsed as { error?: { code?: number; message?: string } }).error;
  if (!error) return null;
  const code = typeof error.code === "number" ? error.code : 0;
  const message = typeof error.message === "string" ? error.message : "";
  if (RETRYABLE_RPC_CODES.has(code) || RETRYABLE_RPC_MESSAGE.test(message)) {
    return `rpc error ${code}: ${message}`;
  }
  return null;
}

/** An HTTP JSON-RPC upstream: requests are forwarded per-call over `fetch`. */
export class Upstream extends UpstreamHealth {
  private readonly probeSpec: ProbeSpec;

  constructor(
    url: string,
    breakerCfg: BreakerConfig,
    onBreakerChange?: BreakerChangeListener,
    probeSpec: ProbeSpec = EVM_PROBE,
  ) {
    super(url, breakerCfg, onBreakerChange);
    this.probeSpec = probeSpec;
  }

  /** Forward a raw JSON-RPC body to this upstream. */
  async call(bodyText: string, timeoutMs: number): Promise<CallOutcome> {
    this.breaker.onAttempt();
    this.totalRequests += 1;
    const startedAt = performance.now();

    let res: Response;
    let text: string;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyText,
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.recordFailure(message);
      return { ok: false, retryable: true, error: message };
    }

    if (!res.ok) {
      // 404 = this upstream's endpoint is gone/misrouted; another upstream may
      // still serve the request, so fail over. 400 stays non-retryable: treat
      // it as a genuine bad request and pass it straight back to the client.
      const retryable =
        res.status === 429 ||
        res.status === 403 ||
        res.status === 404 ||
        res.status >= 500;
      const error = `HTTP ${res.status}`;
      this.recordFailure(error);
      return { ok: false, retryable, status: res.status, bodyText: text, error };
    }

    const rpcError = findRetryableRpcError(text);
    if (rpcError) {
      this.recordFailure(rpcError);
      return {
        ok: false,
        retryable: true,
        status: res.status,
        bodyText: text,
        error: rpcError,
      };
    }

    this.recordSuccess(performance.now() - startedAt);
    return { ok: true, retryable: false, status: res.status, bodyText: text };
  }

  /**
   * Active probe using this chain family's head query (see {@link ProbeSpec}).
   * Updates breaker, latency, and head block.
   */
  async probe(timeoutMs: number): Promise<void> {
    const { method, params, parseHead } = this.probeSpec;
    const body = JSON.stringify({ jsonrpc: "2.0", id: "healthcheck", method, params });
    const outcome = await this.call(body, timeoutMs);
    if (!outcome.ok || !outcome.bodyText || !parseHead) return;
    try {
      const parsed = JSON.parse(outcome.bodyText) as { result?: unknown };
      const head = parseHead(parsed.result);
      if (head !== null) this.lastBlock = head;
    } catch {
      // Ignore malformed probe responses; call() already scored the attempt.
    }
  }
}
