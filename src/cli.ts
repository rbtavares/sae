import type { ChainConfig } from "./config";

export interface CliOptions {
  /** Override listen port, or null to keep the config/env default. */
  port: number | null;
  /** Restrict to these chain slugs, or null to serve all configured chains. */
  chains: string[] | null;
}

const USAGE = `rpc-lb — EVM JSON-RPC load balancer

Usage: bun run src/index.ts [options]

Options:
  -p, --port <number>   Port to listen on (overrides PORT env)
  -c, --chain <slug>    Serve only this chain; repeat for several (e.g. -c eth -c arb)
  -h, --help            Show this help
`;

/**
 * Parse CLI flags. Supports `--flag value`, `--flag=value`, and short `-p`/`-c`.
 * `--chain` is repeatable and also accepts a comma-separated list.
 * Exits the process on a usage error or `--help`.
 */
export function parseArgs(argv: string[]): CliOptions {
  let port: number | null = null;
  const chains: string[] = [];

  const fail = (msg: string): never => {
    process.stderr.write(`error: ${msg}\n\n${USAGE}`);
    process.exit(1);
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // Split `--flag=value` into flag + inline value.
    const eq = arg.indexOf("=");
    const flag = eq !== -1 && arg.startsWith("-") ? arg.slice(0, eq) : arg;
    let inline: string | null =
      eq !== -1 && arg.startsWith("-") ? arg.slice(eq + 1) : null;

    const takeValue = (name: string): string => {
      if (inline !== null) {
        const v = inline;
        inline = null;
        return v;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        fail(`${name} requires a value`);
      }
      i += 1;
      return next!;
    };

    switch (flag) {
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      case "-p":
      case "--port": {
        const raw = takeValue(flag);
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          fail(`invalid port: ${raw}`);
        }
        port = n;
        break;
      }
      case "-c":
      case "--chain": {
        const raw = takeValue(flag);
        for (const slug of raw.split(",")) {
          const s = slug.trim();
          if (s) chains.push(s);
        }
        break;
      }
      default:
        fail(`unknown option: ${arg}`);
    }
  }

  return { port, chains: chains.length > 0 ? chains : null };
}

/**
 * Apply `--chain` filtering to the configured chains. Exits on an unknown slug
 * so a typo fails loudly instead of silently serving nothing.
 */
export function selectChains(all: ChainConfig[], wanted: string[] | null): ChainConfig[] {
  if (wanted === null) return all;
  const bySlug = new Map(all.map((c) => [c.slug, c]));
  const picked: ChainConfig[] = [];
  const seen = new Set<string>();
  for (const slug of wanted) {
    const chain = bySlug.get(slug);
    if (!chain) {
      const available = all.map((c) => c.slug).join(", ");
      process.stderr.write(`error: unknown chain "${slug}". available: ${available}\n`);
      process.exit(1);
    }
    if (!seen.has(slug)) {
      seen.add(slug);
      picked.push(chain);
    }
  }
  return picked;
}
