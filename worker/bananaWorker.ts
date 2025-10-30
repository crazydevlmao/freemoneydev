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
const JUP_BASE = process.env.JUP_BASE || "https://quote-api.jup.ag/v6";
const JUP_QUOTE = `${JUP_BASE}/quote`;
const JUP_SWAP = `${JUP_BASE}/swap`;
const JUP_MAX_TRIES = 5;
const TX_RETRY_SLEEP_MS = 1000;
const FINAL_SINGLE_RETRY_SLEEP_MS = 1000;
const PRIORITY_FEE_MICRO_LAMPORTS = 10_000;
const COMPUTE_UNIT_LIMIT = 800_000;

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
  return /429|rate|timeout|temporar|ECONN|ETIMEDOUT|blockhash|FetchError/i.test(m);
}
async function withRetries<T>(fn: (c: Connection) => Promise<T>, tries = 4) {
  let c = connection, last: any;
  for (let i = 0; i < tries; i++) {
    try { return await fn(c); }
    catch (e: any) {
      last = e;
      if (i < tries - 1 && looksRetryable(e.message)) {
        c = rotateConn();
        await sleep(500 * (i + 1));
        continue;
      }
      break;
    }
  }
  throw last;
}
const pow10n = (n: number) => { let r = 1n; for (let i = 0; i < n; i++) r *= 10n; return r; };

/* ================= Chain helpers ================= */
async function getMintDecimals(mint: PublicKey) {
  const info = await withRetries(c => c.getParsedAccountInfo(mint, "confirmed"));
  return (info?.value as any)?.data?.parsed?.info?.decimals ?? 0;
}
async function tokenBalanceBase(owner: PublicKey, mint: PublicKey) {
  const r = await withRetries(c => c.getParsedTokenAccountsByOwner(owner, { mint }, "confirmed"));
  let t = 0n; for (const v of (r as any).value)
    t += BigInt(v.account.data.parsed.info.tokenAmount.amount);
  return t;
}
async function getHoldersAllBase(mint: PublicKey) {
  async function scan(pid: string, filter165 = false) {
    const filters: any[] = [{ memcmp: { offset: 0, bytes: mint.toBase58() } }];
    if (filter165) filters.unshift({ dataSize: 165 });
    const accs = await withRetries(c => c.getParsedProgramAccounts(new PublicKey(pid), { filters }));
    const map = new Map<string, bigint>();
    for (const it of accs) {
      const info: any = it.account.data.parsed.info;
      const owner = info?.owner;
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
function isTxTooLarge(e: any) {
  const m = String(e?.message || "").toLowerCase();
  return m.includes("tx too large") || m.includes("transaction too large");
}
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
async function triggerClaimAtStart() {
  console.log("[CLAIM] starting");
  await sleep(500);
  console.log("[CLAIM] done");
}
async function triggerSwapAt30s() {
  console.log("[SWAP] starting");
  await sleep(500);
  console.log("[SWAP] done");
}

/* ================= Airdrop ================= */
type AirdropRowBase = { wallet: string; amountBase: bigint };
async function sendAirdropsAdaptiveBase(rows: AirdropRowBase[], decimals: number, mint: PublicKey) {
  const fromAta = getAssociatedTokenAddressSync(mint, devWallet.publicKey, false);
  let queue = rows.slice();
  let groupSize = 10;

  while (queue.length > 0) {
    const group = queue.splice(0, Math.min(groupSize, queue.length));
    const ixs: any[] = [
      createAssociatedTokenAccountIdempotentInstruction(devWallet.publicKey, fromAta, devWallet.publicKey, mint)
    ];
    for (const r of group) {
      try {
        if (r.amountBase <= 0n) continue;
        const recipient = new PublicKey(r.wallet);
        const toAta = getAssociatedTokenAddressSync(mint, recipient, true);
        ixs.push(
          createAssociatedTokenAccountIdempotentInstruction(devWallet.publicKey, toAta, recipient, mint),
          createTransferCheckedInstruction(fromAta, mint, toAta, devWallet.publicKey, r.amountBase, decimals)
        );
      } catch {}
    }
    if (ixs.length <= 1) continue;

    let tries = 0;
    while (tries++ < 5) {
      try {
        const sig = await sendAirdropBatch(ixs);
        console.log(`[AIRDROP] batch ${group.length} | ${sig}`);
        groupSize = Math.min(groupSize + 1, 12);
        break;
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (isTxTooLarge(e) && groupSize > 1) {
          groupSize = Math.max(1, Math.floor(groupSize / 2));
          queue = group.concat(queue);
          break;
        }
        if (looksRetryable(msg)) { await sleep(TX_RETRY_SLEEP_MS); continue; }
        console.warn("[AIRDROP] batch failed permanently:", e.message);
        break;
      }
    }
  }
}

async function snapshotAndDistribute() {
  const holders = await getHoldersAllBase(holdersMintPk);
  if (!holders.length) return;
  const trackedDec = await getMintDecimals(holdersMintPk);
  const trackedPow = pow10n(trackedDec);
  const dev58 = devWallet.publicKey.toBase58();
  const eligible = holders.filter(h => h.wallet !== dev58);
  const targetDec = await getMintDecimals(airdropMintPk);
  const poolBase = await tokenBalanceBase(devWallet.publicKey, airdropMintPk);
  const toSend = (poolBase * 90n) / 100n;
  if (toSend <= 0n) return console.log("[AIRDROP] skipped - no balance");

  const total = eligible.reduce((a, h) => a + h.amountBase, 0n);
  const shares = eligible.map(h => {
    const prod = toSend * h.amountBase;
    const q = prod / total;
    const r = prod % total;
    return { wallet: h.wallet, base: q, rem: r };
  });
  let sum = shares.reduce((a, s) => a + s.base, 0n);
  if (sum < toSend) {
    let add = toSend - sum;
    shares.sort((a, b) => (b.rem > a.rem ? 1 : -1));
    for (let i = 0; add > 0n && i < shares.length; i++) {
      shares[i].base += 1n;
      add -= 1n;
    }
  }
  const rows = shares.filter(s => s.base > 0n).map(s => ({ wallet: s.wallet, amountBase: s.base }));
  const ui = Number(toSend) / 10 ** targetDec;
  console.log(`[AIRDROP] starting ${rows.length} holders, distributing ${ui.toFixed(8)} tokens`);
  await sendAirdropsAdaptiveBase(rows, targetDec, airdropMintPk);
  console.log(`[AIRDROP] done wallets=${rows.length}`);
}

/* ================= LOOP ================= */
function floorCycleStart(d = new Date()) {
  const w = CYCLE_MINUTES * 60_000;
  return new Date(Math.floor(d.getTime() / w) * w);
}
function nextTimes() {
  const s = floorCycleStart();
  return { start: s, t30: new Date(s.getTime() + 30_000), t55: new Date(s.getTime() + 55_000), end: new Date(s.getTime() + 60_000) };
}

async function loop() {
  const fired = new Set<string>();
  for (;;) {
    const { start, t30, t55, end } = nextTimes();
    const now = new Date();

    if (!fired.has("claim") && now >= start) { triggerClaimAtStart().catch(console.warn); fired.add("claim"); }
    if (!fired.has("swap") && now >= t30) { triggerSwapAt30s().catch(console.warn); fired.add("swap"); }
    if (!fired.has("airdrop") && now >= t55) { snapshotAndDistribute().catch(console.warn); fired.add("airdrop"); }
    if (now >= end) fired.clear();

    await sleep(500);
  }
}

loop().catch(e => console.error("loop crashed", e));
