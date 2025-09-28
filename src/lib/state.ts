// src/lib/state.ts

export type TxRef = { at: string; amount: number; tx: string | null };

export type OpsState = {
  lastClaim: TxRef | null;  // latest SOL airdrop (amount in SOL)
  lastSwap:  TxRef | null;  // kept for compatibility; may be null
};

export type Metrics = {
  cacheHits: number;
  cacheMisses: number;
  lastRpcMs: number | null;      // last snapshot RPC latency in ms
  lastSnapshotAt: string | null; // ISO timestamp of last fresh RPC
};

export type Totals = {
  totalCoinAirdropped: number;   // cumulative token airdropped (if used)
  totalSolDropped: number;       // cumulative SOL airdropped
};

// --------- global singletons (safe across hot reloads) ---------
const g = globalThis as any;

if (!g.__BANANA_OPS__) {
  g.__BANANA_OPS__ = { lastClaim: null, lastSwap: null } as OpsState;
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

// --------- exports consumed by API/worker UI ---------
export const OPS: OpsState = g.__BANANA_OPS__;
export const METRICS: Metrics = g.__BANANA_METRICS__;
export const TOTALS: Totals = g.__BANANA_TOTALS__;
