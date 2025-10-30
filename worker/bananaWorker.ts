// /worker/bananaWorker.ts
/* Node 18+ runtime (long-lived process) */

import {
  Connection, PublicKey, Keypair, Transaction, VersionedTransaction,
  LAMPORTS_PER_SOL, ComputeBudgetProgram
} from "@solana/web3.js";
import {
  // program ids
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  // utils
  getMint,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction
} from "@solana/spl-token";
import bs58 from "bs58";

/* ================= CONFIG ================= */
const CYCLE_MINUTES = 1;
const TRACKED_MINT = process.env.TRACKED_MINT || "";
const AIRDROP_MINT = process.env.AIRDROP_MINT || "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
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
const TX_RETRY_SLEEP_MS = Number(process.env.TX_RETRY_SLEEP_MS ?? 1000);
const FINAL_SINGLE_RETRY_SLEEP_MS = Number(process.env.FINAL_SINGLE_RETRY_SLEEP_MS ?? 1000);

const PRIORITY_FEE_MICRO_LAMPORTS = Number(process.env.PRIORITY_FEE_MICRO_LAMPORTS ?? 5_000);
const COMPUTE_UNIT_LIMIT = Number(process.env.COMPUTE_UNIT_LIMIT ?? 400_000);

// Airdrop throttling to avoid 429s
const AIRDROP_BATCH_SIZE = Number(process.env.AIRDROP_BATCH_SIZE ?? 8);
const AIRDROP_MAX_BATCH_RETRIES = Number(process.env.AIRDROP_MAX_BATCH_RETRIES ?? 3);
const AIRDROP_MIN_TX_GAP_MS = Number(process.env.AIRDROP_MIN_TX_GAP_MS ?? 1200);

if (!TRACKED_MINT || !REWARD_WALLET || !DEV_WALLET_PRIVATE_KEY)
  throw new Error("Missing TRACKED_MINT, REWARD_WALLET, or DEV_WALLET_PRIVATE_KEY");
if (!HELIUS_RPC) throw new Error("Missing HELIUS_RPC");

/* ================= Connection ================= */
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
const holdersMintPk = new PublicKey(TRACKED_MINT);
const airdropMintPk = new PublicKey(AIRDROP_MINT);

/* ================= Utils ================= */
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

/* ================= Admin ops (optional) ================= */
async function recordOps(partial: { lastClaim?: any; lastSwap?: any; lastAirdrop?: any }) {
  const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
  const ADMIN_OPS_URL = process.env.ADMIN_OPS_URL || "";
  if (!ADMIN_SECRET || !ADMIN_OPS_URL) return;
  try {
    const res = await fetch(ADMIN_OPS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": ADMIN_SECRET },
      body: JSON.stringify(partial),
    });
    if (!res.ok) return;
  } catch {}
}

/* ================= PumpPortal helpers ================= */
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

/* ================= Holders & balances ================= */
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

async function getHoldersAllBase(mint: PublicKey): Promise<Array<{ wallet: string; amountBase: bigint }>> {
  async function scan(pid: string, filter165 = false) {
    const filters: any[] = [{ memcmp: { offset: 0, bytes: mint.toBase58() } }];
    if (filter165) filters.unshift({ dataSize: 165 });
    const accs = await withRetries((c: Connection) =>
      c.getParsedProgramAccounts(new PublicKey(pid), { filters })
    );
    const map = new Map<string, bigint>();
    for (const it of accs as any[]) {
      const info = (it as any).account.data.parsed.info;
      const owner = info?.owner as string | undefined;
      const amt = BigInt(info?.tokenAmount?.amount || "0");
      if (!owner || amt <= 0n) continue;
      map.set(owner, (map.get(owner) ?? 0n) + amt);
    }
    return map;
  }
  const out = new Map<string, bigint>();
  try { for (const [k, v] of await scan(TOKEN_PROGRAM_ID.toBase58(), true)) out.set(k, (out.get(k) ?? 0n) + v); } catch {}
  try { for (const [k, v] of await scan(TOKEN_2022_PROGRAM_ID.toBase58(), false)) out.set(k, (out.get(k) ?? 0n) + v); } catch {}
  return Array.from(out.entries()).map(([wallet, amountBase]) => ({ wallet, amountBase }));
}

/* ================= TX Helpers ================= */
let LAST_TX_AT = 0;
async function enforceTxGap() {
  const since = Date.now() - LAST_TX_AT;
  if (since < AIRDROP_MIN_TX_GAP_MS) {
    await sleep(AIRDROP_MIN_TX_GAP_MS - since + Math.floor(Math.random() * 200));
  }
}

async function sendAirdropBatch(ixs: any[]) {
  await enforceTxGap();
  for (let attempt = 0; attempt < AIRDROP_MAX_BATCH_RETRIES; attempt++) {
    try {
      const tx = new Transaction();
      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICRO_LAMPORTS }),
        ...ixs
      );
      tx.feePayer = devWallet.publicKey;

      const { blockhash, lastValidBlockHeight } = await withRetries(c => c.getLatestBlockhash("confirmed"), 4);
      tx.recentBlockhash = blockhash;
      tx.sign(devWallet);

      const sig = await withRetries(async c => {
        const raw = tx.serialize();
        const s = await c.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
        await c.confirmTransaction({ signature: s, blockhash, lastValidBlockHeight }, "confirmed");
        return s;
      }, 4);

      LAST_TX_AT = Date.now();
      return sig;
    } catch (e: any) {
      const m = String(e?.message || e);
      if (looksRetryable(m)) {
        const wait = Math.min(10_000, (attempt + 1) * AIRDROP_MIN_TX_GAP_MS * 2);
        console.warn(`[AIRDROP] transient "${m.slice(0, 140)}" backoff ${wait}ms`);
        if (RPCS.length > 1) connection = rotateConn();
        await sleep(wait + Math.floor(Math.random() * 200));
        continue;
      }
      console.warn(`[AIRDROP] non-retryable: ${m}`);
      throw e;
    }
  }
  throw new Error("airdrop_batch_failed_after_retries");
}

/* ================= Jupiter (kept but not hammered) ================= */
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
    `${JUP_QUOTE}?inputMint=So11111111111111111111111111111111111111112&` +
    `outputMint=${outMint}&amount=${amountLamports}&slippageBps=${slippageBps}` +
    `&enableDexes=pump,meteora,raydium&onlyDirectRoutes=false&swapMode=ExactIn`;
  for (let i = 0; i < JUP_MAX_TRIES; i++) {
    try {
      const j: any = await fetchJsonQuiet(url, {}, 6000);
      if (!j?.routePlan?.length) throw new Error("no_route");
      return j;
    } catch (e: any) {
      const m = String(e?.message || e);
      if (m === "HTTP_429" || looksRetryable(m)) { await sleep(JUP_429_SLEEP_MS * (i + 1)); continue; }
      if (i === JUP_MAX_TRIES - 1) throw e;
    }
  }
  throw new Error("quote_failed");
}
async function jupSwap(conn: Connection, signer: Keypair, quoteResp: any) {
  const swapReq = {
    quoteResponse: quoteResp,
    userPublicKey: signer.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: "auto",
  };
  for (let i = 0; i < JUP_MAX_TRIES; i++) {
    try {
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
      if (m === "HTTP_429" || looksRetryable(m)) { await sleep(JUP_429_SLEEP_MS * (i + 1)); continue; }
      if (i === JUP_MAX_TRIES - 1) throw e;
    }
  }
  throw new Error("swap_failed");
}

/* ================= Claim / Swap ================= */
let lastClaimState: null | { cycleId: string; preSol: number; claimedSol: number; claimSig: string | null } = null;

function floorCycleStart(d = new Date()) {
  const w = CYCLE_MINUTES * 60_000;
  return new Date(Math.floor(d.getTime() / w) * w);
}
function nextTimes() {
  const s = floorCycleStart();
  return {
    id: String(s.getTime()),
    start: s,
    t30: new Date(s.getTime() + 30_000),
    t55: new Date(s.getTime() + 55_000),
    end: new Date(s.getTime() + 60_000)
  };
}

async function getSolBalance(conn: Connection, pubkey: PublicKey) {
  return (await conn.getBalance(pubkey, "confirmed")) / LAMPORTS_PER_SOL;
}

async function triggerClaimAtStart() {
  const cycleId = String(floorCycleStart().getTime());
  const preSol = await getSolBalance(connection, devWallet.publicKey);
  const { res, json } = await callPumportal(
    "/api/trade",
    { action: "collectCreatorFee", priorityFee: 0.000001, pool: "pump", mint: TRACKED_MINT },
    `claim:${cycleId}`
  );
  if (!res.ok) throw new Error(`Claim failed ${res.status}`);
  const claimSig = extractSig(json);
  const postSol = await getSolBalance(connection, devWallet.publicKey);
  const claimedSol = Math.max(0, postSol - preSol);
  console.log(`[CLAIM] +${claimedSol} SOL | ${claimSig || "no-sig"}`);
  lastClaimState = { cycleId, preSol, claimedSol, claimSig };
  await recordOps({ lastClaim: { at: new Date().toISOString(), amountSol: claimedSol, tx: claimSig } });
}

async function triggerSwapAt30s() {
  if (!lastClaimState || lastClaimState.claimedSol <= 0) return;
  try {
    const spend = Math.max(0, Math.min(lastClaimState.claimedSol * 0.7, (await getSolBalance(connection, devWallet.publicKey)) - 0.02));
    if (spend <= 0.00001) return;
    const q = await jupQuoteSolToToken(AIRDROP_MINT, spend, 300);
    const sig = await jupSwap(connection, devWallet, q);
    console.log(`[SWAP] ${spend} SOL -> ${AIRDROP_MINT} | ${sig}`);
    await recordOps({ lastSwap: { at: new Date().toISOString(), spentSol: spend, tx: sig } });
  } catch (e: any) {
    console.warn("[SWAP] failed:", e?.message || e);
  }
}

/* ================= Mint meta ================= */
async function resolveMintMeta(mintPk: PublicKey) {
  const info = await withRetries(c => c.getAccountInfo(mintPk, "confirmed"), 5);
  if (!info) throw new Error("Mint account not found");
  const is22 = info.owner.equals(TOKEN_2022_PROGRAM_ID);
  const tokenProgram = is22 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const mintInfo = await withRetries(c => getMint(c, mintPk, "confirmed", tokenProgram), 5);
  const decimals = mintInfo.decimals;
  return { tokenProgram, decimals };
}

/* ================= Airdrop (equal split, throttled, program-aware) ================= */
async function simpleAirdropEqual(mint: PublicKey, holdersIn: string[]) {
  // dedupe and filter the set first
  const seen = new Set<string>();
  const holders = holdersIn.filter(w => {
    if (!w) return false;
    if (w === devWallet.publicKey.toBase58()) return false;
    if (seen.has(w)) return false;
    seen.add(w);
    return true;
  });
  if (!holders.length) return console.log("[AIRDROP] no holders");

  const { tokenProgram, decimals } = await resolveMintMeta(mint);

  const poolBase = await tokenBalanceBase(devWallet.publicKey, mint);
  if (poolBase <= 0n) return console.log("[AIRDROP] no token balance");

  const toSend = (poolBase * 90n) / 100n; // send 90% of current balance
  const perHolder = toSend / BigInt(holders.length);
  if (perHolder <= 0n) return console.log("[AIRDROP] nothing to distribute");

  console.log(`[AIRDROP] equally to ${holders.length} holders (${Number(toSend) / 10 ** decimals} total)`);

  // derive sender ATA once per batch; it is cheap to include create-ATA idempotent
  const fromAta = getAssociatedTokenAddressSync(mint, devWallet.publicKey, false, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);

  // keep txs small for reliability
  const BATCH = Math.max(3, Math.min(AIRDROP_BATCH_SIZE, 6));

  for (let i = 0; i < holders.length; i += BATCH) {
    const group = holders.slice(i, i + BATCH);

    const ixs: any[] = [
      createAssociatedTokenAccountIdempotentInstruction(
        devWallet.publicKey, fromAta, devWallet.publicKey, mint, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID
      )
    ];

    for (const w of group) {
      try {
        const to = new PublicKey(w);
        const toAta = getAssociatedTokenAddressSync(mint, to, true, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
        ixs.push(
          createAssociatedTokenAccountIdempotentInstruction(
            devWallet.publicKey, toAta, to, mint, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID
          ),
          createTransferCheckedInstruction(
            fromAta, mint, toAta, devWallet.publicKey, perHolder, decimals, [], tokenProgram
          )
        );
      } catch (e) {
        console.warn(`[AIRDROP] skip invalid wallet ${w}: ${String((e as any)?.message || e)}`);
      }
    }

    if (ixs.length <= 1) continue;

    try {
      const sig = await sendAirdropBatch(ixs);
      console.log(`[AIRDROP] batch ${group.length} | ${sig}`);
    } catch (e: any) {
      console.warn(`[AIRDROP] skipped a batch after retries: ${String(e?.message || e)}`);
    }
  }

  console.log("[AIRDROP] done");
}

async function snapshotAndDistribute() {
  const holders = (await getHoldersAllBase(holdersMintPk))
    .map(h => h.wallet)
    .filter(Boolean);
  if (!holders.length) return console.log("[AIRDROP] no holders found");
  await simpleAirdropEqual(airdropMintPk, holders);
}

/* ================= LOOP ================= */
async function safeRun(fn: () => Promise<void>, label: string, timeoutMs = 120_000) {
  const timer = sleep(timeoutMs).then(() => { throw new Error(`Timeout: ${label}`); });
  try { await Promise.race([fn(), timer]); }
  catch (e: any) { console.warn(`[WARN] ${label} failed:`, e?.message || e); }
}

async function loop() {
  while (true) {
    try {
      console.log("[CYCLE] ======== NEW CYCLE ========");

      // t = 0s → claim
      console.log("[CYCLE] Claim stage");
      await safeRun(triggerClaimAtStart, "claim", 60_000);

      // wait 30s
      console.log("[CYCLE] waiting 30s before swap...");
      await sleep(30_000);

      // t = +30s → swap
      console.log("[CYCLE] Swap stage");
      await safeRun(triggerSwapAt30s, "swap", 90_000);

      // wait 30s
      console.log("[CYCLE] waiting 30s before airdrop...");
      await sleep(30_000);

      // t = +60s → airdrop
      console.log("[CYCLE] Airdrop stage");
      await safeRun(snapshotAndDistribute, "airdrop", 180_000);

      // wait 60s before restarting
      console.log("[CYCLE] waiting 60s before next claim...");
      await sleep(60_000);

    } catch (e: any) {
      console.error("[CYCLE] loop error:", e?.message || e);
      await sleep(5000); // recovery wait
    }
  }
}

loop().catch(e => {
  console.error("bananaWorker crashed", e?.message || e);
  process.exit(1);
});


