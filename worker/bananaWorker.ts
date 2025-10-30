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

const PRIORITY_FEE_MICRO_LAMPORTS = Number(process.env.PRIORITY_FEE_MICRO_LAMPORTS ?? 10_000);
const COMPUTE_UNIT_LIMIT = Number(process.env.COMPUTE_UNIT_LIMIT ?? 800_000);

if (!TRACKED_MINT || !REWARD_WALLET || !DEV_WALLET_PRIVATE_KEY) {
  throw new Error("Missing TRACKED_MINT, REWARD_WALLET, or DEV_WALLET_PRIVATE_KEY");
}
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

if (REWARD_WALLET !== devWallet.publicKey.toBase58()) {
  console.warn(`[WARN] REWARD_WALLET (${REWARD_WALLET}) != DEV wallet (${devWallet.publicKey.toBase58()}).`);
}

/* ================= Utils ================= */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function looksRetryableMessage(msg: string) {
  return /rate.?limit|429|timeout|temporar|connection|ECONNRESET|ETIMEDOUT|blockhash|Node is behind|Transaction was not confirmed|FetchError|TLS|ENOTFOUND|EAI_AGAIN/i.test(msg);
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
      c = (connection = rotateConnection());
      await sleep(250 * (i + 1));
    }
  }
  throw lastErr;
}

/* ================= Admin ops (optional) ================= */
async function recordOps(partial: { lastClaim?: any; lastSwap?: any; lastAirdrop?: any }) {
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

/* ================= PumpPortal ================= */
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
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {}
  return { res, json };
}
function extractSig(j: any): string | null {
  return j?.signature || j?.tx || j?.txid || j?.txId || j?.result || j?.sig || null;
}

/* ================= Chain helpers ================= */
const pow10n = (n: number) => { let r = 1n; for (let i = 0; i < n; i++) r *= 10n; return r; };

async function getMintDecimals(mintPk: PublicKey): Promise<number> {
  const info = await withConnRetries((c) => c.getParsedAccountInfo(mintPk, "confirmed"));
  const parsed: any = (info?.value as any)?.data?.parsed;
  const dec = parsed?.info?.decimals;
  if (typeof dec !== "number") throw new Error("Unable to fetch mint decimals");
  return dec;
}

// Return [{wallet, amountBase: bigint}] using on-chain scans only
async function getHoldersAllBase(mint: PublicKey): Promise<Array<{ wallet: string; amountBase: bigint }>> {
  async function scan(programId: string, addFilter165 = false) {
    const filters: any[] = [{ memcmp: { offset: 0, bytes: mint.toBase58() } }];
    if (addFilter165) filters.unshift({ dataSize: 165 });
    const accs = (await withConnRetries((c) =>
      c.getParsedProgramAccounts(new PublicKey(programId), { filters })
    )) as any[];
    const out = new Map<string, bigint>();
    for (const it of accs) {
      const info: any = (it as any)?.account?.data?.parsed?.info;
      const owner = info?.owner as string | undefined;
      const ta = info?.tokenAmount as any;
      const amtBaseStr = ta?.amount as string | undefined;
      if (!owner || !amtBaseStr) continue;
      const amt = BigInt(amtBaseStr);
      if (amt <= 0n) continue;
      out.set(owner, (out.get(owner) ?? 0n) + amt);
    }
    return out;
  }
  const merged = new Map<string, bigint>();
  try {
    const m1 = await scan("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", true);
    for (const [k, v] of m1) merged.set(k, (merged.get(k) ?? 0n) + v);
  } catch {}
  try {
    const m2 = await scan("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCx2w6G3W", false);
    for (const [k, v] of m2) merged.set(k, (merged.get(k) ?? 0n) + v);
  } catch {}
  return Array.from(merged.entries()).map(([wallet, amountBase]) => ({ wallet, amountBase }));
}

// Sum wallet balance for a mint in base units
async function tokenBalanceBase(owner: PublicKey, mintPk: PublicKey): Promise<bigint> {
  const resp = await withConnRetries((c) =>
    c.getParsedTokenAccountsByOwner(owner, { mint: mintPk }, "confirmed")
  );
  let total = 0n;
  for (const it of (resp as any).value) {
    const amtStr = (it as any).account.data.parsed.info.tokenAmount.amount as string;
    total += BigInt(amtStr || "0");
  }
  return total;
}

/* ================= Jupiter ================= */
// Quiet fetch with basic timeout
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
      if (m === "HTTP_429") { await sleep(JUP_429_SLEEP_MS); continue; }
      if (looksRetryableMessage(m)) { await sleep(TX_RETRY_SLEEP_MS); continue; }
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
      if (m === "HTTP_429" || looksRetryableMessage(m)) { await sleep(JUP_429_SLEEP_MS); continue; }
      if (i === JUP_MAX_TRIES - 1) throw e;
    }
  }
  throw new Error("swap_failed");
}

/* ================= SOL helpers ================= */
async function getSolBalance(conn: Connection, pubkey: PublicKey) {
  return (await conn.getBalance(pubkey, "confirmed")) / LAMPORTS_PER_SOL;
}
async function pollSolDelta(conn: Connection, owner: PublicKey, preSol: number) {
  for (let i = 0; i < 18; i++) {
    const b = await getSolBalance(conn, owner);
    if (b > preSol) return { postSol: b, deltaSol: b - preSol };
    await sleep(900);
  }
  const b = await getSolBalance(conn, owner);
  return { postSol: b, deltaSol: Math.max(0, b - preSol) };
}

/* ================= Claim / Swap state ================= */
let lastClaimState:
  | null
  | { cycleId: string; preSol: number; claimedSol: number; claimSig: string | null } = null;

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
  const { deltaSol } = await pollSolDelta(connection, devWallet.publicKey, preSol);
  const claimedSol = Math.max(0, deltaSol);
  console.log(`[CLAIM] +${claimedSol} SOL | ${claimSig || "no-sig"}`);
  lastClaimState = { cycleId, preSol, claimedSol, claimSig };
  await recordOps({ lastClaim: { at: new Date().toISOString(), amountSol: claimedSol, tx: claimSig } });
}

async function triggerSwapAt30s() {
  if (!lastClaimState || lastClaimState.claimedSol <= 0) return;
  const claimedSol = lastClaimState.claimedSol;
  const reserve = 0.02;
  const curSol = await getSolBalance(connection, devWallet.publicKey);
  const available = Math.max(0, curSol - reserve);
  const targetSpend = Math.min(claimedSol * 0.7, available);
  if (targetSpend < 0.00001) return;

  try {
    const q = await jupQuoteSolToToken(AIRDROP_MINT, targetSpend, 300);
    const sig = await jupSwap(connection, devWallet, q);
    console.log(`[SWAP] ${targetSpend} SOL -> ${AIRDROP_MINT} | ${sig}`);
    await recordOps({ lastSwap: { at: new Date().toISOString(), spentSol: targetSpend, tx: sig } });
  } catch {
    // stay quiet; next cycle will try again after next claim
  }
}

/* ================= TX helpers ================= */
function isTxTooLarge(err: any) {
  const m = String(err?.message || "").toLowerCase();
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

/* ================= Airdrop ================= */
type AirdropRowBase = { wallet: string; amountBase: bigint };

async function sendAirdropsAdaptiveBase(rows: AirdropRowBase[], decimals: number, mintPk: PublicKey) {
  const fromAta = getAssociatedTokenAddressSync(mintPk, devWallet.publicKey, false);

  let queue = rows.slice();
  let groupSize = Number(process.env.AIRDROP_GROUP_SIZE ?? 10);

  // Batched phase
  while (queue.length > 0) {
    const group = queue.splice(0, Math.min(groupSize, queue.length));
    const ixs: any[] = [];
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        devWallet.publicKey,
        fromAta,
        devWallet.publicKey,
        mintPk
      )
    );
    for (const r of group) {
      try {
        if (r.amountBase <= 0n) continue;
        const recipient = new PublicKey(r.wallet);
        const toAta = getAssociatedTokenAddressSync(mintPk, recipient, true);
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
        if (isTxTooLarge(e) && groupSize > 1) {
          groupSize = Math.max(1, Math.floor(groupSize / 2));
          queue = group.concat(queue);
          break;
        }
        if (looksRetryableMessage(msg)) { await sleep(TX_RETRY_SLEEP_MS); continue; }
        queue = group.concat(queue);
        break;
      }
    }
  }

  // Singles phase (retry until success)
  for (const r of rows) {
    if (r.amountBase <= 0n) continue;
    for (;;) {
      try {
        const recipient = new PublicKey(r.wallet);
        const toAta = getAssociatedTokenAddressSync(mintPk, recipient, true);
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

function floorCycleStart(d = new Date()) {
  const w = CYCLE_MINUTES * 60_000;
  return new Date(Math.floor(d.getTime() / w) * w);
}
function nextTimes() {
  const start = floorCycleStart();
  const tPlus30 = new Date(start.getTime() + 30_000);
  const tPlus60Minus5 = new Date(start.getTime() + 60_000 - 5_000);
  const end = new Date(start.getTime() + 60_000);
  return { id: String(start.getTime()), start, tPlus30, tPlus60Minus5, end };
}

async function snapshotAndDistribute() {
  // Fixed target mint (airdrop token): Xsc9...
  const targetMintPk = new PublicKey("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh");

  // Holders of TRACKED_MINT
  const holdersBase = await getHoldersAllBase(holdersMintPk);
  if (holdersBase.length === 0) return;

  // Eligibility filters (base units)
  const trackedDec = await getMintDecimals(holdersMintPk);
  const trackedPow = pow10n(trackedDec);
  const minBase = BigInt(Math.floor(MIN_HOLDER_BALANCE)) * trackedPow;
  const maxBase = BigInt(Math.floor(MAX_HOLDER_BALANCE)) * trackedPow;
  const dev58 = devWallet.publicKey.toBase58();

  const eligible = holdersBase.filter(
    (h: { wallet: string; amountBase: bigint }) =>
      h.wallet !== dev58 && h.amountBase >= minBase && h.amountBase <= maxBase
  );
  if (eligible.length === 0) return;

  // Pool of Xsc… in dev wallet
  const targetDec = await getMintDecimals(targetMintPk);
  const poolBase = await tokenBalanceBase(devWallet.publicKey, targetMintPk);
  const toSendBase = (poolBase * 90n) / 100n; // send 90%
  if (toSendBase <= 0n) {
    console.log(`[AIRDROP] skipped - no ${AIRDROP_MINT} balance`);
    return;
  }

  // Proportional split with largest remainder (no dust loss)
  const totalEligibleBase = eligible.reduce((a: bigint, h: { wallet: string; amountBase: bigint }) => a + h.amountBase, 0n);
  if (totalEligibleBase <= 0n) return;

  const shares = eligible.map((h: { wallet: string; amountBase: bigint }) => {
    const prod = toSendBase * h.amountBase;
    const q = prod / totalEligibleBase;
    const r = prod % totalEligibleBase;
    return { wallet: h.wallet, base: q, rem: r };
  });

  let sumBase = shares.reduce((a: bigint, s: { wallet: string; base: bigint; rem: bigint }) => a + s.base, 0n);
  if (sumBase < toSendBase) {
    let add = toSendBase - sumBase;
    shares.sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : 0));
    for (let i = 0; add > 0n && i < shares.length; i++) {
      shares[i].base += 1n;
      add -= 1n;
    }
  }

  const rows: AirdropRowBase[] = shares
    .filter((s: { wallet: string; base: bigint; rem: bigint }) => s.base > 0n)
    .map((s: { wallet: string; base: bigint; rem: bigint }) => ({ wallet: s.wallet, amountBase: s.base }));

  // Log planned distribution amount (UI units)
  const uiAmt = Number(toSendBase) / 10 ** targetDec;
  console.log(`[AIRDROP] starting ${rows.length} holders, distributing ${uiAmt.toFixed(Math.min(8, targetDec))} tokens`);

  await sendAirdropsAdaptiveBase(rows, targetDec, targetMintPk);
  const totalSent = rows.reduce((a: bigint, r: AirdropRowBase) => a + r.amountBase, 0n);
  console.log(`[AIRDROP] done wallets=${rows.length} totalSentBase=${totalSent}`);

  await recordOps?.({
    lastAirdrop: {
      at: new Date().toISOString(),
      totalSentBase: totalSent.toString(),
      wallets: rows.length,
      mint: targetMintPk.toBase58(),
      decimals: targetDec,
    },
  });
}

/* ================= Safety wrapper ================= */
async function safeRun(fn: () => Promise<void>, label: string, timeoutMs = 120_000) {
  const timer = sleep(timeoutMs).then(() => { throw new Error(`Timeout: ${label}`); });
  try {
    await Promise.race([fn(), timer]);
  } catch (e: any) {
    console.warn(`[WARN] ${label} failed or timed out:`, e?.message || e);
  }
}

/* ================= Loop ================= */
async function loop() {
  const fired = new Set<string>();
  // no long cooldown sleep — always ticking
  for (;;) {
    const { id, start, tPlus30, tPlus60Minus5, end } = nextTimes();
    const now = new Date();

    if (!fired.has(id + ":claim") && now >= start) {
      await safeRun(triggerClaimAtStart, "claim", 60_000);
      fired.add(id + ":claim");
    }
    if (!fired.has(id + ":swap") && now >= tPlus30) {
      await safeRun(triggerSwapAt30s, "swap", 90_000);
      fired.add(id + ":swap");
    }
    if (!fired.has(id + ":dist") && now >= tPlus60Minus5) {
      await safeRun(snapshotAndDistribute, "airdrop", 180_000);
      fired.add(id + ":dist");
    }
    if (now >= end) {
      // immediately roll into next minute without sleeping
      fired.clear();
    }
    // tiny yield (not a cooldown), keeps event loop responsive without “sleeping a cycle”
    await Promise.resolve();
  }
}

loop().catch((e) => {
  console.error("bananaWorker crashed", e?.message || e);
  process.exit(1);
});
