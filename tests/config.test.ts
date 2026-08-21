import { describe, expect, test } from "./helpers.js";
import {
  type AppConfig,
  ConfigError,
  loadConfig,
  mergeConfig,
  parseAppConfig,
} from "../src/config.js";

/** A minimal, valid complete config used as the merge base in tests. */
const base: AppConfig = {
  port: 8545,
  healthCheckIntervalMs: 30_000,
  maxLagBlocks: 5,
  breaker: { failureThreshold: 3, cooldownMs: 30_000, halfOpenMaxProbes: 1 },
  chains: [
    {
      name: "Ethereum",
      slug: "eth",
      family: "evm",
      chainId: 1,
      upstreams: ["https://rpc.mevblocker.io"],
      requestTimeoutMs: 5000,
      maxAttempts: 6,
    },
  ],
};

describe("parseAppConfig", () => {
  test("accepts a complete config", () => {
    const out = parseAppConfig(structuredClone(base));
    expect(out).toEqual(base);
  });

  test("rejects a non-object root", () => {
    expect(() => parseAppConfig(42)).toThrow(ConfigError);
    expect(() => parseAppConfig(null)).toThrow(ConfigError);
    expect(() => parseAppConfig([])).toThrow(ConfigError);
  });

  test("rejects a missing required scalar", () => {
    const { port, ...rest } = base;
    void port;
    expect(() => parseAppConfig(rest)).toThrow(/port must be a number/);
  });

  test("rejects a missing breaker", () => {
    const { breaker, ...rest } = base;
    void breaker;
    expect(() => parseAppConfig(rest)).toThrow(/breaker must be an object/);
  });

  test("rejects an empty chains array", () => {
    expect(() => parseAppConfig({ ...base, chains: [] })).toThrow(/must not be empty/);
  });

  test("rejects duplicate chain slugs", () => {
    const chain = base.chains[0]!;
    expect(() => parseAppConfig({ ...base, chains: [chain, { ...chain }] })).toThrow(
      /duplicate chain slug: eth/,
    );
  });
});

describe("mergeConfig", () => {
  test("empty object returns a copy of the base", () => {
    const out = mergeConfig(base, {});
    expect(out).toEqual(base);
    expect(out).not.toBe(base);
    expect(out.breaker).not.toBe(base.breaker);
    expect(out.chains).not.toBe(base.chains);
  });

  test("overrides only the provided scalar fields", () => {
    const out = mergeConfig(base, { port: 9000, maxLagBlocks: 12 });
    expect(out.port).toBe(9000);
    expect(out.maxLagBlocks).toBe(12);
    expect(out.healthCheckIntervalMs).toBe(base.healthCheckIntervalMs);
    expect(out.chains).toEqual(base.chains);
  });

  test("replaces chains wholesale when provided", () => {
    const out = mergeConfig(base, {
      chains: [
        {
          name: "Test",
          slug: "test",
          chainId: 2,
          upstreams: ["https://example.com"],
          wsUpstreams: ["wss://example.com"],
          requestTimeoutMs: 1000,
          maxAttempts: 2,
        },
      ],
    });
    expect(out.chains).toHaveLength(1);
    expect(out.chains[0]!.slug).toBe("test");
    expect(out.chains[0]!.wsUpstreams).toEqual(["wss://example.com"]);
  });

  test("overrides breaker as a whole object", () => {
    const out = mergeConfig(base, {
      breaker: { failureThreshold: 9, cooldownMs: 1, halfOpenMaxProbes: 2 },
    });
    expect(out.breaker.failureThreshold).toBe(9);
  });

  test("rejects unknown top-level keys", () => {
    expect(() => mergeConfig(base, { nope: 123 })).toThrow(/unknown key "nope"/);
  });

  test("allows a $schema key", () => {
    const out = mergeConfig(base, { $schema: "./sae.schema.json", port: 9001 });
    expect(out.port).toBe(9001);
  });

  test("rejects a non-number port override", () => {
    expect(() => mergeConfig(base, { port: "8545" })).toThrow(/port must be a number/);
  });

  test("rejects an empty chains override", () => {
    expect(() => mergeConfig(base, { chains: [] })).toThrow(/must not be empty/);
  });

  test("rejects a chain missing required fields", () => {
    expect(() => mergeConfig(base, { chains: [{ slug: "x" }] })).toThrow(ConfigError);
  });
});

describe("value/range validation", () => {
  /** A valid chain, mutated per-test to isolate one bad field. */
  const chain = () => ({
    name: "T",
    slug: "t",
    chainId: 1,
    upstreams: ["https://rpc.example.com"],
    requestTimeoutMs: 1000,
    maxAttempts: 2,
  });
  const withChain = (c: object) => ({ chains: [c] });

  test("rejects a port below 1 or above 65535", () => {
    expect(() => mergeConfig(base, { port: 0 })).toThrow(/between 1 and 65535/);
    expect(() => mergeConfig(base, { port: 70000 })).toThrow(/between 1 and 65535/);
    expect(() => mergeConfig(base, { port: 8080.5 })).toThrow(/between 1 and 65535/);
  });

  test("rejects a non-positive maxAttempts / requestTimeoutMs", () => {
    expect(() => mergeConfig(base, withChain({ ...chain(), maxAttempts: 0 }))).toThrow(
      /maxAttempts must be an integer >= 1/,
    );
    expect(() =>
      mergeConfig(base, withChain({ ...chain(), requestTimeoutMs: 0 })),
    ).toThrow(/requestTimeoutMs must be an integer >= 1/);
  });

  test("rejects a non-integer chainId or one below 1", () => {
    expect(() => mergeConfig(base, withChain({ ...chain(), chainId: 0 }))).toThrow(
      /chainId must be an integer/,
    );
    expect(() => mergeConfig(base, withChain({ ...chain(), chainId: 1.5 }))).toThrow(
      /chainId must be an integer/,
    );
  });

  test("rejects a bad slug", () => {
    expect(() => mergeConfig(base, withChain({ ...chain(), slug: "Eth Main" }))).toThrow(
      /slug must match/,
    );
    expect(() => mergeConfig(base, withChain({ ...chain(), slug: "ETH" }))).toThrow(
      /slug must match/,
    );
  });

  test("rejects a non-http upstream URL", () => {
    expect(() =>
      mergeConfig(base, withChain({ ...chain(), upstreams: ["ftp://x.com"] })),
    ).toThrow(/must use http or https/);
    expect(() =>
      mergeConfig(base, withChain({ ...chain(), upstreams: ["not a url"] })),
    ).toThrow(/is not a valid URL/);
    expect(() =>
      mergeConfig(base, withChain({ ...chain(), upstreams: ["wss://x.com"] })),
    ).toThrow(/must use http or https/);
  });

  test("rejects a non-ws wsUpstream URL", () => {
    expect(() =>
      mergeConfig(base, withChain({ ...chain(), wsUpstreams: ["https://x.com"] })),
    ).toThrow(/must use ws or wss/);
  });

  test("accepts valid ws and wss upstreams", () => {
    const out = mergeConfig(
      base,
      withChain({ ...chain(), wsUpstreams: ["wss://a.com", "ws://b.com"] }),
    );
    expect(out.chains[0]!.wsUpstreams).toEqual(["wss://a.com", "ws://b.com"]);
  });

  test("rejects unknown keys inside a chain", () => {
    expect(() => mergeConfig(base, withChain({ ...chain(), maxAttempt: 3 }))).toThrow(
      /unknown key "maxAttempt"/,
    );
  });

  test("rejects unknown keys inside breaker", () => {
    expect(() =>
      mergeConfig(base, {
        breaker: { failureThreshold: 1, cooldownMs: 1, halfOpenMaxProbes: 1, extra: 1 },
      }),
    ).toThrow(/unknown key "extra"/);
  });

  test("rejects a negative per-chain maxLagBlocks", () => {
    expect(() => mergeConfig(base, withChain({ ...chain(), maxLagBlocks: -1 }))).toThrow(
      /maxLagBlocks must be an integer >= 0/,
    );
  });

  test("accepts a per-chain maxLagBlocks override", () => {
    const out = mergeConfig(base, withChain({ ...chain(), maxLagBlocks: 50 }));
    expect(out.chains[0]!.maxLagBlocks).toBe(50);
    // The global default is untouched by a chain-level override.
    expect(out.maxLagBlocks).toBe(base.maxLagBlocks);
  });
});

describe("chain family", () => {
  const withChain = (c: object) => ({ chains: [c] });
  const solana = () => ({
    name: "Solana",
    slug: "sol",
    family: "solana",
    upstreams: ["https://api.mainnet-beta.solana.com"],
    requestTimeoutMs: 5000,
    maxAttempts: 5,
  });

  test("defaults to evm when omitted, keeping existing configs valid", () => {
    const out = mergeConfig(
      base,
      withChain({
        name: "T",
        slug: "t",
        chainId: 1,
        upstreams: ["https://rpc.example.com"],
        requestTimeoutMs: 1000,
        maxAttempts: 2,
      }),
    );
    expect(out.chains[0]!.family).toBe("evm");
  });

  test("accepts solana without a chainId", () => {
    const out = mergeConfig(base, withChain(solana()));
    expect(out.chains[0]!.family).toBe("solana");
    expect(out.chains[0]!.chainId).toBe(undefined);
  });

  test("still requires chainId for evm chains", () => {
    const { chainId, ...noId } = { ...solana(), family: "evm", chainId: 1 };
    void chainId;
    expect(() => mergeConfig(base, withChain(noId))).toThrow(/chainId must be a number/);
  });

  test("validates a chainId supplied alongside a non-evm family", () => {
    expect(() => mergeConfig(base, withChain({ ...solana(), chainId: 0 }))).toThrow(
      /chainId must be an integer/,
    );
  });

  test("rejects an unknown family", () => {
    expect(() => mergeConfig(base, withChain({ ...solana(), family: "sui" }))).toThrow(
      /family must be one of: evm, solana/,
    );
  });
});

describe("loadConfig", () => {
  test("loads the shipped default.config.json with unique chain slugs", async () => {
    const cfg = await loadConfig();
    expect(cfg.chains.length).toBeGreaterThan(0);
    const slugs = cfg.chains.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(cfg.breaker.failureThreshold).toBeGreaterThan(0);
  });

  test("every shipped chain has a valid family, and evm ones a chainId", async () => {
    const cfg = await loadConfig();
    for (const c of cfg.chains) {
      expect(["evm", "solana"].includes(c.family)).toBe(true);
      if (c.family === "evm") expect(typeof c.chainId).toBe("number");
    }
  });

  test("ships a Solana chain with no chainId", async () => {
    const cfg = await loadConfig();
    const sol = cfg.chains.find((c) => c.slug === "sol");
    expect(sol?.family).toBe("solana");
    expect(sol?.chainId).toBe(undefined);
    expect((sol?.upstreams.length ?? 0) > 0).toBe(true);
  });

  test("throws when an explicit user config file is missing", async () => {
    await expect(loadConfig("/tmp/does-not-exist-sae.json")).rejects.toThrow(
      /config file not found/,
    );
  });
});
