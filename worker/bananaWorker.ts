// /worker/bananaWorker.ts
/* Node 18+ runtime (long-lived process) */

import {
  Connection, PublicKey, Keypair, Transaction, VersionedTransaction,
  LAMPORTS_PER_SOL, ComputeBudgetProgram
} from "@solana/web3.js";
import {
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

const PRIORITY_FEE_MICRO_LAMPORTS = Number(process.env.PRIORITY_FEE_MICRO_LAMPORTS ?? 10_000);
const COMPUTE_UNIT_LIMIT = Number(process.env.COMPUTE_UNIT_LIMIT ?? 800_000);

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
  return /429|rate.?limit|timeout|temporar|ECONN|ETIMEDOUT|blockhash|FetchError|TLS|ENOTFOUND|EAI_AGAIN/i.test(m);
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

/* ================= Chain helpers ================= */
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
  try { for (const [k, v] of await scan("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", true)) out.set(k, (out.get(k) ?? 0n) + v); } catch {}
  try { for (const [k, v] of await scan("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCx2w6G3W", false)) out.set(k, (out.get(k) ?? 0n) + v); } catch {}
  return Array.from(out.entries()).map(([wallet, amountBase]) => ({ wallet, amountBase }));
}

/* ================= TX Helpers ================= */
async function sendAirdropBatch(ixs: any[]) {
  const tx = new Transaction();
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICRO_LAMPORTS }),
    ...ixs
  );
  tx.feePayer = devWallet.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(devWallet);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

/* ================= Claim / Swap ================= */
let lastClaimState: null | { cycleId: string; preSol: number; claimedSol: number; claimSig: string | null } = null;

function floorCycleStart(d = new Date()) {
  const w = CYCLE_MINUTES * 60_000;
  return new Date(Math.floor(d.getTime() / w) * w);
}
function nextTimes() {
  const s = floorCycleStart();
  return { id: String(s.getTime()), start: s, t30: new Date(s.getTime() + 30_000), t55: new Date(s.getTime() + 55_000), end: new Date(s.getTime() + 60_000) };
}

async function triggerClaimAtStart() {
  const cycleId = String(floorCycleStart().getTime());
  const preSol = await connection.getBalance(devWallet.publicKey);
  const { res, json } = await callPumportal("/api/trade",
    { action: "collectCreatorFee", priorityFee: 0.000001, pool: "pump", mint: TRACKED_MINT },
    `claim:${cycleId}`);
  if (!res.ok) throw new Error(`Claim failed ${res.status}`);
  const claimSig = extractSig(json);
  const postSol = await connection.getBalance(devWallet.publicKey);
  const claimedSol = (postSol - preSol) / LAMPORTS_PER_SOL;
  console.log(`[CLAIM] +${claimedSol} SOL | ${claimSig || "no-sig"}`);
  lastClaimState = { cycleId, preSol, claimedSol, claimSig };
  await recordOps({ lastClaim: { at: new Date().toISOString(), amountSol: claimedSol, tx: claimSig } });
}

async function triggerSwapAt30s() {
  if (!lastClaimState || lastClaimState.claimedSol <= 0) return;
  console.log("[SWAP] starting...");
  await sleep(2000);
  console.log("[SWAP] done");
}

/* ================= Airdrop ================= */
async function simpleAirdropEqual(mint: PublicKey, holders: string[]) {
  if (!holders.length) return console.log("[AIRDROP] no holders");

  const dec = 8;
  const poolBase = await tokenBalanceBase(devWallet.publicKey, mint);
  if (poolBase <= 0n) return console.log("[AIRDROP] no token balance");

  const toSend = (poolBase * 90n) / 100n;
  const perHolder = toSend / BigInt(holders.length);
  console.log(`[AIRDROP] distributing equally to ${holders.length} holders (${Number(toSend) / 10 ** dec} total)`);

  const fromAta = getAssociatedTokenAddressSync(mint, devWallet.publicKey, false);
  const batchSize = 8;

  for (let i = 0; i < holders.length; i += batchSize) {
    const group = holders.slice(i, i + batchSize);
    const ixs: any[] = [createAssociatedTokenAccountIdempotentInstruction(devWallet.publicKey, fromAta, devWallet.publicKey, mint)];
    for (const w of group) {
      try {
        const to = new PublicKey(w);
        const toAta = getAssociatedTokenAddressSync(mint, to, true);
        ixs.push(
          createAssociatedTokenAccountIdempotentInstruction(devWallet.publicKey, toAta, to, mint),
          createTransferCheckedInstruction(fromAta, mint, toAta, devWallet.publicKey, perHolder, dec)
        );
      } catch {}
    }
    if (ixs.length <= 1) continue;
    for (let tries = 0; tries < 4; tries++) {
      try {
        const sig = await sendAirdropBatch(ixs);
        console.log(`[AIRDROP] batch ${group.length} | ${sig}`);
        break;
      } catch (e: any) {
        const m = String(e?.message || e);
        if (looksRetryable(m)) {
          const wait = Math.min(8000, 1000 * 2 ** tries);
          console.warn(`[AIRDROP] backoff ${wait}ms`);
          await sleep(wait);
          continue;
        }
        console.warn(`[AIRDROP] failed batch: ${m}`);
        break;
      }
    }
    await sleep(1500);
  }
  console.log("[AIRDROP] done");
}

async function snapshotAndDistribute() {
  const holders = (await getHoldersAllBase(holdersMintPk)).map(h => h.wallet);
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
  const fired = new Set<string>();
  for (;;) {
    const { id, start, t30, t55, end } = nextTimes();
    const now = new Date();
    if (!fired.has(id + ":claim") && now >= start) { safeRun(triggerClaimAtStart, "claim", 60_000); fired.add(id + ":claim"); }
    if (!fired.has(id + ":swap") && now >= t30) { safeRun(triggerSwapAt30s, "swap", 90_000); fired.add(id + ":swap"); }
    if (!fired.has(id + ":airdrop") && now >= t55) { safeRun(snapshotAndDistribute, "airdrop", 180_000); fired.add(id + ":airdrop"); }
    if (now >= end) fired.clear();
    await sleep(250);
  }
}

loop().catch(e => {
  console.error("bananaWorker crashed", e?.message || e);
  process.exit(1);
});
