// /worker/bananaWorker.ts
/* Node 18+ runtime (long-lived process) */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
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
const CYCLE_MINUTES = 3;

const TRACKED_MINT = process.env.TRACKED_MINT || "";
const REWARD_WALLET = process.env.REWARD_WALLET || "";
const DEV_WALLET_PRIVATE_KEY = process.env.DEV_WALLET_PRIVATE_KEY || "";
const AUTO_BLACKLIST_BALANCE = Number(process.env.AUTO_BLACKLIST_BALANCE ?? 50_000_000);

const HELIUS_RPC =
  process.env.HELIUS_RPC ||
  `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ""}`;
const QUICKNODE_RPC = process.env.QUICKNODE_RPC || "";
const PUMPORTAL_KEY = (process.env.PUMPORTAL_KEY || "").trim();
const PUMPORTAL_BASE = "https://pumpportal.fun";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const ADMIN_OPS_URL = process.env.ADMIN_OPS_URL || "";

if (!TRACKED_MINT || !REWARD_WALLET || !DEV_WALLET_PRIVATE_KEY)
  throw new Error("Missing TRACKED_MINT, REWARD_WALLET, or DEV_WALLET_PRIVATE_KEY");
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
const mintPubkey = new PublicKey(TRACKED_MINT);

if (REWARD_WALLET !== devWallet.publicKey.toBase58()) {
  console.warn(
    `[WARN] REWARD_WALLET (${REWARD_WALLET}) != DEV wallet (${devWallet.publicKey.toBase58()}).`
  );
}

/* ================= Small Utils ================= */
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
function looksRetryableMessage(msg: string) {
  return /rate.?limit|429|timeout|temporar|connection|ECONNRESET|ETIMEDOUT|blockhash|Node is behind|Transaction was not confirmed|FetchError|TLS|ENOTFOUND|EAI_AGAIN/i.test(
    msg
  );
}
async function withRetries<T>(fn: () => Promise<T>, attempts = 5, baseMs = 350): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (i === attempts - 1 || !looksRetryableMessage(msg)) break;
      const delay = baseMs * Math.pow(1.7, i) + Math.floor(Math.random() * 200);
      await sleep(delay);
    }
  }
  throw lastErr;
}
async function withConnRetries<T>(fn: (c: Connection) => Promise<T>, attempts = 5) {
  let c = connection;
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(c);
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (i === attempts - 1 || !looksRetryableMessage(msg) || RPCS.length <= 1) break;
      c = connection = rotateConnection();
      await sleep(250 * (i + 1));
    }
  }
  throw lastErr;
}

/* ================= AIRDROP FIX SECTION ================= */

// confirmation via polling (no WebSocket)
async function confirmWithPolling(signature: string, blockhash: string, lastValidBlockHeight: number) {
  const start = Date.now();
  while (Date.now() - start < 30000) {
    const st = await withConnRetries((c) => c.getSignatureStatuses([signature])) as any;
    const v = st?.value?.[0];
    if (v?.err == null && (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized")) {
      return;
    }
    const bh = await withConnRetries((c) => c.getLatestBlockhash("confirmed")) as any;
    if (bh?.lastValidBlockHeight > lastValidBlockHeight) throw new Error("block height exceeded");
    await sleep(500);
  }
  throw new Error("confirmation timeout");
}

/* ================= sendAirdropBatch patched ================= */
async function sendAirdropBatch(ixs: any[]) {
  return await withRetries(async () => {
    const tx = new Transaction();
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 })
    );
    for (const ix of ixs) tx.add(ix);
    tx.feePayer = devWallet.publicKey;

    const { blockhash, lastValidBlockHeight, minContextSlot } =
      await withConnRetries((c) => c.getLatestBlockhash("confirmed")) as any;

    tx.recentBlockhash = blockhash;
    tx.sign(devWallet);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
      minContextSlot,
    });

    await confirmWithPolling(sig, blockhash, lastValidBlockHeight);
    return sig;
  }, 2);
}

/* ================= sendAirdropsAdaptive patched ================= */
async function sendAirdropsAdaptive(
  rows: Array<{ wallet: string; amountUi: number }>,
  decimals: number
) {
  const factor = 10 ** decimals;
  const uiToBase = (x: number) => BigInt(Math.floor(x * factor));
  const fromAta = getAssociatedTokenAddressSync(mintPubkey, devWallet.publicKey, false);

  let idx = 0;
  let groupSize = 5; // throttled down from 10
  const groupSizeMax = 10;

  while (idx < rows.length) {
    const end = Math.min(rows.length, idx + groupSize);
    const group = rows.slice(idx, end);
    const ixs: any[] = [];

    for (const r of group) {
      let recipient: PublicKey;
      try {
        recipient = new PublicKey(r.wallet);
      } catch {
        continue;
      }

      let toAta: PublicKey;
      try {
        toAta = getAssociatedTokenAddressSync(mintPubkey, recipient, true);
      } catch {
        continue;
      }

      const amountBase = uiToBase(r.amountUi);
      if (amountBase <= 0n) continue;

      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          devWallet.publicKey,
          toAta,
          recipient,
          mintPubkey
        ),
        createTransferCheckedInstruction(
          fromAta,
          mintPubkey,
          toAta,
          devWallet.publicKey,
          amountBase,
          decimals
        )
      );
    }

    try {
      const sig = await sendAirdropBatch(ixs);
      console.log(`[AIRDROP] batch (${group.length}) | https://solscan.io/tx/${sig}`);
      await sleep(1000); // <== added throttle to avoid 429s
      idx = end;
      if (groupSize < groupSizeMax) groupSize = Math.min(groupSizeMax, groupSize + 1);
    } catch (e: any) {
      if (/too large/i.test(String(e))) {
        groupSize = Math.max(1, Math.floor(groupSize / 2));
        console.warn(`[AIRDROP] tx too large; reducing group size to ${groupSize}…`);
        await sleep(200);
        continue;
      }
      if (looksRetryableMessage(String(e?.message || e))) {
        console.warn(`[AIRDROP] retryable error; retrying batch…`);
        await sleep(800);
        continue;
      }
      throw e;
    }
  }
}
