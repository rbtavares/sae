/**
 * Thin compatibility layer so the test suite reads like the previous `bun:test`
 * suite while running on Node's built-in `node:test` runner. Provides:
 *   - `describe` / `test` / `beforeEach` / `afterEach` (re-exported from node:test)
 *   - a small `expect(...)` with the matchers the suite uses, backed by node:assert
 *   - `setSystemTime(date?)` that swaps `Date.now` (all time-sensitive code uses it)
 *   - `sleep`, and `fakeRpc` / `fakeWsRpc` HTTP+WS test servers on Node
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, test } from "node:test";
import { WebSocketServer } from "ws";

export { afterEach, beforeEach, describe, test };

/** Minimal Jest/Bun-style matcher surface over node:assert. */
class Expectation {
  constructor(
    private readonly actual: unknown,
    private readonly negated = false,
  ) {}

  get not(): Expectation {
    return new Expectation(this.actual, !this.negated);
  }

  private check(pass: boolean, message: string): void {
    if (this.negated ? pass : !pass) {
      assert.fail(message);
    }
  }

  toBe(expected: unknown): void {
    this.check(
      Object.is(this.actual, expected),
      `expected ${format(this.actual)} ${this.negated ? "not " : ""}to be ${format(expected)}`,
    );
  }

  toEqual(expected: unknown): void {
    let pass = true;
    try {
      // Match Bun/Jest `toEqual`: ignore keys whose value is `undefined`.
      assert.deepStrictEqual(stripUndefined(this.actual), stripUndefined(expected));
    } catch {
      pass = false;
    }
    this.check(
      pass,
      `expected ${format(this.actual)} ${this.negated ? "not " : ""}to equal ${format(expected)}`,
    );
  }

  toContain(sub: string): void {
    const pass = typeof this.actual === "string" && this.actual.includes(sub);
    this.check(
      pass,
      `expected ${format(this.actual)} ${this.negated ? "not " : ""}to contain ${format(sub)}`,
    );
  }

  toHaveLength(len: number): void {
    const actualLen = (this.actual as { length?: number })?.length;
    this.check(
      actualLen === len,
      `expected length ${format(actualLen)} ${this.negated ? "not " : ""}to be ${len}`,
    );
  }

  toBeNull(): void {
    this.check(this.actual === null, `expected ${format(this.actual)} to be null`);
  }

  toBeGreaterThan(n: number): void {
    this.check(
      typeof this.actual === "number" && this.actual > n,
      `expected ${format(this.actual)} to be > ${n}`,
    );
  }

  toBeGreaterThanOrEqual(n: number): void {
    this.check(
      typeof this.actual === "number" && this.actual >= n,
      `expected ${format(this.actual)} to be >= ${n}`,
    );
  }

  /** For a thrown error: matches substring, RegExp, or error class. */
  toThrow(expected?: ErrorMatcher): void {
    assert.equal(typeof this.actual, "function", "toThrow expects a function argument");
    let thrown: unknown;
    let didThrow = false;
    try {
      (this.actual as () => unknown)();
    } catch (err) {
      didThrow = true;
      thrown = err;
    }
    if (this.negated) {
      this.check(didThrow, `expected function not to throw`);
      return;
    }
    assert.ok(didThrow, "expected function to throw");
    matchError(thrown, expected);
  }
}

/** What `toThrow` / `rejects.toThrow` accept: message substring, pattern, or class. */
type ErrorMatcher = string | RegExp | (new (...args: never[]) => Error);

/** Async companion for `expect(promise).rejects.toThrow(...)`. */
class AsyncRejects {
  constructor(private readonly promise: Promise<unknown>) {}

  async toThrow(expected?: ErrorMatcher): Promise<void> {
    let thrown: unknown;
    let didThrow = false;
    try {
      await this.promise;
    } catch (err) {
      didThrow = true;
      thrown = err;
    }
    assert.ok(didThrow, "expected promise to reject");
    matchError(thrown, expected);
  }
}

function matchError(thrown: unknown, expected?: ErrorMatcher): void {
  if (expected === undefined) return;
  if (typeof expected === "function") {
    assert.ok(
      thrown instanceof expected,
      `expected error to be instance of ${expected.name}`,
    );
    return;
  }
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  if (expected instanceof RegExp) {
    assert.match(message, expected);
  } else {
    assert.ok(
      message.includes(expected),
      `expected error message ${format(message)} to contain ${format(expected)}`,
    );
  }
}

export function expect(actual: unknown): Expectation & { rejects: AsyncRejects } {
  const exp = new Expectation(actual) as Expectation & { rejects: AsyncRejects };
  exp.rejects = new AsyncRejects(actual as Promise<unknown>);
  return exp;
}

/** Deep-clone, dropping object keys whose value is `undefined` (Jest semantics). */
function stripUndefined(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripUndefined);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val !== undefined) out[k] = stripUndefined(val);
    }
    return out;
  }
  return v;
}

function format(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "bigint") return `${v}n`;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Fake system clock: all time-sensitive production code reads `Date.now()`.
// ---------------------------------------------------------------------------

const realDateNow = Date.now.bind(Date);

/** Freeze `Date.now()` to `date`, or restore the real clock when omitted. */
export function setSystemTime(date?: Date): void {
  if (date === undefined) {
    Date.now = realDateNow;
  } else {
    const fixed = date.getTime();
    Date.now = () => fixed;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Test servers (HTTP + WS), tracked so tests can tear them all down.
// ---------------------------------------------------------------------------

const openServers: Server[] = [];

/** Close every server started via {@link fakeRpc} / {@link fakeWsRpc}. */
export async function closeAllServers(): Promise<void> {
  await Promise.all(
    openServers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections?.();
          s.close(() => resolve());
        }),
    ),
  );
}

type Handler = (req: Request) => Response | Promise<Response>;

/**
 * Start an HTTP server that answers each request via a WHATWG-`Request`/`Response`
 * handler (matching the old Bun.serve test ergonomics). Returns its base URL.
 */
export function fakeRpc(handler: Handler): string {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        const request = new Request(`http://localhost${req.url ?? "/"}`, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: body.length > 0 ? body : undefined,
        });
        const out = await handler(request);
        const headers: Record<string, string> = {};
        out.headers.forEach((v, k) => {
          headers[k] = v;
        });
        const text = await out.text();
        res.writeHead(out.status, headers);
        res.end(text);
      })();
    });
  });
  server.listen(0);
  openServers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://localhost:${port}`;
}

/** Minimal JSON-RPC-over-WS server that replies to any message with `block`. */
export function fakeWsRpc(block: string): string {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (data: Buffer) => {
      const req = JSON.parse(data.toString()) as { id: unknown };
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: block }));
    });
  });
  server.listen(0);
  openServers.push(server);
  const { port } = server.address() as AddressInfo;
  return `ws://localhost:${port}`;
}
