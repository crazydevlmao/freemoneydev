// src/app/api/admin/ops/route.ts
export const runtime = "edge";
export const preferredRegion = "iad1";

import { OPS, type TxRef } from "@/lib/state";

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

type AirdropRef = {
  at?: string;
  totalSentUi?: number;
  count?: number;
  cycleId?: string;
};

export async function POST(req: Request) {
  const auth =
    req.headers.get("x-admin-secret") ||
    new URL(req.url).searchParams.get("k") ||
    "";

  if (!ADMIN_SECRET || auth !== ADMIN_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { lastClaim, lastSwap, lastAirdrop } = body as {
      lastClaim?: TxRef | null;
      lastSwap?: TxRef | null;
      lastAirdrop?: AirdropRef | null;
    };

    // Latest claim/swap passthrough (used by "Latest Drop (SOL)")
    if (lastClaim && typeof lastClaim.amount === "number") OPS.lastClaim = lastClaim;
    if (lastSwap  && typeof lastSwap.amount  === "number") OPS.lastSwap  = lastSwap;

    // Track latest airdrop and accumulate total given away (FREEMONEY given away)
    if (lastAirdrop && typeof lastAirdrop.totalSentUi === "number") {
      const incomingCycleId = lastAirdrop.cycleId ?? null;
      const alreadyCounted =
        incomingCycleId &&
        OPS.lastAirdrop?.cycleId &&
        OPS.lastAirdrop.cycleId === incomingCycleId;

      OPS.lastAirdrop = lastAirdrop;

      if (!alreadyCounted) {
        OPS.totalAirdroppedUi =
          (Number(OPS.totalAirdroppedUi) || 0) + Number(lastAirdrop.totalSentUi);
      }
    }

    return new Response(JSON.stringify({ ok: true, OPS }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch (e: any) {
    return new Response(
      JSON.stringify({ ok: false, error: String(e?.message || e) }),
      { status: 400, headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }
}
