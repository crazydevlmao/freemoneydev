// src/app/api/admin/ops/route.ts
export const runtime = "edge";
export const preferredRegion = "iad1";

import { OPS, type TxRef, type AirdropRef } from "@/lib/state";

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

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

    const {
      lastClaim,
      lastSwap,
      lastAirdrop,
    } = body as {
      lastClaim?: Partial<TxRef> | null;
      lastSwap?: Partial<TxRef> | null;
      lastAirdrop?: Partial<AirdropRef> | null;
    };

    // ---- lastClaim (SOL creator-fee delta) ----
    if (lastClaim && typeof lastClaim.amount === "number") {
      const clean: TxRef = {
        at: lastClaim.at ?? new Date().toISOString(),
        amount: Number(lastClaim.amount),
        tx: lastClaim.tx ?? null,
      };
      OPS.lastClaim = clean;
    }

    // ---- lastSwap (optional) ----
    if (lastSwap && typeof lastSwap.amount === "number") {
      const clean: TxRef = {
        at: lastSwap.at ?? new Date().toISOString(),
        amount: Number(lastSwap.amount),
        tx: lastSwap.tx ?? null,
      };
      OPS.lastSwap = clean;
    }

    // ---- lastAirdrop (token “given away”) + cumulative ----
    if (lastAirdrop && typeof lastAirdrop.totalSentUi === "number") {
      const clean: AirdropRef = {
        at: lastAirdrop.at ?? new Date().toISOString(),
        totalSentUi: Number(lastAirdrop.totalSentUi),
        count: typeof lastAirdrop.count === "number" ? lastAirdrop.count : undefined,
        cycleId: typeof lastAirdrop.cycleId === "string" ? lastAirdrop.cycleId : undefined,
      };

      const alreadyCounted =
        !!(OPS.lastAirdrop &&
           clean.cycleId &&
           OPS.lastAirdrop.cycleId === clean.cycleId);

      OPS.lastAirdrop = clean;

      if (!alreadyCounted) {
        OPS.totalAirdroppedUi = (OPS.totalAirdroppedUi ?? 0) + clean.totalSentUi;
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
