// src/lib/state.ts

export type TxRef = {
  at: string;
  amount: number;
  tx: string | null;
  url?: string | null; // optional solscan URL
};

export type AirdropRef = {
  at: string;
  totalSentUi?: number;
  count?: number;
  cycleId?: string | null;
};

export type OpsState = {
  lastClaim: TxRef | null;
  lastSwap: TxRef | null;
  // NEW: used by FE + /api/admin/ops to show/accumulate totals
  lastAirdrop?: AirdropRef | null;
  totalAirdroppedUi?: number; // cumulative tokens airdropped across unique cycles
};

export type Metrics = {
  cacheHits: number;
  cacheMisses: number;
  lastRpcMs: number | null;
  lastSnapshotAt: string | null;
};

export type Totals = {
  totalCoinAirdropped: number; // kept for compatibility
  totalSolDropped: number;
};

// --------- global singletons (safe across hot reloads) ---------
const g = globalThis as any;

if (!g.__BANANA_OPS__) {
  g.__BANANA_OPS__ = {
    lastClaim: null,
    lastSwap: null,
    lastAirdrop: null,
    totalAirdroppedUi: 0,
  } as OpsState;
}
if (!g.__BANANA_METRICS__) {
  g.__BANANA_METRICS__ = {
    cacheHits: 0,
    cacheMisses: 0,
    lastRpcMs: null,
    lastSnapshotAt: null,
  } as Metrics;
}
if (!g.__BANANA_TOTALS__) {
  g.__BANANA_TOTALS__ = {
    totalCoinAirdropped: 0,
    totalSolDropped: 0,
  } as Totals;
}

// NEW: dedupe set for airdrop cycleIds so totals don't double-count
if (!g.__AIRDROP_CYCLES__) {
  g.__AIRDROP_CYCLES__ = new Set<string>();
}

// --------- exports consumed by API/worker/UI ---------
export const OPS: OpsState = g.__BANANA_OPS__;
export const METRICS: Metrics = g.__BANANA_METRICS__;
export const TOTALS: Totals = g.__BANANA_TOTALS__;
export const AIRDROP_CYCLES: Set<string> = g.__AIRDROP_CYCLES__;
