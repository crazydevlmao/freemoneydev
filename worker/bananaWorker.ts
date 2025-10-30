// /worker/bananaWorker.ts
/* Node 18+ runtime (long-lived process) */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import bs58 from "bs58";

/* ================= CONFIG ================= */
const CYCLE_MINUTES = 1; // every 1 min
const TRACKED_MINT = process.env.TRACKED_MINT || "";
const AIRDROP_MINT = process.env.AIRDROP_MINT || "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const REWARD_WALLET = process.env.REWARD_WALLET || "";
const DEV_WALLET_PRIVATE_KEY = process.env.DEV_WALLET_PRIVATE_KEY || "";
const MIN_HOLDER_BALANCE = Number(process.env.MIN_HOLDER_BALANCE ?? 100_000);
const MAX_HOLDER_BALANCE = Number(process.env.MAX_HOLDER_BALANCE ?? 50_000_000);
const HELIUS_RPC = process.env.HELIUS_RPC || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ""}`;
const QUICKNODE_RPC = process.env.QUICKNODE_RPC || "";
const PUMPORTAL_KEY = (process.env.PUMPORTAL_KEY || "").trim();
const PUMPORTAL_BASE = "https://pumpportal.fun";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const ADMIN_OPS_URL = process.env.ADMIN_OPS_URL || "";
const JUP_BASE = process.env.JUP_BASE || "https://lite-api.jup.ag/swap/v1";
const JUP_QUOTE = `${JUP_BASE}/quote`;
const JUP_SWAP = `${JUP_BASE}/swap`;
const JUP_MAX_TRIES = Number(process.env.JUP_MAX_TRIES ?? 6);
const JUP_429_SLEEP_MS = Number(process.env.JUP_429_SLEEP_MS ?? 1000);
const TX_RETRY_SLEEP_MS = Number(process.env.TX_RETRY_SLEEP_MS ?? 1000);
const FINAL_SINGLE_RETRY_SLEEP_MS = Number(process.env.FINAL_SINGLE_RETRY_SLEEP_MS ?? 1000);

if (!TRACKED_MINT || !REWARD_WALLET || !DEV_WALLET_PRIVATE_KEY) throw new Error("Missing TRACKED_MINT, REWARD_WALLET, or DEV_WALLET_PRIVATE_KEY");
if (!HELIUS_RPC) throw new Error("Missing HELIUS_RPC / HELIUS_API_KEY");

/* ================= Connection / Keys ================= */
const RPCS = [HELIUS_RPC, QUICKNODE_RPC].filter(Boolean);
let rpcIdx = 0;
function newConnection(): Connection {
  return new Connection(RPCS[rpcIdx]!, "confirmed");
}
function rotateConnection(): Connection {
  rpcIdx = (rpcIdx + 1) % RPCS.length;
  return new Connection(RPCS[rpcIdx]!, "confirmed");
}
let connection = newConnection();
function toKeypair(secret: string): Keypair {
  try {
    const arr = JSON.parse(secret);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch {
    return Keypair.fromSecretKey(bs58.decode(secret));
  }
}
const devWallet = toKeypair(DEV_WALLET_PRIVATE_KEY);
const holdersMintPk = new PublicKey(TRACKED_MINT);
const airdropMintPk = new PublicKey(AIRDROP_MINT);

/* ================= Utils ================= */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function looksRetryableMessage(msg: string) {
  return /rate.?limit|429|timeout|temporar|connection|ECONNRESET|ETIMEDOUT|blockhash|Node is behind|Transaction was not confirmed|FetchError|TLS|ENOTFOUND|EAI_AGAIN/i.test(msg);
}
async function withConnRetries<T>(fn: (c: Connection) => Promise<T>, attempts = 5) {
  let c = connection;
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(c); }
    catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (i === attempts - 1 || !looksRetryableMessage(msg) || RPCS.length <= 1) break;
      c = (connection = rotateConnection());
      await sleep(250 * (i + 1));
    }
  }
  throw lastErr;
}

/* ================= Token Helpers ================= */
const pow10n = (n: number) => { let r = 1n; for (let i = 0; i < n; i++) r *= 10n; return r; };
async function getMintDecimals(mintPk: PublicKey): Promise<number> {
  const info = await withConnRetries((c) => c.getParsedAccountInfo(mintPk, "confirmed"));
  const parsed: any = (info?.value as any)?.data?.parsed;
  const dec = parsed?.info?.decimals;
  if (typeof dec !== "number") throw new Error("Unable to fetch mint decimals");
  return dec;
}
async function tokenBalanceBase(owner: PublicKey, mintPk: PublicKey): Promise<bigint> {
  const resp = await withConnRetries((c) => c.getParsedTokenAccountsByOwner(owner, { mint: mintPk }, "confirmed"));
  let total = 0n;
  for (const it of (resp as any).value) {
    const amtStr = (it as any).account.data.parsed.info.tokenAmount.amount as string;
    total += BigInt(amtStr || "0");
  }
  return total;
}

/* ================= Airdrop ================= */
type AirdropRowBase = { wallet: string; amountBase: bigint };

async function sendAirdropsAdaptiveBase(rows: AirdropRowBase[], decimals: number, mintPk: PublicKey) {
  const fromAta = getAssociatedTokenAddressSync(mintPk, devWallet.publicKey, false);
  let queue = rows.slice();
  let groupSize = Number(process.env.AIRDROP_GROUP_SIZE ?? 10);

  while (queue.length > 0) {
    const group = queue.splice(0, Math.min(groupSize, queue.length));
    const ixs: any[] = [];
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(devWallet.publicKey, fromAta, devWallet.publicKey, mintPk));
    for (const r of group) {
      try {
        if (r.amountBase <= 0n) continue;
        const recipient = new PublicKey(r.wallet);
        const toAta = getAssociatedTokenAddressSync(mintPk, recipient, false);
        ixs.push(
          createAssociatedTokenAccountIdempotentInstruction(devWallet.publicKey, toAta, recipient, mintPk),
          createTransferCheckedInstruction(fromAta, mintPk, toAta, devWallet.publicKey, r.amountBase, decimals)
        );
      } catch {}
    }
    if (ixs.length <= 1) continue;
    for (;;) {
      try {
        const sig = await sendAirdropBatch(ixs);
        console.log(`[AIRDROP] batch ${group.length} | ${sig}`);
        groupSize = Math.min(groupSize + 1, Number(process.env.AIRDROP_GROUP_MAX ?? 12));
        break;
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (isTxTooLarge(e) && groupSize > 1) { groupSize = Math.max(1, Math.floor(groupSize / 2)); queue = group.concat(queue); break; }
        if (looksRetryableMessage(msg)) { await sleep(TX_RETRY_SLEEP_MS); continue; }
        queue = group.concat(queue); break;
      }
    }
  }

  for (const r of rows) {
    if (r.amountBase <= 0n) continue;
    for (;;) {
      try {
        const recipient = new PublicKey(r.wallet);
        const toAta = getAssociatedTokenAddressSync(mintPk, recipient, false);
        const ixs = [
          createAssociatedTokenAccountIdempotentInstruction(devWallet.publicKey, fromAta, devWallet.publicKey, mintPk),
          createAssociatedTokenAccountIdempotentInstruction(devWallet.publicKey, toAta, recipient, mintPk),
          createTransferCheckedInstruction(fromAta, mintPk, toAta, devWallet.publicKey, r.amountBase, decimals),
        ];
        const sig = await sendAirdropBatch(ixs);
        console.log(`[AIRDROP] single ${recipient.toBase58()} | ${sig}`);
        break;
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (looksRetryableMessage(msg)) { await sleep(FINAL_SINGLE_RETRY_SLEEP_MS); continue; }
        await sleep(FINAL_SINGLE_RETRY_SLEEP_MS);
      }
    }
  }
}

async function snapshotAndDistribute() {
  const targetMintPk = new PublicKey("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh");
  const holdersBase = await getHoldersAllBase(holdersMintPk);
  if (holdersBase.length === 0) return;
  const trackedDec = await getMintDecimals(holdersMintPk);
  const trackedPow = pow10n(trackedDec);
  const minBase = BigInt(Math.floor(MIN_HOLDER_BALANCE)) * trackedPow;
  const maxBase = BigInt(Math.floor(MAX_HOLDER_BALANCE)) * trackedPow;
  const dev58 = devWallet.publicKey.toBase58();
  const eligible = holdersBase.filter((h) => h.wallet !== dev58 && h.amountBase >= minBase && h.amountBase <= maxBase);
  if (eligible.length === 0) return;

  const targetDec = await getMintDecimals(targetMintPk);
  const poolBase = await tokenBalanceBase(devWallet.publicKey, targetMintPk);
  const toSendBase = (poolBase * 90n) / 100n;
  if (toSendBase <= 0n) return console.log(`[AIRDROP] skipped - no ${AIRDROP_MINT} balance`);

  const totalEligibleBase = eligible.reduce((a, h) => a + h.amountBase, 0n);
  if (totalEligibleBase <= 0n) return;

  // exact largest-remainder proportional split
  const shares = eligible.map((h) => {
    const prod = toSendBase * h.amountBase;
    const q = prod / totalEligibleBase;
    const r = prod % totalEligibleBase;
    return { wallet: h.wallet, base: q, rem: r };
  });

  let sumBase = shares.reduce((a, s) => a + s.base, 0n);
  if (sumBase < toSendBase) {
    let add = toSendBase - sumBase;
    shares.sort((a, b) => (b.rem > a.rem ? 1 : -1));
    for (let i = 0; add > 0n && i < shares.length; i++) {
      shares[i].base += 1n; add -= 1n;
    }
  }

  const rows = shares.filter((s) => s.base > 0n).map((s) => ({ wallet: s.wallet, amountBase: s.base }));
  console.log(`[AIRDROP] starting ${rows.length} holders, distributing ${(Number(toSendBase) / 10 ** targetDec).toFixed(targetDec)} tokens`);
  await sendAirdropsAdaptiveBase(rows, targetDec, targetMintPk);
  const totalSent = rows.reduce((a, r) => a + r.amountBase, 0n);
  console.log(`[AIRDROP] done wallets=${rows.length} totalSentBase=${totalSent}`);
}
