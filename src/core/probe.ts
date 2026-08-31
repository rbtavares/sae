import type { ChainFamily } from "../config.js";

/**
 * How to ask an upstream for its current head during a health check. Chains
 * differ in both the method name and the shape of the answer (EVM returns a
 * hex quantity, Solana a decimal slot number), so the call and the parse are
 * defined together rather than branching on the family at every use site.
 */
export interface ProbeSpec {
  method: string;
  params: unknown[];
  /**
   * Read the head block/slot out of a successful probe `result`, returning null
   * when the value is unusable. A null `parseHead` means the probe carries no
   * head information at all and only serves as a liveness/latency sample.
   */
  parseHead: ((result: unknown) => bigint | null) | null;
}

/** `eth_blockNumber` answers with a 0x-prefixed hex quantity. */
export const EVM_PROBE: ProbeSpec = {
  method: "eth_blockNumber",
  params: [],
  parseHead: (result) => {
    if (typeof result !== "string") return null;
    try {
      return BigInt(result);
    } catch {
      return null;
    }
  },
};

/**
 * Solana over HTTP: `getSlot` answers with a plain decimal number. We ask for
 * `confirmed` rather than the default `finalized` commitment because finalized
 * trails the tip by ~32 slots on every node simultaneously, which masks the
 * real divergence between upstreams that the lag ranking exists to detect.
 */
export const SOLANA_HTTP_PROBE: ProbeSpec = {
  method: "getSlot",
  params: [{ commitment: "confirmed" }],
  parseHead: (result) =>
    typeof result === "number" && Number.isSafeInteger(result) && result >= 0
      ? BigInt(result)
      : null,
};

/**
 * Solana over WebSocket: the pubsub endpoint implements *only* the
 * `*Subscribe`/`*Unsubscribe` methods, so `getSlot` is unavailable there.
 * `slotSubscribe` proves the socket is alive and yields a latency sample, but
 * its reply is a *subscription id* (e.g. `{"result": 3354946}`), not a slot —
 * parsing it as a head would poison the lag calculation with a meaningless
 * number. Hence `parseHead: null`. Nothing is lost: WS ranking deliberately
 * ignores lag (see `ChainBalancer.orderedWsUpstreams`).
 */
export const SOLANA_WS_PROBE: ProbeSpec = {
  method: "slotSubscribe",
  params: [],
  parseHead: null,
};

export function httpProbeFor(family: ChainFamily): ProbeSpec {
  return family === "solana" ? SOLANA_HTTP_PROBE : EVM_PROBE;
}

export function wsProbeFor(family: ChainFamily): ProbeSpec {
  return family === "solana" ? SOLANA_WS_PROBE : EVM_PROBE;
}
