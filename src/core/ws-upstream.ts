import WebSocket from "ws";
import { UpstreamHealth } from "./upstream-health.js";

/**
 * A live upstream WebSocket session bound to exactly one client WS. The
 * balancer opens one of these per accepted client connection (sticky routing),
 * proxying messages in both directions until either side closes.
 *
 * `onUpstreamMessage` fires for every frame the upstream sends (RPC responses
 * AND `eth_subscription` push notifications) so the caller can relay it to the
 * client verbatim. `onUpstreamClose` fires once when the backing socket ends,
 * letting the caller close the client (or fail over).
 */
export class WsSession {
  private socket: WebSocket | null = null;
  private closed = false;
  /** Frames the client sent before the upstream finished connecting. */
  private readonly pending: string[] = [];

  constructor(
    readonly url: string,
    private readonly hooks: {
      onUpstreamMessage: (data: string) => void;
      onUpstreamClose: (code: number, reason: string) => void;
      onOpen?: () => void;
      onError?: (message: string) => void;
    },
  ) {}

  /** Open the backing upstream socket and start relaying its frames. */
  connect(): void {
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (err) {
      this.hooks.onError?.(err instanceof Error ? err.message : String(err));
      this.hooks.onUpstreamClose(1006, "connect failed");
      return;
    }
    this.socket = socket;

    socket.on("open", () => {
      // Flush anything the client sent while we were still connecting.
      for (const msg of this.pending) socket.send(msg);
      this.pending.length = 0;
      this.hooks.onOpen?.();
    });
    socket.on("message", (data: WebSocket.RawData) => {
      this.hooks.onUpstreamMessage(data.toString());
    });
    socket.on("close", (code: number, reason: Buffer) => {
      if (this.closed) return;
      this.closed = true;
      this.hooks.onUpstreamClose(code, reason.toString());
    });
    socket.on("error", () => {
      this.hooks.onError?.("upstream socket error");
    });
  }

  /** Forward a client frame to the upstream (queued until the socket opens). */
  send(data: string): void {
    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(data);
    } else {
      this.pending.push(data);
    }
  }

  /** Tear down the backing socket without firing onUpstreamClose again. */
  close(code = 1000, reason = ""): void {
    this.closed = true;
    try {
      this.socket?.close(code, reason);
    } catch {
      // already closed
    }
  }
}

/**
 * Health/routing state for a single upstream WS endpoint. Reuses the shared
 * {@link UpstreamHealth} bookkeeping; live client traffic rides a dedicated
 * per-client {@link WsSession}, so this class owns only the shared health signal
 * and short-lived probe connections used to rank endpoints.
 */
export class WsUpstream extends UpstreamHealth {
  /** Count a client session that began riding this upstream. */
  markSessionStarted(): void {
    this.totalRequests += 1;
  }

  /** Score a client session that failed to establish / dropped abnormally. */
  markSessionFailed(error: string): void {
    this.recordFailure(error);
  }

  /**
   * Open a throwaway probe socket, send `eth_blockNumber`, and score the round
   * trip against the breaker + latency EWMA. Resolves when the probe settles
   * (success, error, or timeout) so callers can await a full round.
   */
  probe(timeoutMs: number): Promise<void> {
    this.breaker.onAttempt();
    this.totalRequests += 1;
    const startedAt = performance.now();

    return new Promise<void>((resolve) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.url);
      } catch (err) {
        this.recordFailure(err instanceof Error ? err.message : String(err));
        resolve();
        return;
      }

      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // already closing
        }
        resolve();
      };

      const timer = setTimeout(() => {
        if (settled) return;
        this.recordFailure("timeout");
        finish();
      }, timeoutMs);

      socket.on("open", () => {
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "healthcheck",
            method: "eth_blockNumber",
            params: [],
          }),
        );
      });

      socket.on("message", (data: WebSocket.RawData) => {
        if (settled) return;
        try {
          const parsed = JSON.parse(data.toString()) as { result?: string };
          if (typeof parsed.result === "string") {
            this.lastBlock = BigInt(parsed.result);
          }
        } catch {
          // malformed probe response; still counts as a reachable socket
        }
        this.recordSuccess(performance.now() - startedAt);
        finish();
      });

      socket.on("error", () => {
        if (settled) return;
        this.recordFailure("upstream socket error");
        finish();
      });

      socket.on("close", (code: number, reason: Buffer) => {
        if (settled) return;
        // Closed before a response arrived: score as failure.
        this.recordFailure(reason.toString() || `closed ${code}`);
        finish();
      });
    });
  }
}
