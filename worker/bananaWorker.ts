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
const AIRDROP_MINT = process.env.AIRDROP_MINT || "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
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

const _BATCH_SIZE = Number(process.env._BATCH_SIZE ?? 8);
const _MAX_BATCH_RETRIES = Number(process.env._MAX_BATCH_RETRIES ?? 3);
const _MIN_TX_GAP_MS = Number(process.env._MIN_TX_GAP_MS ?? 1200);

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
      if (m === "HTTP_429" || looksRetryable(m)) {
        await sleep(JUP_429_SLEEP_MS * (i + 1));
        continue;
      }
      if (i === JUP_MAX_TRIES - 1) throw e;
    }
  }
  throw new Error("swap_failed");
}

/* ================= HOLDERS ================= */
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

/* ================= AIRDROP (PROPORTIONAL, PARALLEL 8×8 WITH RETRIES) ================= */
async function simpleAirdropProportional(
  mint: PublicKey,
  weightsIn: Array<{ wallet: string; weight: bigint }>
) {
  const seen = new Set<string>();
  const weights = weightsIn.filter(it => {
    const w = it.wallet;
    if (!w) return false;
    if (w === devWallet.publicKey.toBase58()) return false;
    if (seen.has(w)) return false;
    if (it.weight <= 0n) return false;
    seen.add(w);
    return true;
  });

  if (!weights.length) return console.log("⚪ [AIRDROP] No eligible holders.");

  const info = await withRetries(c => c.getAccountInfo(mint, "confirmed"), 5);
  if (!info) throw new Error("Mint account not found");
  const is22 = info.owner.equals(TOKEN_2022_PROGRAM_ID);
  const tokenProgram = is22 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const mintInfo = await withRetries(c => getMint(c, mint, "confirmed", tokenProgram), 5);
  const decimals = mintInfo.decimals;

  const poolBase = await tokenBalanceBase(devWallet.publicKey, mint);
  if (poolBase <= 0n) return console.log("⚪ [AIRDROP] No token balance.");

  const toSend = (poolBase * 90n) / 100n;
  const totalWeight = weights.reduce((acc, it) => acc + it.weight, 0n);
  if (totalWeight <= 0n) return console.log("⚪ [AIRDROP] Total weight is zero.");

  console.log(
    `🎯 [AIRDROP] ${weights.length} eligible | Total ${(Number(toSend) / 10 ** decimals).toFixed(6)} tokens | Proportional`
  );

  const fromAta = getAssociatedTokenAddressSync(
    mint,
    devWallet.publicKey,
    false,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const BATCH = 8;
  const PARALLEL = 8;
  const MAX_RETRIES = 3;

  const groups: Array<typeof weights> = [];
  for (let i = 0; i < weights.length; i += BATCH) groups.push(weights.slice(i, i + BATCH));

  let pending = [...groups];
  let attempt = 0;

  while (pending.length > 0 && attempt < MAX_RETRIES) {
    attempt++;
    console.log(`🚀 [AIRDROP] Sending ${pending.length} batches (attempt ${attempt})`);

    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const txs = pending.map((group, gi) => {
      const ixs: any[] = [
        createAssociatedTokenAccountIdempotentInstruction(devWallet.publicKey, fromAta, devWallet.publicKey, mint, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID),
      ];

      for (const { wallet, weight } of group) {
        try {
          const to = new PublicKey(wallet);
          const toAta = getAssociatedTokenAddressSync(mint, to, true, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
          const amt = (toSend * weight) / totalWeight;
          if (amt <= 0n) continue;
          ixs.push(
            createAssociatedTokenAccountIdempotentInstruction(devWallet.publicKey, toAta, to, mint, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID),
            createTransferCheckedInstruction(fromAta, mint, toAta, devWallet.publicKey, amt, decimals, [], tokenProgram)
          );
        } catch (e) {
          console.warn(`[AIRDROP] invalid ${wallet}: ${String((e as any)?.message || e)}`);
        }
      }

      if (ixs.length <= 1) return null;
      const tx = new Transaction();
      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICRO_LAMPORTS }),
        ...ixs
      );
      tx.feePayer = devWallet.publicKey;
      tx.recentBlockhash = blockhash;
      tx.sign(devWallet);
      return { tx, label: `batch#${gi + 1}` };
    }).filter((x): x is { tx: Transaction; label: string } => !!x);

    const nextRound: typeof pending = [];

    for (let i = 0; i < txs.length; i += PARALLEL) {
      const wave = txs.slice(i, i + PARALLEL);
      console.log(`🌊 [AIRDROP] Sending wave ${i / PARALLEL + 1}/${Math.ceil(txs.length / PARALLEL)} (${wave.length} txs)`);

      const results = await Promise.allSettled(
        wave.map(async ({ tx, label }) => {
          try {
            const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
            await connection.confirmTransaction(sig, "confirmed");
            console.log(`✅ [AIRDROP] ${label} confirmed | ${sig}`);
            return true;
          } catch (e: any) {
            console.warn(`⚠️ [AIRDROP] ${label} failed: ${String(e?.message || e)}`);
            return false;
          }
        })
      );

      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.status === "fulfilled" && !r.value) nextRound.push(pending[i + j]);
      }

      await sleep(1000);
    }

    if (nextRound.length > 0) {
      console.log(`🔁 [AIRDROP] Retrying ${nextRound.length} failed batches...`);
      pending = nextRound;
      await sleep(2000);
    } else break;
  }

  if (pending.length > 0) console.warn(`❌ [AIRDROP] ${pending.length} batches still failed after ${MAX_RETRIES} retries.`);
  else console.log("🎉 [AIRDROP] Proportional complete.");
}

/* ================= CLAIM / SWAP / LOOP ================= */
let lastClaimState: null | { claimedSol: number; claimSig: string | null } = null;

async function triggerClaimAtStart() {
  console.log("💰 [CLAIM] Collecting creator fees...");
  const preSol = await getSolBalance(connection, devWallet.publicKey);
  const { res, json } = await callPumportal("/api/trade", { action: "collectCreatorFee", priorityFee: 0.000001, pool: "pump", mint: TRACKED_MINT }, `claim:${Date.now()}`);
  if (!res.ok) throw new Error(`Claim failed ${res.status}`);
  const claimSig = extractSig(json);
  await sleep(3000);
  const postSol = await getSolBalance(connection, devWallet.publicKey);
  const delta = Math.max(0, parseFloat((postSol - preSol).toFixed(6)));
  console.log(delta > 0 ? `🟢 [CLAIM] Claimed ${delta} SOL | Tx: ${claimSig}` : `⚪ [CLAIM] 0 SOL change | Tx: ${claimSig}`);
  lastClaimState = { claimedSol: delta, claimSig };
}

async function triggerSwap() {
  console.log("🔄 [SWAP] Initiating swap check...");

  const claimed = lastClaimState?.claimedSol ?? 0;
  if (claimed <= 0.000001) {
    console.log("⚪ [SWAP] Skipped — no new SOL claimed this cycle.");
    return;
  }

  const spend = claimed * 0.7;
  console.log(`💧 [SWAP] Preparing to swap ${spend.toFixed(6)} SOL from last claim of ${claimed.toFixed(6)} SOL`);

  try {
    const q = await jupQuoteSolToToken(AIRDROP_MINT, spend, 300);
    const sig = await jupSwap(connection, devWallet, q);
    console.log(`✅ [SWAP] Swapped ${spend.toFixed(4)} SOL → ${AIRDROP_MINT} | Tx: ${sig}`);
  } catch (e: any) {
    console.error(`❌ [SWAP] Failed: ${e?.message || e}`);
  }
}

/* ================= SNAPSHOT & DISTRIBUTE ================= */
async function snapshotAndDistribute() {
  console.log("🎁 [AIRDROP] Snapshotting holders...");

  const holdersAll = await getHoldersAllBase(holdersMintPk);
  if (!holdersAll.length) return console.log("⚪ [AIRDROP] No holders found.");

  const trackedInfo = await withRetries(c => c.getAccountInfo(holdersMintPk, "confirmed"), 5);
  if (!trackedInfo) throw new Error("Tracked mint account not found");
  const trackedIs22 = trackedInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
  const trackedProgram = trackedIs22 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const trackedMintInfo = await withRetries(c => getMint(c, holdersMintPk, "confirmed", trackedProgram), 5);
  const trackedDecimals = trackedMintInfo.decimals;

  const scale = 10n ** BigInt(trackedDecimals);
  const MIN_BASE = 100_000n * scale;
  const MAX_BASE = 50_000_000n * scale;

  const eligible = holdersAll
    .filter(h => h.amountBase >= MIN_BASE && h.amountBase <= MAX_BASE)
    .map(h => ({ wallet: h.wallet, weight: h.amountBase }));

  if (!eligible.length) return console.log("⚪ [AIRDROP] No eligible holders after blacklist.");

  await simpleAirdropProportional(airdropMintPk, eligible);
}

/* ================= MAIN LOOP ================= */
async function loop() {
  while (true) {
    try {
      console.log("\n================= 🚀 NEW CYCLE =================");
      await triggerClaimAtStart();
      console.log("⏳ 30s pause → next: SWAP");
      await sleep(30_000);
      await triggerSwap();
      console.log("⏳ 30s pause → next: AIRDROP");
      await sleep(30_000);
      await snapshotAndDistribute();
      console.log("🕐 60s cooldown before next cycle...");
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
