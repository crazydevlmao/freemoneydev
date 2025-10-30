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
const PRIORITY_FEE_MICRO_LAMPORTS = Number(process.env.PRIORITY_FEE_MICRO_LAMPORTS ?? 5_000);
const COMPUTE_UNIT_LIMIT = Number(process.env.COMPUTE_UNIT_LIMIT ?? 400_000);

const AIRDROP_BATCH_SIZE = Number(process.env.AIRDROP_BATCH_SIZE ?? 8);
const AIRDROP_MAX_BATCH_RETRIES = Number(process.env.AIRDROP_MAX_BATCH_RETRIES ?? 3);
const AIRDROP_MIN_TX_GAP_MS = Number(process.env.AIRDROP_MIN_TX_GAP_MS ?? 1200);

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
const holdersMintPk = new PublicKey(TRACKED_MINT);
const airdropMintPk = new PublicKey(AIRDROP_MINT);

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

/* ================= CLAIM / SWAP ================= */
let lastClaimState: null | { claimedSol: number; claimSig: string | null } = null;

async function triggerClaimAtStart() {
  console.log("💰 [CLAIM] Starting claim...");
  const preSol = await getSolBalance(connection, devWallet.publicKey);

  const { res, json } = await callPumportal(
    "/api/trade",
    { action: "collectCreatorFee", priorityFee: 0.000001, pool: "pump", mint: TRACKED_MINT },
    `claim:${Date.now()}`
  );

  if (!res.ok) throw new Error(`Claim failed ${res.status}`);

  const claimSig = extractSig(json);
  await sleep(3000); // allow ledger settle
  const postSol = await getSolBalance(connection, devWallet.publicKey);
  const claimedSol = Math.max(0, parseFloat((postSol - preSol).toFixed(6)));

  console.log(
    claimedSol > 0
      ? `🟢 [CLAIM] Claimed ${claimedSol} SOL | Tx: ${claimSig || "no-sig"}`
      : `⚪ [CLAIM] No visible increase (pre=${preSol.toFixed(3)} → post=${postSol.toFixed(3)}) | Tx: ${claimSig || "no-sig"}`
  );

  lastClaimState = { claimedSol, claimSig };
}

async function triggerSwap() {
  console.log("🔄 [SWAP] Checking swap opportunity...");
  const walletSol = await getSolBalance(connection, devWallet.publicKey);
  const spend = Math.max(0, Math.min(walletSol * 0.7, walletSol - 0.02));

  if (spend <= 0.00001) {
    console.log(`⚪ [SWAP] Skipped — not enough SOL (${walletSol.toFixed(4)}).`);
    return;
  }

  try {
    console.log(`🧮 [SWAP] Preparing swap of ${spend.toFixed(4)} SOL → token ${AIRDROP_MINT}`);
    const q = await jupQuoteSolToToken(AIRDROP_MINT, spend, 300);
    const sig = await jupSwap(connection, devWallet, q);
    console.log(`✅ [SWAP] ${spend.toFixed(4)} SOL swapped successfully | Tx: ${sig}`);
  } catch (e: any) {
    console.error(`❌ [SWAP] Failed: ${e?.message || e}`);
  }
}

/* ================= AIRDROP ================= */
async function snapshotAndDistribute() {
  console.log("🎁 [AIRDROP] Starting distribution snapshot...");
  const holders = (await getHoldersAllBase(holdersMintPk)).map(h => h.wallet).filter(Boolean);
  if (!holders.length) return console.log("⚪ [AIRDROP] No holders found.");
  await simpleAirdropEqual(airdropMintPk, holders);
}

/* ================= LOOP ================= */
async function safeRun(fn: () => Promise<void>, label: string, timeoutMs = 120_000) {
  const timer = sleep(timeoutMs).then(() => { throw new Error(`Timeout: ${label}`); });
  try { await Promise.race([fn(), timer]); }
  catch (e: any) { console.warn(`⚠️ [${label.toUpperCase()}] failed:`, e?.message || e); }
}

async function loop() {
  while (true) {
    try {
      console.log("\n================= 🚀 NEW CYCLE =================");
      await safeRun(triggerClaimAtStart, "claim", 60_000);

      console.log("⏳ Waiting 30s before swap...");
      await sleep(30_000);

      await safeRun(triggerSwap, "swap", 90_000);

      console.log("⏳ Waiting 30s before airdrop...");
      await sleep(30_000);

      await safeRun(snapshotAndDistribute, "airdrop", 180_000);

      console.log("🕐 Cooldown 60s before next cycle...");
      await sleep(60_000);
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
