export interface ChainConfig {
  /** Human-readable name. */
  name: string;
  /** URL path segment, e.g. "eth" -> POST /eth */
  slug: string;
  chainId: number;
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
  /** Upstreams more than this many blocks behind the best-known head are deprioritized. */
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
  "chainId",
  "upstreams",
  "wsUpstreams",
  "requestTimeoutMs",
  "maxAttempts",
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

  return {
    name: reqString(raw, "name", path),
    slug: reqSlug(raw, "slug", path),
    // Chain IDs are positive; cap at 2^53-1 to stay in safe-integer range.
    chainId: reqIntInRange(raw, "chainId", path, 1, Number.MAX_SAFE_INTEGER),
    upstreams,
    wsUpstreams,
    requestTimeoutMs: reqIntAtLeast(raw, "requestTimeoutMs", path, 1),
    maxAttempts: reqIntAtLeast(raw, "maxAttempts", path, 1),
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
 * Directory the config files live in: alongside the running binary/script.
 *
 * When compiled with `bun build --compile`, `import.meta.dir` resolves inside
 * the embedded virtual filesystem (`/$bunfs/...`), where the sibling JSON files
 * don't exist. In that case we fall back to the directory of the real
 * executable (`process.execPath`) so the binary finds the `default.config.json`
 * shipped next to it. Run from source, `import.meta.dir` is the `src/` dir's
 * parent's `src` — i.e. next to `config.ts` — so we resolve relative to the
 * project root instead (one level up).
 */
export function configDir(): string {
  const metaDir = import.meta.dir;
  // Compiled single-file binary: files live next to the executable.
  if (metaDir.startsWith("/$bunfs") || metaDir.startsWith("B:\\~BUN")) {
    const exe = process.execPath;
    const sep =
      exe.lastIndexOf("/") === -1 ? exe.lastIndexOf("\\") : exe.lastIndexOf("/");
    return sep === -1 ? "." : exe.slice(0, sep);
  }
  // Run from source (src/config.ts): config files live in the project root.
  return `${metaDir}/..`;
}

async function readJson(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new ConfigError(`config file not found: ${path}`);
  }
  try {
    return JSON.parse(await file.text());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`failed to parse ${path}: ${msg}`);
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
 * runtime via `Bun.file` from {@link configDir}, so a compiled binary ships
 * with its defaults beside it rather than embedding them at build time.
 *
 * @param explicitPath value of `--config` (overrides the user `config.json`
 *   location), or null to use the default resolution.
 * @throws {ConfigError} if the default file is missing/invalid, or a resolved
 *   user file is missing (when explicit), unparseable, or fails validation.
 */
export async function loadConfig(explicitPath: string | null = null): Promise<AppConfig> {
  const dir = configDir();
  const base = parseAppConfig(await readJson(`${dir}/${DEFAULT_CONFIG_FILE}`));

  let userPath: string | null = null;
  if (explicitPath) {
    userPath = explicitPath;
  } else if (process.env.SAE_CONFIG) {
    userPath = process.env.SAE_CONFIG;
  } else {
    const candidate = `${dir}/${USER_CONFIG_FILE}`;
    if (await Bun.file(candidate).exists()) userPath = candidate;
  }

  const merged = userPath ? mergeConfig(base, await readJson(userPath)) : base;
  return applyEnv(merged);
}
