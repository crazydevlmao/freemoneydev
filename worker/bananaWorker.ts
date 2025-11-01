// /worker/bananaWorker.ts
/* Node 18+ runtime (long-lived process) */

import {
  Connection, PublicKey, Keypair, Transaction, VersionedTransaction,
  LAMPORTS_PER_SOL, ComputeBudgetProgram
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getMint,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction
} from "@solana/spl-token";
import bs58 from "bs58";

/* ================= CONFIG ================= */
const CYCLE_MINUTES = 1;
const TRACKED_MINT = process.env.TRACKED_MINT || "";
const REWARD_WALLET = process.env.REWARD_WALLET || "";
const DEV_WALLET_PRIVATE_KEY = process.env.DEV_WALLET_PRIVATE_KEY || "";
const HELIUS_RPC = process.env.HELIUS_RPC || "";
const QUICKNODE_RPC = process.env.QUICKNODE_RPC || "";
const PUMPORTAL_KEY = (process.env.PUMPORTAL_KEY || "").trim();
const PUMPORTAL_BASE = "https://pumpportal.fun";

const JUP_BASE = process.env.JUP_BASE || "https://lite-api.jup.ag/swap/v1";
const JUP_QUOTE = `${JUP_BASE}/quote`;
const JUP_SWAP = `${JUP_BASE}/swap`;

const JUP_MAX_TRIES = Number(process.env.JUP_MAX_TRIES ?? 6);
const JUP_429_SLEEP_MS = Number(process.env.JUP_429_SLEEP_MS ?? 1000);
const PRIORITY_FEE_MICRO_LAMPORTS = Number(process.env.PRIORITY_FEE_MICRO_LAMPORTS ?? 5_000);
const COMPUTE_UNIT_LIMIT = Number(process.env.COMPUTE_UNIT_LIMIT ?? 400_000);

if (!TRACKED_MINT || !REWARD_WALLET || !DEV_WALLET_PRIVATE_KEY)
  throw new Error("Missing TRACKED_MINT, REWARD_WALLET, or DEV_WALLET_PRIVATE_KEY");
if (!HELIUS_RPC) throw new Error("Missing HELIUS_RPC");

/* ================= CONNECTION ================= */
const RPCS = [HELIUS_RPC, QUICKNODE_RPC].filter(Boolean);
let rpcIdx = 0;
function newConn() { return new Connection(RPCS[rpcIdx]!, "confirmed"); }
function rotateConn() { rpcIdx = (rpcIdx + 1) % RPCS.length; return newConn(); }
let connection = newConn();

function toKeypair(secret: string) {
  try { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret))); }
  catch { return Keypair.fromSecretKey(bs58.decode(secret)); }
}
const devWallet = toKeypair(DEV_WALLET_PRIVATE_KEY);
const trackedMintPk = new PublicKey(TRACKED_MINT);

/* ================= UTILS ================= */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function looksRetryable(m: string) {
  return /429|too many requests|rate.?limit|timeout|temporar|ECONN|ETIMEDOUT|blockhash|FetchError|TLS|ENOTFOUND|EAI_AGAIN|Connection closed/i.test(m);
}
async function withRetries<T>(fn: (c: Connection) => Promise<T>, tries = 5) {
  let c = connection, last: any;
  for (let i = 0; i < tries; i++) {
    try { return await fn(c); }
    catch (e: any) {
      last = e;
      const msg = String(e?.message || e);
      if (i < tries - 1 && looksRetryable(msg) && RPCS.length > 1) {
        c = (connection = rotateConn());
        await sleep(250 * (i + 1));
        continue;
      }
      break;
    }
  }
  throw last;
}

/* ================= PUMPPORTAL HELPERS ================= */
function portalUrl(path: string) {
  const u = new URL(path, PUMPORTAL_BASE);
  if (PUMPORTAL_KEY && !u.searchParams.has("api-key")) u.searchParams.set("api-key", PUMPORTAL_KEY);
  return u.toString();
}
async function callPumportal(path: string, body: any, idemKey: string) {
  const url = portalUrl(path);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${PUMPORTAL_KEY}`,
      "Idempotency-Key": idemKey,
    },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  let json: any = {};
  try { json = txt ? JSON.parse(txt) : {}; } catch {}
  return { res, json };
}
function extractSig(j: any): string | null {
  return j?.signature || j?.tx || j?.txid || j?.txId || j?.result || j?.sig || null;
}

/* ================= BALANCES ================= */
async function getSolBalance(conn: Connection, pubkey: PublicKey) {
  return (await conn.getBalance(pubkey, "confirmed")) / LAMPORTS_PER_SOL;
}

async function tokenBalanceBase(owner: PublicKey, mint: PublicKey): Promise<bigint> {
  const resp = await withRetries((c: Connection) =>
    c.getParsedTokenAccountsByOwner(owner, { mint }, "confirmed")
  );
  let total = 0n;
  for (const it of (resp as any).value) {
    const amtStr = (it as any).account.data.parsed.info.tokenAmount.amount as string;
    total += BigInt(amtStr || "0");
  }
  return total;
}

/* ================= JUPITER ================= */
async function fetchJsonQuiet(url: string, opts: RequestInit, timeoutMs = 6000) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal as any });
    if (r.status === 429) throw new Error("HTTP_429");
    if (!r.ok) throw new Error(String(r.status));
    return await r.json();
  } finally {
    clearTimeout(id);
  }
}

async function jupQuoteSolToToken(outMint: string, solUiAmount: number, slippageBps: number) {
  const amountLamports = Math.max(1, Math.floor(solUiAmount * LAMPORTS_PER_SOL));
  const url =
    `${JUP_QUOTE}?inputMint=So11111111111111111111111111111111111111112&outputMint=${outMint}&amount=${amountLamports}` +
    `&slippageBps=${slippageBps}&enableDexes=pump,meteora,raydium&onlyDirectRoutes=false&swapMode=ExactIn`;
  for (let i = 0; i < JUP_MAX_TRIES; i++) {
    try {
      const j: any = await fetchJsonQuiet(url, {}, 6000);
      if (!j?.routePlan?.length) throw new Error("no_route");
      return j;
    } catch (e: any) {
      const m = String(e?.message || e);
      if (m === "HTTP_429" || looksRetryable(m)) {
        await sleep(JUP_429_SLEEP_MS * (i + 1));
        continue;
      }
      if (i === JUP_MAX_TRIES - 1) throw e;
    }
  }
  throw new Error("quote_failed");
}

async function jupSwap(conn: Connection, signer: Keypair, quoteResp: any) {
  let q = quoteResp; // allow refreshing the quote on 0x1771
  for (let i = 0; i < JUP_MAX_TRIES; i++) {
    try {
      const swapReq = {
        quoteResponse: q,
        userPublicKey: signer.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
        enableAutoSlippage: true
      };

      const jr: any = await fetchJsonQuiet(
        JUP_SWAP,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(swapReq) },
        8000
      );
      const txBytes = Uint8Array.from(Buffer.from(jr.swapTransaction, "base64"));
      const tx = VersionedTransaction.deserialize(txBytes);
      tx.sign([signer]);
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await conn.confirmTransaction(sig, "confirmed");
      return sig;
    } catch (e: any) {
      const m = String(e?.message || e);

      // Try to print program logs if present
      try {
        if (e?.logs) console.error("🪵 [JUP LOGS]\n" + (Array.isArray(e.logs) ? e.logs.join("\n") : String(e.logs)));
        else if (e?.getLogs) {
          const logs = await e.getLogs();
          if (logs) console.error("🪵 [JUP LOGS]\n" + (Array.isArray(logs) ? logs.join("\n") : String(logs)));
        }
      } catch {}

      // Handle transient and rate-limit errors
      if (m === "HTTP_429" || looksRetryable(m)) {
        await sleep(JUP_429_SLEEP_MS * (i + 1));
        continue;
      }

      // Handle Jupiter route invalid or min out not met: refresh quote, then retry
      if (m.includes("0x1771")) {
        try {
          // Derive a fresh quote using the same parameters
          const outMint =
            q?.outputMint || q?.routePlan?.[q?.routePlan?.length - 1]?.swapInfo?.outputMint || TRACKED_MINT;
          // Prefer explicit inAmount from quote if present; fallback to user intent is not changed
          const inLamportsStr = q?.inAmount ?? q?.amount ?? q?.otherAmount;
          const inLamports = typeof inLamportsStr === "string" ? Number(inLamportsStr) : Number(inLamportsStr || 0);
          const solUiAmount = inLamports > 0 ? inLamports / LAMPORTS_PER_SOL : 0;
          if (outMint && solUiAmount > 0) {
            console.warn("⚠️ [JUP] Route failed (0x1771). Fetching fresh quote and retrying...");
            q = await jupQuoteSolToToken(outMint, solUiAmount, 300);
            await sleep(500);
            continue;
          }
        } catch {}
        await sleep(700);
        continue;
      }

      if (i === JUP_MAX_TRIES - 1) throw e;
    }
  }
  throw new Error("swap_failed");
}

/* ================= CLAIM / SWAP / BURN LOOP ================= */
let lastClaimState: null | { claimedSol: number; claimSig: string | null } = null;

async function triggerClaimAtStart() {
  console.log("💰 [CLAIM] Collecting creator fees...");
  const preSol = await getSolBalance(connection, devWallet.publicKey);
  const { res, json } = await callPumportal(
    "/api/trade",
    { action: "collectCreatorFee", priorityFee: 0.000001, pool: "pump", mint: TRACKED_MINT },
    `claim:${Date.now()}`
  );
  if (!res.ok) throw new Error(`Claim failed ${res.status}`);
  const claimSig = extractSig(json);
  await sleep(3000);
  const postSol = await getSolBalance(connection, devWallet.publicKey);
  const delta = Math.max(0, parseFloat((postSol - preSol).toFixed(6)));
  console.log(delta > 0 ? `🟢 [CLAIM] Claimed ${delta} SOL | Tx: ${claimSig}` : `⚪ [CLAIM] 0 SOL change | Tx: ${claimSig}`);
  lastClaimState = { claimedSol: delta, claimSig };
}

async function triggerSwapAndBurn() {
  console.log("🔄 [SWAP] Initiating swap check...");

  const claimed = lastClaimState?.claimedSol ?? 0;
  if (claimed <= 0.000001) {
    console.log("⚪ [SWAP] Skipped — no new SOL claimed this cycle.");
    return;
  }

  const spend = claimed * 0.7;
  console.log(`💧 [SWAP] Preparing to swap ${spend.toFixed(6)} SOL from last claim of ${claimed.toFixed(6)} SOL`);

  try {
    // Swap SOL → TRACKED_MINT
    const q = await jupQuoteSolToToken(TRACKED_MINT, spend, 300);
    const sig = await jupSwap(connection, devWallet, q);
    console.log(`✅ [SWAP] Swapped ${spend.toFixed(4)} SOL → ${TRACKED_MINT} | Tx: ${sig}`);

    // Burn all TRACKED_MINT held
    console.log("🔥 [BURN] Burning all TRACKED_MINT tokens...");
    const mint = new PublicKey(TRACKED_MINT);
    const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_PROGRAM_ID);
    const decimals = mintInfo.decimals;
    const fromAta = getAssociatedTokenAddressSync(mint, devWallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const bal = await tokenBalanceBase(devWallet.publicKey, mint);

    if (bal > 0n) {
      const burnIx = createBurnCheckedInstruction(
        fromAta,
        mint,
        devWallet.publicKey,
        Number(bal),
        decimals,
        [],
        TOKEN_PROGRAM_ID
      );
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICRO_LAMPORTS }),
        burnIx
      );
      tx.feePayer = devWallet.publicKey;
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.sign(devWallet);
      const burnSig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });

      // robust confirmation for congested network
      await withRetries(async c => {
        await c.confirmTransaction(burnSig, "finalized");
        return true;
      }, 3);

      console.log(`🔥 [BURN] Burned ${(Number(bal) / 10 ** decimals).toFixed(6)} TRACKED_MINT | Tx: ${burnSig}`);
    } else {
      console.log("⚪ [BURN] No TRACKED_MINT to burn.");
    }
  } catch (e: any) {
    console.error(`❌ [SWAP/BURN] Failed: ${e?.message || e}`);
  }
}

async function loop() {
  while (true) {
    try {
      console.log("\n================= 🚀 NEW CYCLE =================");
      await triggerClaimAtStart();
      console.log("⏳ 10s pause → next: SWAP & BURN");
      await sleep(10_000);
      await triggerSwapAndBurn();
      console.log("🕐 30s cooldown before next cycle...");
      await sleep(30_000);
    } catch (e: any) {
      console.error("💥 [CYCLE ERROR]", e?.message || e);
      await sleep(5000);
    }
  }
}

loop().catch(e => {
  console.error("💣 bananaWorker crashed", e?.message || e);
  process.exit(1);
});
