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
const AIRDROP_MINT =
  process.env.AIRDROP_MINT ||
  "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh"; // target coin for swap + airdrop

const REWARD_WALLET = process.env.REWARD_WALLET || "";
const DEV_WALLET_PRIVATE_KEY = process.env.DEV_WALLET_PRIVATE_KEY || "";

// Airdrop holder filters
const MIN_HOLDER_BALANCE = Number(process.env.MIN_HOLDER_BALANCE ?? 100_000);
const MAX_HOLDER_BALANCE = Number(process.env.MAX_HOLDER_BALANCE ?? 50_000_000);

const HELIUS_RPC =
  process.env.HELIUS_RPC ||
  `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ""}`;
const QUICKNODE_RPC = process.env.QUICKNODE_RPC || "";

const PUMPORTAL_KEY = (process.env.PUMPORTAL_KEY || "").trim();
const PUMPORTAL_BASE = "https://pumpportal.fun";

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const ADMIN_OPS_URL = process.env.ADMIN_OPS_URL || "";

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
  console.warn(
    `[WARN] REWARD_WALLET (${REWARD_WALLET}) != DEV wallet (${devWallet.publicKey.toBase58()}).`
  );
}

/* ================= Utils ================= */
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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
      c = (connection = rotateConnection());
      await sleep(250 * (i + 1));
    }
  }
  throw lastErr;
}

/* ================= Admin ops ================= */
async function recordOps(partial: { lastClaim?: any; lastSwap?: any; lastAirdrop?: any }) {
  if (!ADMIN_SECRET || !ADMIN_OPS_URL) return;
  try {
    const res = await fetch(ADMIN_OPS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": ADMIN_SECRET },
      body: JSON.stringify(partial),
    });
    if (!res.ok) console.error(`[OPS] ${res.status}: ${await res.text()}`);
  } catch (e: any) {
    console.error("[OPS] Network error:", e?.message || e);
  }
}

/* ================= PumpPortal ================= */
function portalUrl(path: string) {
  const u = new URL(path, PUMPORTAL_BASE);
  if (PUMPORTAL_KEY && !u.searchParams.has("api-key"))
    u.searchParams.set("api-key", PUMPORTAL_KEY);
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
async function getHoldersAll(mint: string) {
  const mintPk = new PublicKey(mint);
  async function scan(programId: string, addFilter165 = false) {
    const filters: any[] = [{ memcmp: { offset: 0, bytes: mintPk.toBase58() } }];
    if (addFilter165) filters.unshift({ dataSize: 165 });
    const accs = (await withConnRetries((c) =>
      c.getParsedProgramAccounts(new PublicKey(programId), { filters })
    )) as any[];
    const out: Record<string, number> = {};
    for (const it of accs) {
      const info: any = it?.account?.data?.parsed?.info;
      const owner = info?.owner;
      const ta = info?.tokenAmount;
      const amt = Number(ta?.uiAmount ?? ta?.uiAmountString ?? 0);
      if (!owner || !(amt > 0)) continue;
      out[owner] = (out[owner] ?? 0) + amt;
    }
    return out;
  }
  const merged: Record<string, number> = {};
  try {
    Object.entries(await scan("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", true)).forEach(
      ([k, v]) => (merged[k] = (merged[k] ?? 0) + v)
    );
  } catch {}
  try {
    Object.entries(await scan("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCx2w6G3W", false)).forEach(
      ([k, v]) => (merged[k] = (merged[k] ?? 0) + v)
    );
  } catch {}
  return Object.entries(merged)
    .map(([wallet, balance]) => ({ wallet, balance }))
    .filter((r) => r.balance > 0);
}

async function tokenBalance(owner: PublicKey, mintPk: PublicKey) {
  const resp = await withConnRetries((c) =>
    c.getParsedTokenAccountsByOwner(owner, { mint: mintPk }, "confirmed")
  );
  let total = 0;
  for (const it of (resp as any).value) {
    const amt = Number((it as any).account.data.parsed.info.tokenAmount.uiAmount || 0);
    total += amt;
  }
  return total;
}

async function getMintDecimals(mintPk: PublicKey): Promise<number> {
  const info = await withConnRetries((c) => c.getParsedAccountInfo(mintPk, "confirmed"));
  const parsed: any = (info?.value as any)?.data?.parsed;
  const dec = parsed?.info?.decimals;
  if (typeof dec !== "number") throw new Error("Unable to fetch mint decimals");
  return dec;
}

/* ================= Jupiter ================= */
const JUP_BASE = process.env.JUP_BASE || "https://lite-api.jup.ag/swap/v1";
const JUP_QUOTE = `${JUP_BASE}/quote`;
const JUP_SWAP = `${JUP_BASE}/swap`;

async function fetchJsonWithTimeout(url: string, opts: RequestInit = {}, timeoutMs = 5000) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal as any });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return await r.json();
  } finally {
    clearTimeout(id);
  }
}
async function postJson(url: string, body: any, timeoutMs = 7000) {
  return await withRetries(
    () =>
      fetchJsonWithTimeout(
        url,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        timeoutMs
      ),
    3
  );
}
async function jupQuoteSolToToken(outMint: string, solUiAmount: number, slippageBps: number) {
  const amountLamports = Math.max(1, Math.floor(solUiAmount * LAMPORTS_PER_SOL));
  const url = `${JUP_QUOTE}?inputMint=So11111111111111111111111111111111111111112&outputMint=${outMint}&amount=${amountLamports}&slippageBps=${slippageBps}&enableDexes=pump,meteora,raydium&onlyDirectRoutes=false&swapMode=ExactIn`;
  return await withRetries(async () => {
    const j: any = await fetchJsonWithTimeout(url, {}, 6000);
    if (!j?.routePlan?.length) throw new Error("no route");
    return j;
  }, 3);
}
async function jupSwap(conn: Connection, signer: Keypair, quoteResp: any) {
  const swapReq = {
    quoteResponse: quoteResp,
    userPublicKey: signer.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: "auto",
  };
  const jr: any = await postJson(JUP_SWAP, swapReq, 8000);
  const txBytes = Uint8Array.from(Buffer.from(jr.swapTransaction, "base64"));
  const tx = VersionedTransaction.deserialize(txBytes);
  tx.sign([signer]);
  const sig = await withRetries(async () => {
    const s = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await conn.confirmTransaction(s, "confirmed");
    return s;
  }, 3);
  return sig;
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

/* ================= Claim / Swap / Airdrop ================= */
let lastClaimState: null | { cycleId: string; preSol: number; claimedSol: number; claimSig: string | null } =
  null;

async function triggerClaimAtStart() {
  const cycleId = String(floorCycleStart().getTime());
  const preSol = await getSolBalance(connection, devWallet.publicKey);
  const { res, json } = await withRetries(() =>
    callPumportal(
      "/api/trade",
      { action: "collectCreatorFee", priorityFee: 0.000001, pool: "pump", mint: TRACKED_MINT },
      `claim:${cycleId}`
    )
  );
  if (!res.ok) throw new Error(`Claim failed: ${JSON.stringify(json)}`);
  const claimSig = extractSig(json);
  const { postSol, deltaSol } = await pollSolDelta(connection, devWallet.publicKey, preSol);
  const claimedSol = Math.max(0, deltaSol);
  console.log(`[CLAIM] delta=${claimedSol} SOL | ${claimSig}`);
  lastClaimState = { cycleId, preSol, claimedSol, claimSig };
  await recordOps({
    lastClaim: { at: new Date().toISOString(), amountSol: claimedSol, tx: claimSig },
  });
}

async function triggerSwapAt30s() {
  if (!lastClaimState || lastClaimState.claimedSol <= 0) return;
  const claimedSol = lastClaimState.claimedSol;
  const reserve = 0.02;
  const curSol = await getSolBalance(connection, devWallet.publicKey);
  const available = Math.max(0, curSol - reserve);
  const targetSpend = Math.min(claimedSol * 0.7, available);
  if (targetSpend < 0.00001) return;
  let sig = null;
  for (const s of [100, 200, 500, 800]) {
    try {
      const q = await jupQuoteSolToToken(AIRDROP_MINT, targetSpend, s);
      sig = await jupSwap(connection, devWallet, q);
      console.log(`[SWAP] ${targetSpend} SOL -> ${AIRDROP_MINT} | ${sig}`);
      break;
    } catch {}
  }
  await recordOps({
    lastSwap: { at: new Date().toISOString(), spentSol: targetSpend, tx: sig },
  });
}

const PRIORITY_FEE_MICRO_LAMPORTS = Number(process.env.PRIORITY_FEE_MICRO_LAMPORTS ?? 10_000);
const COMPUTE_UNIT_LIMIT = Number(process.env.COMPUTE_UNIT_LIMIT ?? 800_000);

function isTxTooLarge(err: any) {
  const m = String(err?.message || "").toLowerCase();
  return m.includes("tx too large") || m.includes("transaction too large");
}

async function sendAirdropBatch(ixs: any[]) {
  return await withRetries(async () => {
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
  });
}

/* bulletproof adaptive sender */
async function sendAirdropsAdaptive(rows: any[], decimals: number) {
  const factor = 10 ** decimals;
  const uiToBase = (x: number) => BigInt(Math.floor(x * factor));
  const fromAta = getAssociatedTokenAddressSync(airdropMintPk, devWallet.publicKey, false);
  let queue = rows.slice();
  const failed: any[] = [];
  let groupSize = 10;

  while (queue.length > 0) {
    const group = queue.splice(0, Math.min(groupSize, queue.length));
    const ixs: any[] = [];
    for (const r of group) {
      try {
        const recipient = new PublicKey(r.wallet);
        const toAta = getAssociatedTokenAddressSync(airdropMintPk, recipient, true);
        const amountBase = uiToBase(r.amountUi);
        if (amountBase <= 0n) continue;
        ixs.push(
          createAssociatedTokenAccountIdempotentInstruction(devWallet.publicKey, toAta, recipient, airdropMintPk),
          createTransferCheckedInstruction(fromAta, airdropMintPk, toAta, devWallet.publicKey, amountBase, decimals)
        );
      } catch (e) {
        console.warn(`[AIRDROP] skip bad wallet ${r.wallet}`);
      }
    }
    try {
      const sig = await sendAirdropBatch(ixs);
      console.log(`[AIRDROP] batch (${ixs.length / 2}) | ${sig}`);
      if (groupSize < 10) groupSize++;
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (isTxTooLarge(e) && groupSize > 1) {
        groupSize = Math.max(1, Math.floor(groupSize / 2));
        queue = group.concat(queue);
      } else if (looksRetryableMessage(msg)) {
        queue = group.concat(queue);
      } else {
        failed.push(...group);
      }
    }
  }

  // retry singles
  for (let round = 0; round < 5 && failed.length > 0; round++) {
    const still: any[] = [];
    for (const r of failed.splice(0)) {
      try {
        const recipient = new PublicKey(r.wallet);
        const toAta = getAssociatedTokenAddressSync(airdropMintPk, recipient, true);
        const amountBase = uiToBase(r.amountUi);
        const sig = await sendAirdropBatch([
          createAssociatedTokenAccountIdempotentInstruction(devWallet.publicKey, toAta, recipient, airdropMintPk),
          createTransferCheckedInstruction(fromAta, airdropMintPk, toAta, devWallet.publicKey, amountBase, decimals),
        ]);
        console.log(`[AIRDROP] single ${recipient.toBase58()} | ${sig}`);
      } catch (e: any) {
        still.push(r);
      }
    }
    if (still.length) {
      failed.push(...still);
      await sleep(1000);
    }
  }
  if (failed.length > 0) console.warn(`[AIRDROP] ${failed.length} recipients failed after retries`);
}

async function snapshotAndDistribute() {
  const holdersRaw = await getHoldersAll(TRACKED_MINT);
  const holders = holdersRaw.filter(
    (h) => h.balance >= MIN_HOLDER_BALANCE && h.balance <= MAX_HOLDER_BALANCE
  );
  if (holders.length === 0) return;

  const poolUi = await tokenBalance(devWallet.publicKey, airdropMintPk);
  const toSendUi = Math.floor(poolUi * 0.9);
  if (toSendUi <= 0) return;

  const totalEligible = holders.reduce((a, h) => a + h.balance, 0);
  const rows = holders
    .map((h) => ({
      wallet: h.wallet,
      amountUi: Math.floor((toSendUi * h.balance) / totalEligible),
    }))
    .filter((r) => r.amountUi > 0);

  const decimals = await getMintDecimals(airdropMintPk);
  await sendAirdropsAdaptive(rows, decimals);

  const totalSent = rows.reduce((a, r) => a + r.amountUi, 0);
  await recordOps({
    lastAirdrop: {
      at: new Date().toISOString(),
      totalSentUi: totalSent,
      wallets: rows.length,
      mint: AIRDROP_MINT,
    },
  });
  console.log(`[AIRDROP] done ${rows.length} wallets totalSent=${totalSent}`);
}

/* ================= Loop ================= */
async function loop() {
  const fired = new Set<string>();
  for (;;) {
    const { id, start, tPlus30, tPlus60Minus5, end } = nextTimes();
    const now = new Date();
    if (!fired.has(id + ":claim") && now >= start) {
      try {
        await triggerClaimAtStart();
      } catch (e) {
        console.error("Claim error:", e);
      }
      fired.add(id + ":claim");
    }
    if (!fired.has(id + ":swap") && now >= tPlus30) {
      try {
        await triggerSwapAt30s();
      } catch (e) {
        console.error("Swap error:", e);
      }
      fired.add(id + ":swap");
    }
    if (!fired.has(id + ":dist") && now >= tPlus60Minus5) {
      try {
        await snapshotAndDistribute();
      } catch (e) {
        console.error("Airdrop error:", e);
      }
      fired.add(id + ":dist");
    }
    if (now >= end) {
      console.log("[CYCLE] cooldown 60s...");
      await sleep(60_000); // cooldown
      fired.clear();
    }
    await sleep(1000);
  }
}

loop().catch((err) => {
  console.error("bananaWorker crashed:", err);
  process.exit(1);
});
