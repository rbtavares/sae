import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, parse as parsePath } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Which JSON-RPC dialect a chain speaks. Decides the health-probe method and
 * how its result is read; everything else in the proxy is dialect-agnostic.
 */
export type ChainFamily = "evm" | "solana";

export const CHAIN_FAMILIES = ["evm", "solana"] as const;

export interface ChainConfig {
  /** Human-readable name. */
  name: string;
  /** URL path segment, e.g. "eth" -> POST /eth */
  slug: string;
  /** RPC dialect. Defaults to "evm" when omitted from the config file. */
  family: ChainFamily;
  /** EVM chain ID. Absent for families that have no numeric chain ID. */
  chainId?: number;
  /** Upstream RPC endpoints, tried in health/latency order. */
  upstreams: string[];
  /**
   * Optional WebSocket RPC endpoints (ws:// or wss://). When present, the
   * balancer accepts client WS upgrades on the chain's slug path and proxies
   * them sticky to the best-ranked backing upstream. Empty/omitted = WS
   * disabled for this chain (client upgrade requests are rejected).
   */
  wsUpstreams?: string[];
  /** Per-attempt timeout. */
  requestTimeoutMs: number;
  /** Max upstreams tried per incoming request. */
  maxAttempts: number;
  /**
   * Per-chain override of the global {@link AppConfig.maxLagBlocks}. Block
   * times vary by orders of magnitude (12s on Ethereum, ~400ms Solana slots,
   * ~10ms on MegaETH), so one global threshold cannot fit every chain.
   */
  maxLagBlocks?: number;
}

export interface BreakerConfig {
  /** Consecutive failures before opening the circuit. */
  failureThreshold: number;
  /** Time the circuit stays open before allowing probes. */
  cooldownMs: number;
  /** Concurrent probe requests allowed while half-open. */
  halfOpenMaxProbes: number;
}

export interface AppConfig {
  port: number;
  healthCheckIntervalMs: number;
  /**
   * Upstreams more than this many blocks behind the best-known head are
   * deprioritized. Chains may override it via {@link ChainConfig.maxLagBlocks}.
   */
  maxLagBlocks: number;
  breaker: BreakerConfig;
  chains: ChainConfig[];
}

/**
 * Config file names, resolved next to the running binary/script (see
 * {@link configDir}). `default.config.json` ships with the repo and holds the
 * complete baseline; `config.json` is a gitignored, user-owned file that
 * overrides any subset of those values.
 */
export const DEFAULT_CONFIG_FILE = "default.config.json";
export const USER_CONFIG_FILE = "config.json";

/** Thrown when a config file is missing, unparseable, or malformed. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Reject any key on `o` not in `allowed`, so a typo (e.g. `maxAttempt`,
 * `chian`) fails loudly instead of being silently ignored. `$schema` is always
 * permitted so files can reference the JSON Schema for editor tooling.
 */
function rejectUnknownKeys(o: Json, allowed: readonly string[], path: string): void {
  const ok = new Set<string>([...allowed, "$schema"]);
  for (const key of Object.keys(o)) {
    if (!ok.has(key)) {
      throw new ConfigError(`${path}: unknown key "${key}"`);
    }
  }
}

function reqNumber(o: Json, key: string, path: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ConfigError(`${path}.${key} must be a number`);
  }
  return v;
}

/** Integer within `[min, max]` (inclusive). */
function reqIntInRange(
  o: Json,
  key: string,
  path: string,
  min: number,
  max: number,
): number {
  const v = reqNumber(o, key, path);
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new ConfigError(`${path}.${key} must be an integer between ${min} and ${max}`);
  }
  return v;
}

/** Integer `>= min`, with no upper bound. */
function reqIntAtLeast(o: Json, key: string, path: string, min: number): number {
  const v = reqNumber(o, key, path);
  if (!Number.isInteger(v) || v < min) {
    throw new ConfigError(`${path}.${key} must be an integer >= ${min}`);
  }
  return v;
}

function reqString(o: Json, key: string, path: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ConfigError(`${path}.${key} must be a non-empty string`);
  }
  return v;
}

/** A short lowercase URL-path slug: `[a-z0-9-]`, used as the route segment. */
const SLUG_RE = /^[a-z0-9-]+$/;

function reqSlug(o: Json, key: string, path: string): string {
  const v = reqString(o, key, path);
  if (!SLUG_RE.test(v)) {
    throw new ConfigError(
      `${path}.${key} must match ${SLUG_RE} (lowercase letters, digits, hyphens)`,
    );
  }
  return v;
}

/** Optional chain family, defaulting to `evm` so existing configs keep working. */
function optFamily(o: Json, key: string, path: string): ChainFamily {
  const v = o[key];
  if (v === undefined) return "evm";
  if (typeof v !== "string" || !(CHAIN_FAMILIES as readonly string[]).includes(v)) {
    throw new ConfigError(
      `${path}.${key} must be one of: ${CHAIN_FAMILIES.join(", ")} (got ${JSON.stringify(v)})`,
    );
  }
  return v as ChainFamily;
}

/** Validate a list of endpoint URLs, requiring one of `schemes`. */
function reqUrlArray(
  o: Json,
  key: string,
  path: string,
  schemes: readonly string[],
): string[] {
  const v = o[key];
  if (!Array.isArray(v)) {
    throw new ConfigError(`${path}.${key} must be an array of strings`);
  }
  return v.map((url, i) => {
    const where = `${path}.${key}[${i}]`;
    if (typeof url !== "string" || url.length === 0) {
      throw new ConfigError(`${where} must be a non-empty string`);
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ConfigError(`${where} is not a valid URL: ${url}`);
    }
    if (!schemes.includes(parsed.protocol)) {
      const want = schemes.map((s) => s.replace(":", "")).join(" or ");
      throw new ConfigError(`${where} must use ${want} (got "${url}")`);
    }
    return url;
  });
}

const CHAIN_KEYS = [
  "name",
  "slug",
  "family",
  "chainId",
  "upstreams",
  "wsUpstreams",
  "requestTimeoutMs",
  "maxAttempts",
  "maxLagBlocks",
] as const;

function parseChain(raw: unknown, i: number): ChainConfig {
  const path = `chains[${i}]`;
  if (!isObject(raw)) throw new ConfigError(`${path} must be an object`);
  rejectUnknownKeys(raw, CHAIN_KEYS, path);

  const upstreams = reqUrlArray(raw, "upstreams", path, ["http:", "https:"]);
  if (upstreams.length === 0) {
    throw new ConfigError(`${path}.upstreams must not be empty`);
  }
  const wsUpstreams =
    raw.wsUpstreams === undefined
      ? undefined
      : reqUrlArray(raw, "wsUpstreams", path, ["ws:", "wss:"]);

  const family = optFamily(raw, "family", path);
  // EVM chains are identified by a numeric chain ID; other families have no
  // such notion, so it is optional for them — but still checked when present.
  // Chain IDs are positive; cap at 2^53-1 to stay in safe-integer range.
  const chainId =
    family === "evm" || raw.chainId !== undefined
      ? reqIntInRange(raw, "chainId", path, 1, Number.MAX_SAFE_INTEGER)
      : undefined;

  return {
    name: reqString(raw, "name", path),
    slug: reqSlug(raw, "slug", path),
    family,
    chainId,
    upstreams,
    wsUpstreams,
    requestTimeoutMs: reqIntAtLeast(raw, "requestTimeoutMs", path, 1),
    maxAttempts: reqIntAtLeast(raw, "maxAttempts", path, 1),
    maxLagBlocks:
      raw.maxLagBlocks === undefined
        ? undefined
        : reqIntAtLeast(raw, "maxLagBlocks", path, 0),
  };
}

const BREAKER_KEYS = ["failureThreshold", "cooldownMs", "halfOpenMaxProbes"] as const;

function parseBreaker(raw: unknown): BreakerConfig {
  if (!isObject(raw)) throw new ConfigError("breaker must be an object");
  rejectUnknownKeys(raw, BREAKER_KEYS, "breaker");
  return {
    failureThreshold: reqIntAtLeast(raw, "failureThreshold", "breaker", 1),
    cooldownMs: reqIntAtLeast(raw, "cooldownMs", "breaker", 0),
    halfOpenMaxProbes: reqIntAtLeast(raw, "halfOpenMaxProbes", "breaker", 1),
  };
}

function parseChains(raw: unknown): ChainConfig[] {
  if (!Array.isArray(raw)) throw new ConfigError("chains must be an array");
  if (raw.length === 0) throw new ConfigError("chains must not be empty");
  const chains = raw.map((c, i) => parseChain(c, i));
  const seen = new Set<string>();
  for (const c of chains) {
    if (seen.has(c.slug)) throw new ConfigError(`duplicate chain slug: ${c.slug}`);
    seen.add(c.slug);
  }
  return chains;
}

const ROOT_KEYS = [
  "port",
  "healthCheckIntervalMs",
  "maxLagBlocks",
  "breaker",
  "chains",
] as const;

/** Valid TCP port range. */
const MIN_PORT = 1;
const MAX_PORT = 65_535;

/**
 * Validate a complete config object (as found in `default.config.json`). Every
 * field is required and range-checked. Unknown keys are rejected. Throws
 * {@link ConfigError} on any missing, ill-typed, or out-of-range value so a
 * broken baseline fails loudly at startup.
 */
export function parseAppConfig(raw: unknown): AppConfig {
  if (!isObject(raw)) throw new ConfigError("config root must be an object");
  rejectUnknownKeys(raw, ROOT_KEYS, "config");
  return {
    port: reqIntInRange(raw, "port", "config", MIN_PORT, MAX_PORT),
    healthCheckIntervalMs: reqIntAtLeast(raw, "healthCheckIntervalMs", "config", 1),
    maxLagBlocks: reqIntAtLeast(raw, "maxLagBlocks", "config", 0),
    breaker: parseBreaker(raw.breaker),
    chains: parseChains(raw.chains),
  };
}

/**
 * Overlay a partial user config (`config.json`) onto a fully-parsed base
 * (`default.config.json`). Every top-level field is optional: a file may
 * override only `chains`, only `port`, etc. Unknown keys are rejected (so a
 * typo fails loudly). Providing `chains` replaces the list wholesale (not
 * merged per-chain). Values are range-checked exactly as the baseline is.
 * Throws {@link ConfigError} on any mismatch.
 */
export function mergeConfig(base: AppConfig, raw: unknown): AppConfig {
  if (!isObject(raw)) throw new ConfigError("config root must be an object");
  rejectUnknownKeys(raw, ROOT_KEYS, "config");
  const out: AppConfig = {
    ...base,
    breaker: { ...base.breaker },
    chains: base.chains.map((c) => ({ ...c })),
  };

  if (raw.port !== undefined) {
    out.port = reqIntInRange(raw, "port", "config", MIN_PORT, MAX_PORT);
  }
  if (raw.healthCheckIntervalMs !== undefined) {
    out.healthCheckIntervalMs = reqIntAtLeast(raw, "healthCheckIntervalMs", "config", 1);
  }
  if (raw.maxLagBlocks !== undefined) {
    out.maxLagBlocks = reqIntAtLeast(raw, "maxLagBlocks", "config", 0);
  }
  if (raw.breaker !== undefined) out.breaker = parseBreaker(raw.breaker);
  if (raw.chains !== undefined) out.chains = parseChains(raw.chains);
  return out;
}

/**
 * Directory the config files live in: the nearest ancestor of this module that
 * contains `default.config.json`. Walking up from the module URL (not the
 * process cwd) means the `sae` command finds its bundled config regardless of
 * where it's launched from, whether running as `dist/index.js` in an installed
 * package or during tests. Falls back to the immediate parent directory.
 */
export function configDir(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  const { root } = parsePath(dir);
  while (true) {
    if (existsSync(join(dir, DEFAULT_CONFIG_FILE))) return dir;
    if (dir === root) break;
    dir = dirname(dir);
  }
  return join(start, "..");
}

/** Read + JSON-parse a file, mapping fs/parse errors to {@link ConfigError}. */
async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(`config file not found: ${path}`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`failed to read ${path}: ${msg}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`failed to parse ${path}: ${msg}`);
  }
}

/** Whether a file exists and is readable. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** Apply `PORT` / `HEALTH_CHECK_INTERVAL_MS` env overrides, if set. */
function applyEnv(cfg: AppConfig): AppConfig {
  if (process.env.PORT !== undefined) {
    const n = Number(process.env.PORT);
    if (Number.isFinite(n)) cfg.port = n;
  }
  if (process.env.HEALTH_CHECK_INTERVAL_MS !== undefined) {
    const n = Number(process.env.HEALTH_CHECK_INTERVAL_MS);
    if (Number.isFinite(n)) cfg.healthCheckIntervalMs = n;
  }
  return cfg;
}

/**
 * Load the runtime config. Reads the committed `default.config.json` as the
 * baseline, overlays the gitignored `config.json` when present, then applies
 * `PORT` / `HEALTH_CHECK_INTERVAL_MS` env overrides. Both files are read at
 * runtime from {@link configDir}, so the installed package ships its defaults
 * beside the code rather than embedding them at build time.
 *
 * @param explicitPath value of `--config` (overrides the user `config.json`
 *   location), or null to use the default resolution.
 * @throws {ConfigError} if the default file is missing/invalid, or a resolved
 *   user file is missing (when explicit), unparseable, or fails validation.
 */
export async function loadConfig(explicitPath: string | null = null): Promise<AppConfig> {
  const dir = configDir();
  const base = parseAppConfig(await readJson(join(dir, DEFAULT_CONFIG_FILE)));

  let userPath: string | null = null;
  if (explicitPath) {
    userPath = explicitPath;
  } else if (process.env.SAE_CONFIG) {
    userPath = process.env.SAE_CONFIG;
  } else {
    const candidate = join(dir, USER_CONFIG_FILE);
    if (await fileExists(candidate)) userPath = candidate;
  }

  const merged = userPath ? mergeConfig(base, await readJson(userPath)) : base;
  return applyEnv(merged);
}
