import type { BreakerState } from "../core/circuit-breaker.js";
import type { ChainMetricsSnapshot } from "../stats/stats.js";
import pkg from "../../package.json" with { type: "json" };

const version = (pkg as { version: string }).version;

const isTTY = process.stdout.isTTY ?? false;
const useColor = process.env.NO_COLOR ? false : isTTY || Boolean(process.env.FORCE_COLOR);

// Split-screen only makes sense on a real terminal. When piped to a file or
// running under a non-TTY (tests, CI, docker logs), fall back to plain
// append-only logging and skip the redrawing status pane entirely.
const splitScreen = isTTY && !process.env.NO_TUI;

const wrap =
  (code: string) =>
  (s: string): string =>
    useColor ? `\x1b[${code}m${s}\x1b[0m` : s;

export const bold = wrap("1");
export const dim = wrap("2");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const blue = wrap("34");
export const magenta = wrap("35");
export const cyan = wrap("36");
export const gray = wrap("90");
export const orange = wrap("38;5;208");
const inverse = wrap("7");

const CHAIN_PALETTE = [cyan, magenta, yellow, blue, green];
const chainColors = new Map<string, (s: string) => string>();

export function registerChains(slugs: string[]): void {
  slugs.forEach((slug, i) => {
    chainColors.set(slug, CHAIN_PALETTE[i % CHAIN_PALETTE.length]!);
    chainBuffer(slug); // pre-seed so global lines fan out to every chain
  });
}

function chainColor(slug: string): (s: string) => string {
  return chainColors.get(slug) ?? cyan;
}

function timestamp(): string {
  return gray(new Date().toTimeString().slice(0, 8));
}

function stateIcon(state: BreakerState): string {
  switch (state) {
    case "closed":
      return green("\u25CF"); // ●
    case "half-open":
      return yellow("\u25D0"); // ◐
    case "open":
      return red("\u25CB"); // ○
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
}

/**
 * Terminal column width of a single code point. Only genuinely double-width
 * glyphs (CJK, fullwidth forms, astral-plane emoji) count as 2; combining marks
 * and zero-width joiners as 0. Every symbol this TUI emits — ✓ ✗ ↯ ● ◐ ○ ◂ ▸ →
 * and braille — is a single monospace cell, so the width-2 handling only guards
 * against wide glyphs that might appear in upstream error strings. Keeps
 * padding/clipping aligned with what the terminal actually draws.
 */
function charWidth(cp: number): number {
  if (cp === 0x200d) return 0; // zero-width joiner
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining diacritics
  if (cp === 0xfe0f) return 0; // variation selector-16 (emoji presentation)
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK & radicals
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0x1f300 && cp <= 0x1faff) || // astral emoji / pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK ext
  ) {
    return 2;
  }
  return 1;
}

/** Visible column width of a string, ignoring ANSI SGR escape sequences. */
function visibleLength(s: string): number {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** Pad (with plain spaces) to a visible width, ANSI-safe. */
function padV(s: string, width: number, align: "left" | "right" = "left"): string {
  const gap = width - visibleLength(s);
  if (gap <= 0) return s;
  return align === "left" ? s + " ".repeat(gap) : " ".repeat(gap) + s;
}

/** Truncate a possibly-colored string to a visible column width. */
function clip(s: string, width: number): string {
  if (visibleLength(s) <= width) return s;
  let visible = 0;
  let result = "";
  let i = 0;
  while (i < s.length && visible < width) {
    if (s[i] === "\x1b") {
      const end = s.indexOf("m", i);
      if (end !== -1) {
        result += s.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    // Advance by a full code point (surrogate pair aware) and account for its
    // terminal width so wide glyphs don't overshoot the target column.
    const cp = s.codePointAt(i)!;
    const w = charWidth(cp);
    if (visible + w > width) break; // don't split a wide cell across the edge
    result += String.fromCodePoint(cp);
    visible += w;
    i += cp > 0xffff ? 2 : 1;
  }
  return `${result}\x1b[0m`;
}

// ---------------------------------------------------------------------------
// Terminal control
// ---------------------------------------------------------------------------

const ESC = "\x1b[";
const out = (s: string): void => void process.stdout.write(s);

function rows(): number {
  return process.stdout.rows ?? 24;
}
function cols(): number {
  return process.stdout.columns ?? 80;
}

// ---------------------------------------------------------------------------
// Shared formatting helpers
// ---------------------------------------------------------------------------

/** Shorten common upstream error strings to a compact token. */
function shortError(err: string | undefined): string {
  if (!err) return "err";
  if (/timed out|timeout|AbortError/i.test(err)) return "timeout";
  const http = err.match(/HTTP (\d{3})/);
  if (http) return http[1]!;
  if (/rate.?limit|too many/i.test(err)) return "429";
  if (/ECONNREFUSED|refused/i.test(err)) return "refused";
  if (/ENOTFOUND|dns|getaddrinfo/i.test(err)) return "dns";
  if (/reset|ECONNRESET/i.test(err)) return "reset";
  return truncate(err, 18);
}

/** Drop a trailing common TLD-ish segment for a shorter, still-unique label. */
function shortHost(host: string): string {
  const parts = host.split(".");
  if (parts.length >= 2) return parts[parts.length - 2]!;
  return host;
}

function fmtMs(ms: number | null): string {
  if (ms === null) return "\u2013";
  if (ms >= 10_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function fmtUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

// ---------------------------------------------------------------------------
// Status data shapes (superset of ChainBalancer.status())
// ---------------------------------------------------------------------------

export interface UpstreamStatus {
  /** Transport: "http" (JSON-RPC over POST) or "ws" (WebSocket). */
  kind?: "http" | "ws";
  url: string;
  state: BreakerState;
  rank: number | null;
  lagging: boolean;
  latencyMs: number;
  lastBlock: string;
  totalRequests: number;
  totalFailures: number;
  recentErrRate: number | null;
  errSpark: number[];
  openRemainingMs: number;
  lastError: string | null;
}

export interface ChainStatus {
  name: string;
  slug: string;
  chainId: number;
  bestKnownBlock: string;
  upstreams: UpstreamStatus[];
  /** WebSocket upstreams (only present for chains with wsUpstreams configured). */
  wsUpstreams?: UpstreamStatus[];
  metrics?: ChainMetricsSnapshot;
}

// ---------------------------------------------------------------------------
// Layout state
// ---------------------------------------------------------------------------

let started = false;
let startedAt = Date.now();
let paused = false;

// Per-chain log history, filtered to the chain currently on screen: viewing
// /arb shows only arbitrum's lines. The log pane is split into two columns:
//   IN  — user requests hitting the balancer (method, latency, HTTP code)
//   OUT — traffic leaving the balancer: per-upstream attempts + breaker updates
// Each chain keeps a bounded ring per side. Lines with no chain (startup,
// reset, probe) fan out to every chain's OUT ring so they surface on any page.
const LOG_HISTORY_MAX = 500;

type LogSide = "in" | "out";
interface ChainLog {
  in: string[];
  out: string[];
}
const logBuffers = new Map<string, ChainLog>();

function chainBuffer(slug: string): ChainLog {
  let buf = logBuffers.get(slug);
  if (!buf) {
    buf = { in: [], out: [] };
    logBuffers.set(slug, buf);
  }
  return buf;
}

function pushToBuffer(ring: string[], line: string): void {
  ring.push(line);
  if (ring.length > LOG_HISTORY_MAX) ring.shift();
}

// Paginated view: one chain per page, switched with left/right arrows. The
// last-rendered snapshot is retained so an arrow press can rebuild the pane
// immediately without waiting for the next 1s status tick.
let currentPage = 0;
let lastChains: ChainStatus[] = [];
// Vertical scroll offset into the upstream table (data rows, excluding the
// pinned header). Clamped each render to the overflow; reset when the chain
// page changes. Driven by the up/down arrows.
let upstreamScroll = 0;

/** Slug of the chain currently on screen, or null before any snapshot. */
function activeSlug(): string | null {
  const count = lastChains.length;
  if (count === 0) return null;
  return lastChains[clampPage(count)]!.slug;
}

interface Controls {
  onProbe?: () => void;
  onReset?: () => void;
}
let controls: Controls = {};

/** Listen port, shown in the header. Set by start(). */
let listenPort = 0;

// ---------------------------------------------------------------------------
// Frame rendering (single write -> no flicker)
// ---------------------------------------------------------------------------

/**
 * Record one log line on the given side (in/out) and repaint when it belongs to
 * the chain on screen. `chain` is the owning slug; omit it for global lines
 * (stored on every chain's OUT ring, always visible). In non-TTY mode
 * everything prints inline, unfiltered.
 */
function emit(line: string, side: LogSide, chain?: string): void {
  if (!splitScreen || !started) {
    console.log(line);
    return;
  }
  if (chain === undefined) {
    for (const buf of logBuffers.values()) pushToBuffer(buf[side], line);
  } else {
    pushToBuffer(chainBuffer(chain)[side], line);
  }
  // Paused freezes the pane; rings keep filling so unpausing/paging replays.
  if (paused) return;
  if (chain === undefined || chain === activeSlug()) renderFrame();
}

/** Clear both log columns for the on-screen chain and repaint. */
function clearLogPane(): void {
  if (!splitScreen || !started) return;
  const slug = activeSlug();
  if (slug) logBuffers.set(slug, { in: [], out: [] });
  renderFrame();
}

// ---------------------------------------------------------------------------
// Status board construction
// ---------------------------------------------------------------------------

const COL = {
  rank: 3,
  type: 4,
  lat: 6,
  delta: 5,
  req: 6,
  fail: 10,
} as const;

function upstreamLabel(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  return parsed.host + path;
}

/** Δ column: blocks behind best-known head. */
function blockDelta(u: UpstreamStatus, bestBlock: string): string {
  if (u.lastBlock === "0" || bestBlock === "0")
    return dim(padV("\u2013", COL.delta, "right"));
  const delta = BigInt(bestBlock) - BigInt(u.lastBlock);
  const n = delta > 9999n ? 9999 : Number(delta);
  if (n <= 0) return green(padV("0", COL.delta, "right"));
  const str = padV(`-${n}`, COL.delta, "right");
  return u.lagging ? red(str) : yellow(str);
}

/** Format a request count compactly: 1234 -> 1.2k, 2_500_000 -> 2.5M. */
function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * The top line. Left: product name, uptime, clock, lifetime request total and
 * live rps (summed across all served chains). Right: the key-hint controls,
 * justified to the terminal edge. (Chain paging moved into the chain panel.)
 */
function headerLine(chains: ChainStatus[]): string {
  const totalRps = chains.reduce((sum, c) => sum + (c.metrics?.rps ?? 0), 0);
  const totalReq = chains.reduce((sum, c) => sum + (c.metrics?.total ?? 0), 0);
  const up = fmtUptime((Date.now() - startedAt) / 1000);
  const clock = new Date().toTimeString().slice(0, 8);
  const pausedTag = paused ? `  ${inverse(yellow(" \u23F8 PAUSED "))}` : "";

  const host = process.env.HOST ?? "0.0.0.0";
  const addr =
    listenPort > 0 ? `  ${dim(host)}${dim(":")}${bold(String(listenPort))}` : "";
  const left =
    `${bold(inverse(` sae ${version} `))}` +
    `  ${dim(clock)}` +
    addr +
    `  ${dim("up")} ${up}` +
    `  ${bold(fmtCount(totalReq))} ${dim("req")}` +
    `  ${bold(totalRps.toFixed(1))} ${dim("rps")}` +
    pausedTag;

  const right = keyHints();
  const gap = Math.max(1, cols() - visibleLength(left) - visibleLength(right));
  return `${left}${" ".repeat(gap)}${right}`;
}

function clampPage(count: number): number {
  if (count <= 0) return 0;
  return ((currentPage % count) + count) % count;
}

// Host column bounds; the actual width flexes to fill the box between these.
const HOST_MIN = 16;
const HOST_MAX = 40;

/**
 * Compact upstream table header (no error-history spark, no NOTE column). The
 * leading two spaces mirror the `icon + space` gutter of data rows so every
 * heading sits exactly above its column. `hostW` is the flexed UPSTREAM width.
 */
function upstreamLiteHeader(hostW: number): string {
  return dim(
    `  ${padV("#", COL.rank, "right")} ${padV("TYPE", COL.type)} ${padV("UPSTREAM", hostW)} ${padV("LAT", COL.lat, "right")} ${padV("\u0394", COL.delta, "right")} ${padV("TOTAL", COL.req, "right")} ${padV("FAILED", COL.fail, "right")}`,
  );
}

/** One upstream row, trimmed to identity + live health (no spark, no notes). */
function upstreamLiteRow(u: UpstreamStatus, bestBlock: string, hostW: number): string {
  const rank =
    u.rank === null
      ? dim(padV("\u2013", COL.rank, "right"))
      : u.rank === 1
        ? bold(padV("1", COL.rank, "right"))
        : padV(String(u.rank), COL.rank, "right");

  const typeStr = padV(u.kind === "ws" ? "WS" : "HTTP", COL.type);
  const type = u.kind === "ws" ? magenta(typeStr) : orange(typeStr);

  const host = padV(truncate(upstreamLabel(u.url), hostW), hostW);

  const latStr = padV(u.latencyMs > 0 ? fmtMs(u.latencyMs) : "\u2013", COL.lat, "right");
  const lat =
    u.latencyMs === 0 ? dim(latStr) : u.latencyMs > 800 ? yellow(latStr) : latStr;

  const delta = blockDelta(u, bestBlock);
  const req = dim(padV(String(u.totalRequests), COL.req, "right"));

  const failPct = u.totalRequests > 0 ? (u.totalFailures / u.totalRequests) * 100 : 0;
  const failText =
    u.totalFailures > 0 ? `${u.totalFailures} (${failPct.toFixed(0)}%)` : "0";
  const failCell = padV(failText, COL.fail, "right");
  const fail = u.totalFailures > 0 ? red(failCell) : dim(failCell);

  return `${stateIcon(u.state)} ${rank} ${type} ${host} ${lat} ${delta} ${req} ${fail}`;
}

// ---------------------------------------------------------------------------
// Quadrant content
// ---------------------------------------------------------------------------

/** A labelled key/value line for the chain-info quadrant. */
function kv(label: string, value: string): string {
  return `${dim(padV(label, 9))} ${value}`;
}

/** Chain box title: page selector `◂ Arbitrum One (1/13) ▸`. */
function chainNav(c: ChainStatus, page: number, count: number): string {
  const color = chainColor(c.slug);
  // Arrows + counter match the other box titles (plain bold); only the chain
  // name carries its color.
  return count > 1
    ? `${bold("\u25C2")} ${color(bold(c.name))} ${bold(`(${page + 1}/${count})`)} ${bold("\u25B8")}`
    : color(bold(c.name));
}

/** Top-left quadrant: chain identity. Kept minimal (page selector is the box
 *  title; rps/ok/latency live in the graphs and upstream table). */
function chainInfoLines(c: ChainStatus): string[] {
  const color = chainColor(c.slug);
  const hasWs = (c.wsUpstreams?.length ?? 0) > 0;
  const proto = hasWs ? `${dim("POST/WS")}` : `${dim("POST")}`;
  return [
    kv("endpoint", `${proto} ${color(`/${c.slug}`)}`),
    kv("chain id", cyan(String(c.chainId))),
    kv("head", cyan(`#${c.bestKnownBlock}`)),
  ];
}

/**
 * The UPSTREAM (host) column flexes to fill the box: total width minus every
 * fixed column and its gap, clamped to [HOST_MIN, HOST_MAX]. `innerW` is the
 * box's inner content width.
 */
function hostWidth(innerW: number): number {
  // gutter(2) + rank + gap + type + gap + gap + lat + gap + delta + gap + req + gap + fail
  const fixed =
    2 +
    COL.rank +
    1 +
    COL.type +
    1 +
    1 +
    COL.lat +
    1 +
    COL.delta +
    1 +
    COL.req +
    1 +
    COL.fail;
  return Math.max(HOST_MIN, Math.min(HOST_MAX, innerW - fixed));
}

/** All upstreams (HTTP first, then WS) as one ordered list. */
function allUpstreams(c: ChainStatus): UpstreamStatus[] {
  return [...c.upstreams, ...(c.wsUpstreams ?? [])];
}

/**
 * Upstream table split into a pinned header and the scrollable data rows, so
 * the caller can window the rows independently of the header. HTTP and WS
 * upstreams share one table; the TYPE column marks each row's transport.
 */
function upstreamTable(
  c: ChainStatus,
  innerW: number,
): { header: string; rows: string[] } {
  const hostW = hostWidth(innerW);
  return {
    header: upstreamLiteHeader(hostW),
    rows: allUpstreams(c).map((u) => upstreamLiteRow(u, c.bestKnownBlock, hostW)),
  };
}

/** Top-right quadrant: compact upstream health table (full, unscrolled).
 *  Used by plain (non-TTY) mode where everything is printed at once. */
function upstreamLines(c: ChainStatus, innerW: number): string[] {
  const { header, rows } = upstreamTable(c, innerW);
  return [header, ...rows];
}

// Braille dot bit values, indexed [col 0..1][row 0..3]. OR them into 0x2800.
const BRAILLE_DOTS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
] as const;

/**
 * btop-style braille line graph. `values` are sampled left→right; each output
 * character packs 2 horizontal samples × 4 vertical dots, so a `height`-row
 * graph resolves 2*width samples across and 4*height levels tall. Scales to
 * `fixedMax` when given (e.g. 1 for a 0..1 rate), else auto-scales to the
 * series peak (min 1). When `axisFmt` is given, a right-aligned y-axis label
 * gutter (top = peak, bottom = 0) is drawn on the left, shrinking the plot.
 * Returns `height` colored strings.
 */
function brailleGraph(
  values: number[],
  width: number,
  height: number,
  color: (s: string) => string,
  fixedMax?: number,
  axisFmt?: (value: number) => string,
): string[] {
  // Compute the scale peak first so axis labels can be sized before plotting.
  const peak = fixedMax ?? Math.max(1, ...values);

  // Y-axis gutter: labels for the top (peak), middle, and bottom (0) rows.
  let gutter = 0;
  const labels: string[] = [];
  if (axisFmt && height >= 2) {
    for (let row = 0; row < height; row++) {
      // Fraction of `peak` at this text row's top edge (row 0 = top).
      const frac = 1 - row / (height - 1);
      const show = row === 0 || row === height - 1 || row === (height - 1) >> 1;
      labels.push(show ? axisFmt(peak * frac) : "");
    }
    gutter = Math.max(...labels.map((l) => l.length)) + 1; // +1 space pad
  }
  const plotW = Math.max(1, width - gutter);

  const cols = plotW * 2; // dot columns
  const dotRows = Math.max(1, height) * 4; // dot rows

  // Exactly one sample per dot-column: take the newest `cols` samples and
  // right-align them, left-padding with zeros. A sample is never duplicated
  // across columns, so a spike keeps a constant one-dot-column thickness as it
  // scrolls left. The 120s history covers a `cols`-wide plot so it fills fully.
  const tail = values.slice(-cols);
  const resampled =
    tail.length < cols
      ? [...(Array(cols - tail.length).fill(0) as number[]), ...tail]
      : tail;

  // Map each sample to a dot height 1..dotRows. Zero still draws a single
  // baseline dot, btop-style, so the graph is never fully empty.
  const heights = resampled.map((v) =>
    Math.max(1, Math.round((Math.max(0, v) / peak) * dotRows)),
  );

  const lines: string[] = [];
  for (let row = 0; row < height; row++) {
    // Dot rows covered by this text row, top (0) to bottom.
    const rowTopDot = row * 4;
    let line = "";
    for (let cx = 0; cx < plotW; cx++) {
      let bits = 0;
      for (let sub = 0; sub < 2; sub++) {
        const h = heights[cx * 2 + sub] ?? 0;
        // Filled dots counted from the bottom of the whole graph.
        for (let dr = 0; dr < 4; dr++) {
          const dotFromTop = rowTopDot + dr;
          const dotFromBottom = dotRows - 1 - dotFromTop;
          if (dotFromBottom < h) bits |= BRAILLE_DOTS[sub]![dr]!;
        }
      }
      line += bits === 0 ? " " : String.fromCharCode(0x2800 + bits);
    }
    const axis =
      gutter > 0 ? `${dim(padV(labels[row] ?? "", gutter - 1, "right"))} ` : "";
    lines.push(axis + color(line));
  }
  return lines;
}

/** RPS line graph (braille), auto-scaled, in the chain's color, y-axis labels. */
function rpsGraphLines(c: ChainStatus, width: number, height: number): string[] {
  const color = chainColor(c.slug);
  const series = c.metrics?.rpsSeries ?? [];
  const fmt = (v: number): string => (v >= 10 ? String(Math.round(v)) : v.toFixed(1));
  return brailleGraph(series, width, height, color, undefined, fmt);
}

/**
 * End-to-end error-rate graph (braille) over a fixed 0..1 domain, so a small
 * blip stays short and a full outage fills the box. Colored by the window peak:
 * clean → dim, minor → yellow, heavy → red. Y-axis labelled 0..100%.
 */
function errGraphLines(c: ChainStatus, width: number, height: number): string[] {
  const series = c.metrics?.errRateSeries ?? [];
  const peak = Math.max(0, ...series);
  const color = peak === 0 ? dim : peak < 0.25 ? yellow : red;
  const fmt = (v: number): string => `${Math.round(v * 100)}%`;
  return brailleGraph(series, width, height, color, 1, fmt);
}

// ---------------------------------------------------------------------------
// Public API: logs
// ---------------------------------------------------------------------------

export interface AttemptLog {
  host: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface RequestLog {
  chain: string;
  method: string;
  attempts: AttemptLog[];
  status: number;
}

export function logRequest(e: RequestLog): void {
  // Client-observed latency: every attempt this request burned through.
  const totalMs = e.attempts.reduce((sum, a) => sum + a.ms, 0);
  const httpTag =
    e.status === 200
      ? green(bold("200"))
      : e.status < 500
        ? yellow(bold(String(e.status)))
        : red(bold(String(e.status)));
  const latStr = totalMs > 1000 ? yellow(fmtMs(totalMs)) : dim(fmtMs(totalMs));
  // IN column: the user request as the balancer saw it.
  emit(`${timestamp()} ${e.method.padEnd(20)} ${latStr} ${httpTag}`, "in", e.chain);

  // OUT column: one line per outbound upstream attempt, in the order tried.
  if (e.attempts.length === 0) {
    emit(`${timestamp()} ${red("\u2717 no upstreams available")}`, "out", e.chain);
    return;
  }
  for (const a of e.attempts) {
    const mark = a.ok ? green("\u2713") : red("\u2717");
    const ms = a.ms > 1000 ? yellow(fmtMs(a.ms)) : dim(fmtMs(a.ms));
    const err = a.ok ? "" : ` ${dim(shortError(a.error))}`;
    emit(
      `${timestamp()} ${mark} ${shortHost(a.host).padEnd(14)} ${ms}${err}`,
      "out",
      e.chain,
    );
  }
}

export function logBreaker(
  chain: string,
  host: string,
  from: BreakerState,
  to: BreakerState,
  reason?: string,
): void {
  const arrow = `${stateIcon(from)}${dim("\u2192")}${stateIcon(to)} ${bold(to)}`;
  const why = reason ? ` ${gray(shortError(reason))}` : "";
  emit(
    `${timestamp()} ${yellow("\u21AF")} ${shortHost(host)} ${arrow}${why}`,
    "out",
    chain,
  );
}

// ---------------------------------------------------------------------------
// 2x2 grid frame
// ---------------------------------------------------------------------------
//
//   ┌─ global header ────────────────────────────────────────────────┐
//   │ key hints                                                       │
//   ├── chain info ──────────────────┬── upstreams ───────────────────┤
//   │ name / endpoint / id / head    │ compact health table           │
//   ├── incoming ────────────────────┼── outgoing ────────────────────┤
//   │ IN request log (bottom-align)  │ OUT upstream/breaker log        │
//   └────────────────────────────────┴────────────────────────────────┘
//
// The whole screen is redrawn on every event as a single write. Each cell is
// overwritten with a padded/clipped line, so no scroll region or clear-screen
// is needed and there is no flicker.

// btop-style box drawing characters (square corners).
const BOX = {
  tl: "\u250C", // ┌
  tr: "\u2510", // ┐
  bl: "\u2514", // └
  br: "\u2518", // ┘
  h: "\u2500", // ─
  v: "\u2502", // │
} as const;

/**
 * A self-contained bordered box, btop-style: square corners, the title inset
 * into the top border. Returns absolute-positioned escape output. `body` lines
 * are clipped to the inner width; `align` decides whether spare rows sit above
 * (bottom-align, for logs) or below (top-align) the content.
 */
function drawBox(opts: {
  top: number; // 1-indexed screen row of the box's top border
  left: number; // 1-indexed screen column of the box's left border
  width: number; // total box width including borders
  height: number; // total box height including borders
  title: string;
  body: string[];
  align: "top" | "bottom" | "center";
  color?: (s: string) => string;
  padLeft?: number; // inner left padding (default 1)
  padRight?: number; // inner right padding (default 1)
}): string {
  const { top, left, width, height, title, body, align } = opts;
  const border = opts.color ?? dim;
  const padL = opts.padLeft ?? 1;
  const padR = opts.padRight ?? 1;
  const innerW = Math.max(0, width - 2);
  const contentW = Math.max(0, innerW - padL - padR);
  const innerH = Math.max(0, height - 2);
  const at = (r: number): string => `${ESC}${top + r};${left}H`;

  // Top border with inset title: ┌─ title ────────┐. `title` may already carry
  // its own SGR color (e.g. the chain name); it is padded but not re-dimmed.
  const label = ` ${bold(title)} `;
  const titleW = visibleLength(label);
  const dash = Math.max(0, innerW - 1 - titleW);
  const topBorder =
    border(BOX.tl + BOX.h) + label + border(BOX.h.repeat(dash)) + border(BOX.tr);

  // Fit body to innerH rows, aligned.
  const rowsFit =
    body.length > innerH
      ? align === "bottom"
        ? body.slice(body.length - innerH)
        : body.slice(0, innerH)
      : body;
  const padCount = innerH - rowsFit.length;
  const blanks = Array.from({ length: Math.max(0, padCount) }, () => "");
  const content = align === "bottom" ? [...blanks, ...rowsFit] : [...rowsFit, ...blanks];

  const gapL = " ".repeat(padL);
  const gapR = " ".repeat(padR);
  let out = `${at(0)}${topBorder}`;
  for (let i = 0; i < innerH; i++) {
    const line = padV(clip(content[i] ?? "", contentW), contentW);
    out += `${at(1 + i)}${border(BOX.v)}${gapL}${line}${gapR}${border(BOX.v)}`;
  }
  out += `${at(height - 1)}${border(BOX.bl)}${border(BOX.h.repeat(innerW))}${border(BOX.br)}`;
  return out;
}

/** Repaint the entire screen: global header, four boxes, key-hint footer. */
function renderFrame(): void {
  if (!splitScreen || !started) return;
  const totalRows = rows();
  const width = cols();

  const chains = lastChains;
  const page = chains.length > 0 ? clampPage(chains.length) : 0;
  const chain = chains.length > 0 ? chains[page]! : null;
  const slug = chain?.slug ?? null;
  const buf = slug ? logBuffers.get(slug) : undefined;
  const chainClr = chain ? chainColor(chain.slug) : undefined;

  // Row plan (1-indexed):
  //   1            global header (with controls at the right)
  //   2            spacer
  //   3..totalRows 2x2 grid of boxes
  const gridTop = 3;
  const gridBottom = totalRows;
  const gridH = Math.max(6, gridBottom - gridTop + 1);
  // Top boxes have a FIXED height so paging between chains with different
  // upstream counts doesn't make the panel jump: always room for the table
  // header + up to 15 upstream rows, plus 2 border rows. Only shrink when the
  // terminal is too short to also keep a minimum for the log boxes.
  const MAX_UPSTREAM_ROWS = 15;
  const MIN_LOG_H = 5; // borders + a few log lines
  const topContent = 1 + MAX_UPSTREAM_ROWS;
  const topH = Math.max(3, Math.min(topContent + 2, gridH - MIN_LOG_H));
  const botH = Math.max(3, gridH - topH);
  const midRow = gridTop + topH; // top border row of the bottom boxes

  // Boxes share the middle column/row edge (touching, like btop panels).
  const leftW = Math.max(3, Math.floor(width / 2));
  const rightW = Math.max(3, width - leftW);
  const midCol = 1 + leftW; // left border column of the right boxes

  let frame = `${ESC}?25l`;

  frame += `${ESC}1;1H${clip(padV(headerLine(chains), width), width)}`;
  frame += `${ESC}2;1H${ESC}2K`; // spacer row between header and grid

  // Top-left: a chain-info box on top, then a row of two side-by-side graph
  // boxes (rps | error rate). Graphs are a fixed 5 rows tall + 2 borders; the
  // info box takes the remaining height.
  const GRAPH_H = 5;
  const graphBoxH = GRAPH_H + 2;
  const infoBoxH = Math.max(3, topH - graphBoxH);
  const graphTop = gridTop + infoBoxH;
  // Split the left column into two graph boxes sharing the middle edge.
  const gLeftW = Math.max(3, Math.floor(leftW / 2));
  const gRightW = Math.max(3, leftW - gLeftW);
  const gRightCol = 1 + gLeftW;

  frame += drawBox({
    top: gridTop,
    left: 1,
    width: leftW,
    height: infoBoxH,
    title: chain ? chainNav(chain, page, chains.length) : "chain",
    body: chain ? chainInfoLines(chain) : [],
    align: "top",
    color: chainClr,
  });
  // Graph box titles carry the current value, e.g. "rps: 4.0" / "error: 12%".
  const rpsTitle = chain ? `rps: ${(chain.metrics?.rps ?? 0).toFixed(1)}` : "rps";
  const errRate = chain?.metrics?.okRate == null ? 0 : 1 - chain.metrics.okRate;
  const errTitle = chain ? `error: ${Math.round(errRate * 100)}%` : "error";
  frame += drawBox({
    top: graphTop,
    left: 1,
    width: gLeftW,
    height: graphBoxH,
    title: rpsTitle,
    body: chain ? rpsGraphLines(chain, gLeftW - 4, GRAPH_H) : [],
    align: "top",
  });
  frame += drawBox({
    top: graphTop,
    left: gRightCol,
    width: gRightW,
    height: graphBoxH,
    title: errTitle,
    body: chain ? errGraphLines(chain, gRightW - 4, GRAPH_H) : [],
    align: "top",
  });

  // Top-right: upstreams (spans the full top height). The header row is pinned;
  // the data rows below it scroll with the up/down arrows when they overflow
  // the box. `visibleRows` = inner height minus the two borders and the header.
  let upstreamBody: string[] = [];
  let upstreamTitle = "upstreams";
  if (chain) {
    const { header, rows } = upstreamTable(chain, rightW - 4);
    const visibleRows = Math.max(1, topH - 2 - 1); // -borders -header
    const maxScroll = Math.max(0, rows.length - visibleRows);
    // Clamp the shared scroll state to this chain's overflow.
    upstreamScroll = Math.min(Math.max(0, upstreamScroll), maxScroll);
    const shown = rows.slice(upstreamScroll, upstreamScroll + visibleRows);
    upstreamBody = [header, ...shown];
    const total = rows.length;
    if (maxScroll > 0) {
      const first = upstreamScroll + 1;
      const last = upstreamScroll + shown.length;
      const more = upstreamScroll < maxScroll ? " \u2193" : "";
      const prev = upstreamScroll > 0 ? "\u2191 " : "";
      upstreamTitle = `upstreams: ${total} ${dim(`[${prev}${first}-${last}${more}]`)}`;
    } else {
      upstreamTitle = `upstreams: ${total}`;
    }
  }
  frame += drawBox({
    top: gridTop,
    left: midCol,
    width: rightW,
    height: topH,
    title: upstreamTitle,
    body: upstreamBody,
    align: "top",
  });

  // Bottom-left: incoming (IN). Bottom-right: outgoing (OUT).
  frame += drawBox({
    top: midRow,
    left: 1,
    width: leftW,
    height: botH,
    title: "incoming",
    body: buf ? buf.in : [],
    align: "bottom",
  });
  frame += drawBox({
    top: midRow,
    left: midCol,
    width: rightW,
    height: botH,
    title: "outgoing",
    body: buf ? buf.out : [],
    align: "bottom",
  });

  // Cursor stays hidden (restored on cleanup) so it doesn't blink in a corner.
  out(frame);
}

/** Key-hint controls shown at the right of the top header. */
function keyHints(): string {
  // Render the word with its shortcut letter highlighted, e.g. "quit" with the
  // leading "q" in bold cyan and the rest dim.
  const key = (k: string, word: string): string => {
    const i = word.toLowerCase().indexOf(k.toLowerCase());
    if (i === -1) return `${bold(cyan(k))}${dim(word)}`;
    return (
      dim(word.slice(0, i)) + bold(cyan(word.slice(i, i + 1))) + dim(word.slice(i + 1))
    );
  };
  const pausedTag = paused ? `  ${inverse(yellow(" \u23F8 PAUSED "))}` : "";
  // Glyph-labelled hints for the arrow keys: ◂▸ pages chains, ▴▾ scrolls the
  // upstream table.
  const arrows = (glyphs: string, word: string): string =>
    `${bold(cyan(glyphs))}${dim(word)}`;
  return (
    [
      arrows("\u25C2\u25B8", "chain"),
      arrows("\u25B4\u25BE", "scroll"),
      key("q", "quit"),
      key("p", "pause"),
      key("r", "reset"),
      key("h", "health"),
      key("c", "clear"),
    ].join(dim(" \u00B7 ")) + pausedTag
  );
}

/** Flat line list for non-TTY (plain) mode: header + chain facts + upstreams. */
function plainLines(chains: ChainStatus[]): string[] {
  const lines = [headerLine(chains)];
  if (chains.length === 0) return lines;
  const page = clampPage(chains.length);
  const chain = chains[page]!;
  lines.push("");
  lines.push(chainNav(chain, page, chains.length));
  for (const l of chainInfoLines(chain)) lines.push(l);
  lines.push("");
  for (const l of upstreamLines(chain, HOST_MAX + 40)) lines.push(`  ${l}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Public API: lifecycle
// ---------------------------------------------------------------------------

/**
 * Refresh the board. In split-screen mode this redraws the whole 2x2 grid in
 * place; without a TTY it prints a flat snapshot inline (plain mode).
 */
export function renderStatus(chains: ChainStatus[]): void {
  lastChains = chains;
  if (!splitScreen) {
    console.log(`\n${plainLines(chains).join("\n")}\n`);
    return;
  }
  renderFrame();
}

/** Flip the paged chain by `delta` (wraps) and repaint. Resets upstream scroll
 *  so a new chain always starts at the top of its table. */
function turnPage(delta: number): void {
  const count = lastChains.length;
  if (count <= 1) return;
  currentPage = (clampPage(count) + delta + count) % count;
  upstreamScroll = 0;
  renderFrame();
}

/** Scroll the upstream table by `delta` rows and repaint. The offset is clamped
 *  to the current chain's overflow inside renderFrame(), so overshoot is safe. */
function scrollUpstreams(delta: number): void {
  const next = upstreamScroll + delta;
  if (next < 0 && upstreamScroll === 0) return;
  upstreamScroll = Math.max(0, next);
  renderFrame();
}

function setupKeys(cleanup: () => void): void {
  if (!process.stdin.isTTY) return;
  try {
    process.stdin.setRawMode(true);
  } catch {
    return;
  }
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    // A single data event can carry several keypresses coalesced together
    // (e.g. two arrows + a char as "\x1b[C\x1b[Bq"), so tokenize the chunk and
    // dispatch each key in order rather than matching the whole chunk. Arrow
    // keys are CSI sequences: ESC [ A/B/C/D, plus the application-cursor
    // ESC O A/B/C/D variant.
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!;

      if (ch === "\x1b" && i + 2 < chunk.length) {
        const intro = chunk[i + 1];
        const final = chunk[i + 2];
        if (intro === "[" || intro === "O") {
          switch (final) {
            case "A":
              scrollUpstreams(-1);
              break;
            case "B":
              scrollUpstreams(1);
              break;
            case "C":
              turnPage(1);
              break;
            case "D":
              turnPage(-1);
              break;
          }
          i += 2; // consume the 3-byte sequence
          continue;
        }
      }

      switch (ch) {
        case "q":
        case "\x03": // Ctrl-C in raw mode
          cleanup();
          process.exit(0);
          break;
        case "p":
          paused = !paused;
          // Repaint replays anything that landed in the rings while frozen.
          renderFrame();
          break;
        case "r":
          controls.onReset?.();
          emit(`${timestamp()} ${gray("counters reset")}`, "out");
          break;
        case "h":
          controls.onProbe?.();
          emit(`${timestamp()} ${gray("health probe triggered")}`, "out");
          break;
        case "c":
          clearLogPane();
          break;
        // Bracket fallbacks for terminals that don't forward raw arrow keys.
        case "[":
          turnPage(-1);
          break;
        case "]":
          turnPage(1);
          break;
      }
    }
  });
}

/**
 * Enter full-screen mode: clear the screen, draw the 2x2 grid, install
 * raw-key controls and resize handling. Safe no-op degradation without a TTY.
 */
export function start(chains: ChainStatus[], port: number, ctl: Controls = {}): void {
  controls = ctl;
  listenPort = port;
  startedAt = Date.now();
  if (!splitScreen) {
    banner(port, chains);
    renderStatus(chains);
    return;
  }
  lastChains = chains;
  out(`${ESC}2J${ESC}H`); // clear + home
  started = true;
  renderFrame();

  const cleanup = (): void => {
    out(`${ESC}r${ESC}?25h${ESC}${rows()};1H\n`);
    try {
      process.stdin.setRawMode(false);
    } catch {
      // not raw
    }
  };
  process.on("exit", cleanup);
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.stdout.on("resize", () => renderFrame());
  setupKeys(cleanup);
}

export function banner(port: number, chains: ChainStatus[]): void {
  console.log("");
  console.log(`  ${bold("sae")} ${dim(`listening on http://localhost:${port}`)}`);
  for (const c of chains) {
    const ws =
      c.wsUpstreams && c.wsUpstreams.length > 0
        ? ` ${dim(`+ ${c.wsUpstreams.length} ws`)}`
        : "";
    console.log(
      `  ${dim("POST")} ${chainColor(c.slug)(`/${c.slug}`)} ${dim(`\u2192 ${c.name} (${c.upstreams.length} upstreams)`)}${ws}`,
    );
  }
  console.log(`  ${dim("GET  /status")}`);
}
