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
  ComputeBudgetProgram, // <— added previously
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
const REWARD_WALLET = process.env.REWARD_WALLET || ""; // should match dev wallet pubkey
const DEV_WALLET_PRIVATE_KEY = process.env.DEV_WALLET_PRIVATE_KEY || "";

// Airdrop: optionally exclude whales above this UI balance (keeps tx size sane)
const AUTO_BLACKLIST_BALANCE = Number(process.env.AUTO_BLACKLIST_BALANCE ?? 50_000_000);

const HELIUS_RPC =
  process.env.HELIUS_RPC ||
  `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ""}`;
const QUICKNODE_RPC = process.env.QUICKNODE_RPC || ""; // optional failover

// PumpPortal (claim only)
const PUMPORTAL_KEY = (process.env.PUMPORTAL_KEY || "").trim();
const PUMPORTAL_BASE = "https://pumpportal.fun";

// Front page ops
const ADMIN_SECRET  = process.env.ADMIN_SECRET || "";
const ADMIN_OPS_URL = process.env.ADMIN_OPS_URL || "";

/* ===== guards ===== */
if (!TRACKED_MINT || !REWARD_WALLET || !DEV_WALLET_PRIVATE_KEY) {
  throw new Error("Missing TRACKED_MINT, REWARD_WALLET, or DEV_WALLET_PRIVATE_KEY");
}
if (!HELIUS_RPC) throw new Error("Missing HELIUS_RPC / HELIUS_API_KEY");

/* ================= Connection / Keys ================= */
const RPCS = [HELIUS_RPC, QUICKNODE_RPC].filter(Boolean);
let rpcIdx = 0;
function newConnection(): Connection { return new Connection(RPCS[rpcIdx]!, "confirmed"); }
function rotateConnection(): Connection { rpcIdx = (rpcIdx + 1) % RPCS.length; return new Connection(RPCS[rpcIdx]!, "confirmed"); }
let connection = newConnection();

// accept JSON array secret or bs58
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
    `[WARN] REWARD_WALLET (${REWARD_WALLET}) != DEV wallet (${devWallet.publicKey.toBase58()}). Airdrop spends from DEV wallet ATA.`
  );
}

/* ================= Small Utils ================= */
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function floorCycleStart(d = new Date()) {
  const w = CYCLE_MINUTES * 60_000;
  return new Date(Math.floor(d.getTime() / w) * w);
}
function nextTimes() {
  const start = floorCycleStart();
  const end   = new Date(start.getTime() + CYCLE_MINUTES * 60_000);
  return {
    id: String(start.getTime()),
    start,
    end,
    tMinus90: new Date(end.getTime() - 90_000),  // claim/swap at t-1:30
    tMinus5:  new Date(end.getTime() - 5_000),   // airdrop at t-5s
  };
}
function looksRetryableMessage(msg: string) {
  return /rate.?limit|429|timeout|temporar|connection|ECONNRESET|ETIMEDOUT|blockhash|Node is behind|Transaction was not confirmed|FetchError|TLS|ENOTFOUND|EAI_AGAIN/i.test(msg);
}
async function withRetries<T>(fn: () => Promise<T>, attempts = 5, baseMs = 350): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e: any) {
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
    try { return await fn(c); }
    catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (i === attempts - 1 || !looksRetryableMessage(msg) || RPCS.length <= 1) break;
      c = connection = rotateConnection();
      await sleep(250 * (i + 1));
    }
  }
  throw lastErr;
}

/* ================= Admin ops → front page ================= */
async function recordOps(partial: { lastClaim?: any; lastSwap?: any; lastAirdrop?: any }) {
  if (!ADMIN_SECRET || !ADMIN_OPS_URL) {
    console.warn("[OPS] Skipped: missing ADMIN_SECRET or ADMIN_OPS_URL");
    return;
  }
  try {
    const res = await fetch(ADMIN_OPS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": ADMIN_SECRET },
      body: JSON.stringify(partial),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[OPS] POST ${res.status}: ${text}`);
    } else {
      console.log(`[OPS] OK -> ${Object.keys(partial).join(", ")} | ${text}`);
    }
  } catch (e: any) {
    console.error("[OPS] Network error:", e?.message || e);
  }
}


/* ================= PumpPortal (claim only) ================= */
function portalUrl(path: string) {
  const u = new URL(path, PUMPORTAL_BASE);
  if (PUMPORTAL_KEY && !u.searchParams.has("api-key")) u.searchParams.set("api-key", PUMPORTAL_KEY);
  return u.toString();
}
async function callPumportal(path: string, body: any, idemKey: string) {
  if (!PUMPORTAL_KEY) throw new Error("Missing PumpPortal API key for claim");
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
  try { json = text ? JSON.parse(text) : {}; } catch {}
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
    const accs = await withConnRetries(c =>
      c.getParsedProgramAccounts(new PublicKey(programId), { filters, commitment: "confirmed" })
    ) as any[];
    const out: Record<string, number> = {};
    for (const it of accs) {
      const info: any = it?.account?.data?.parsed?.info;
      const owner = info?.owner;
      const ta = info?.tokenAmount;
      const amt = typeof ta?.uiAmount === "number" ? ta.uiAmount : Number(ta?.uiAmountString ?? 0);
      if (!owner || !(amt > 0)) continue;
      out[owner] = (out[owner] ?? 0) + amt;
    }
    return out;
  }

  const merged: Record<string, number> = {};
  try { Object.entries(await scan("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", true)).forEach(([k, v]) => merged[k] = (merged[k] ?? 0) + Number(v)); } catch {}
  try { Object.entries(await scan("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCx2w6G3W", false)).forEach(([k, v]) => merged[k] = (merged[k] ?? 0) + Number(v)); } catch {}

  return Object.entries(merged)
    .map(([wallet, balance]) => ({ wallet, balance: Number(balance) }))
    .filter(r => r.balance > 0);
}

async function tokenBalance(owner: PublicKey) {
  const resp = await withConnRetries(c => c.getParsedTokenAccountsByOwner(owner, { mint: mintPubkey }, "confirmed")) as any;
  let total = 0;
  for (const it of resp.value as any[]) {
    const parsed: any = (it.account.data as any)?.parsed?.info?.tokenAmount;
    const v = typeof parsed?.uiAmount === "number" ? parsed.uiAmount : Number(parsed?.uiAmountString ?? 0);
    total += v || 0;
  }
  return total;
}

async function getMintDecimals(mintPk: PublicKey): Promise<number> {
  const info = await withConnRetries(c => c.getParsedAccountInfo(mintPk, "confirmed")) as any;
  const dec = info?.value?.data?.parsed?.info?.decimals;
  if (typeof dec !== "number") throw new Error("Unable to fetch mint decimals");
  return dec;
}

/* ================= Jupiter (quote + swap) ================= */
// Use Jupiter LITE (no key) for both quote + swap
const JUP_BASE = process.env.JUP_BASE || "https://lite-api.jup.ag";
const JUP_QUOTE = `${JUP_BASE}/v6/quote`;
const JUP_SWAP  = `${JUP_BASE}/v6/swap`;

// small helper with hard timeout (prevents hung fetches)
async function fetchJsonWithTimeout(
  url: string,
  opts: RequestInit = {},
  timeoutMs = 5000
): Promise<any> {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
  try {
    const r = await fetch(url, {
      ...opts,
      headers: { Accept: "application/json", ...(opts.headers || {}) },
      signal: ac.signal as any,
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return await r.json();
  } finally {
    clearTimeout(id);
  }
}

// POST helper with timeout & retries
async function postJson(url: string, body: any, timeoutMs = 7000) {
  return await withRetries(
    () =>
      fetchJsonWithTimeout(
        url,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        timeoutMs
      ),
    3,
    350
  );
}

async function jupQuoteSolToToken(outMint: string, solUiAmount: number, slippageBps: number) {
  const inputMint = "So11111111111111111111111111111111111111112";
  const amountLamports = Math.max(1, Math.floor(solUiAmount * LAMPORTS_PER_SOL));
  const url =
    `${JUP_QUOTE}?inputMint=${inputMint}` +
    `&outputMint=${outMint}` +
    `&amount=${amountLamports}` +
    `&slippageBps=${slippageBps}` +
    `&enableDexes=pump,meteora,raydium` +
    `&onlyDirectRoutes=false` +
    `&swapMode=ExactIn`; // explicit
  // retry the quote 3x with a short backoff and a hard timeout
  return await withRetries(async () => {
    const j: any = await fetchJsonWithTimeout(
      url,
      { headers: { "Cache-Control": "no-cache" } },
      6000
    );
    if (!j?.routePlan?.length) throw new Error("no route");
    return j;
  }, 3, 300);
}

async function jupSwap(conn: Connection, signer: Keypair, quoteResp: any) {
  const swapReq = {
    quoteResponse: quoteResp,
    userPublicKey: signer.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: "auto",
  };

  // Single LITE endpoint with retries
  const jr: any = await postJson(JUP_SWAP, swapReq, 8000);
  const swapTransaction = jr.swapTransaction;
  const txBytes = Uint8Array.from(Buffer.from(swapTransaction, "base64"));
  const tx = VersionedTransaction.deserialize(txBytes);
  tx.sign([signer]);

  // send + confirm with retries
  const sig = await withRetries(
    async () => {
      const s = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
      await conn.confirmTransaction(s, "confirmed");
      return s;
    },
    3,
    400
  );
  return sig;
}

/* ================= SOL balance helpers ================= */
async function getSolBalance(conn: Connection, pubkey: PublicKey, comm: "confirmed" | "finalized" = "confirmed") {
  return (await conn.getBalance(pubkey, comm)) / LAMPORTS_PER_SOL;
}
async function pollSolDelta(conn: Connection, owner: PublicKey, preSol: number) {
  for (let i = 0; i < 18; i++) {
    const b = await getSolBalance(conn, owner);
    const d = Math.max(0, b - preSol);
    if (d > 0) return { postSol: b, deltaSol: d };
    await sleep(900);
  }
  const b = await getSolBalance(conn, owner);
  return { postSol: b, deltaSol: Math.max(0, b - preSol) };
}

/* ================= Claim + Swap (T-90s) ================= */
async function triggerClaimAndSwap90() {
  const cycleId = String(floorCycleStart().getTime());
  if (!PUMPORTAL_KEY) {
    console.warn("[CLAIM] Skipping claim; no PumpPortal key.");
    return { claimedSol: 0, swapSig: null, claimSig: null };
  }

  // 1) pre-claim SOL snapshot
  const preSol = await getSolBalance(connection, devWallet.publicKey);

  // 2) Claim creator rewards via PumpPortal
  const { res: claimRes, json: claimJson } = await withRetries(
    () => callPumportal(
      "/api/trade",
      { action: "collectCreatorFee", priorityFee: 0.000001, pool: "pump", mint: TRACKED_MINT },
      `claim:${cycleId}`
    ),
    5
  );
  if (!claimRes.ok) throw new Error(`Claim failed: ${JSON.stringify(claimJson)}`);

  const claimSig = extractSig(claimJson);
  const claimUrl = claimSig ? `https://solscan.io/tx/${claimSig}` : null;

  // 3) measure real delta in SOL that landed
  const { postSol, deltaSol } = await pollSolDelta(connection, devWallet.publicKey, preSol);
  const claimedSol = Math.max(0, deltaSol);
  console.log(`[CLAIM] delta=${claimedSol} SOL | ${claimUrl ?? "(no sig)"}`);

  // 4) spend 90% of delta via Jupiter → your mint (with broader slippage escalation)
  let swapSig: string | null = null;
  if (claimedSol > 0) {
    const reserve = 0.02; // keep fees
    const availableAfter = Math.max(0, postSol - reserve);
    const targetSpend = Math.min(Number((claimedSol * 0.9).toFixed(6)), availableAfter);

    if (targetSpend > 0.00001) {
      const SLIPPAGES_BPS = [100, 200, 500, 800]; // broaden for reliability
      let lastErr: any = null;
      for (const s of SLIPPAGES_BPS) {
        try {
          const quote = await jupQuoteSolToToken(TRACKED_MINT, targetSpend, s);
          swapSig = await jupSwap(connection, devWallet, quote);
          console.log(`[SWAP] spent ${targetSpend} SOL @${s}bps | https://solscan.io/tx/${swapSig}`);
          break;
        } catch (e) {
          lastErr = e;
          await sleep(700);
        }
      }
      if (!swapSig) console.error("[SWAP] Jupiter failed after retries:", String(lastErr?.message || lastErr));
    } else {
      console.log(`[SWAP] Skipped (targetSpend=${targetSpend}, availableAfter=${availableAfter}).`);
    }
  } else {
    console.log("[SWAP] Skipped (claimedSol=0).");
  }

  // 5) publish to front page
  const now = new Date().toISOString();
  await recordOps({
    lastClaim: { at: now, amount: claimedSol, tx: claimSig, url: claimUrl },
    lastSwap:  { at: now, amount: swapSig ? claimedSol * 0.9 : 0, tx: swapSig,  url: swapSig ? `https://solscan.io/tx/${swapSig}` : null },
  });

  return { claimedSol, swapSig, claimSig };
}

/* ================= Snapshot + Airdrop (T-5s) ================= */
const sentCycles = new Set<string>();

function isTxTooLarge(err: any): boolean {
  const msg = String(err?.message || err || "").toLowerCase();
  return msg.includes("transaction too large") || msg.includes("tx too large") || /size.*>/.test(msg);
}

// Priority + CU settings (env-overridable)
const PRIORITY_FEE_MICRO_LAMPORTS = Number(process.env.PRIORITY_FEE_MICRO_LAMPORTS ?? 10_000); // 10k µLamports/compute-unit
const COMPUTE_UNIT_LIMIT = Number(process.env.COMPUTE_UNIT_LIMIT ?? 800_000);

// send a single batch; confirm against (blockhash, lastValidBlockHeight); retry on expiry
async function sendAirdropBatch(ixs: any[]) {
  return await withRetries(async () => {
    const tx = new Transaction();

    // add priority fee + compute limit for inclusion
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICRO_LAMPORTS }),
    );

    for (const ix of ixs) tx.add(ix);
    tx.feePayer = devWallet.publicKey;

    const sendOnce = async () => {
      const { blockhash, lastValidBlockHeight, minContextSlot } =
        await withConnRetries(c => c.getLatestBlockhash("confirmed")) as any;

      tx.recentBlockhash = blockhash;
      tx.sign(devWallet);

      const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
        minContextSlot,
      });

      try {
        await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
        return sig;
      } catch (e: any) {
        const msg = String(e?.message || e).toLowerCase();
        if (msg.includes("block height exceeded") || msg.includes("blockhashnotfound")) {
          // refresh blockhash, re-sign, re-send once
          const { blockhash: bh2, lastValidBlockHeight: lvh2, minContextSlot: mcs2 } =
            await withConnRetries(c => c.getLatestBlockhash("confirmed")) as any;
          tx.recentBlockhash = bh2;
          tx.sign(devWallet);
          const sig2 = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: false,
            maxRetries: 3,
            minContextSlot: mcs2,
          });
          await connection.confirmTransaction({ signature: sig2, blockhash: bh2, lastValidBlockHeight: lvh2 }, "confirmed");
          return sig2;
        }
        throw e;
      }
    };

    return await sendOnce();
  }, 2);
}

// Proportional airdrop: each holder gets share = toSendUi * (balance / totalEligibleBalance)
async function sendAirdropsAdaptive(
  rows: Array<{ wallet: string; amountUi: number }>,
  decimals: number
) {
  const factor = 10 ** decimals;
  const uiToBase = (x: number) => BigInt(Math.floor(x * factor));
  const fromAta = getAssociatedTokenAddressSync(mintPubkey, devWallet.publicKey, false);

  let idx = 0;
  let groupSize = 10; // <= MAX 10 per requirement (will only shrink if too large)
  const groupSizeMax = 10;

  while (idx < rows.length) {
    const end = Math.min(rows.length, idx + groupSize);
    const group = rows.slice(idx, end);

    const ixs: any[] = [];
    // (optional safety) Ensure source ATA exists before first transfer (idempotent)
    // ixs.push(createAssociatedTokenAccountIdempotentInstruction(devWallet.publicKey, fromAta, devWallet.publicKey, mintPubkey));

    for (const r of group) {
      const recipient = new PublicKey(r.wallet);
      const toAta = getAssociatedTokenAddressSync(mintPubkey, recipient, false);

      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          devWallet.publicKey, toAta, recipient, mintPubkey
        )
      );

      const amountBase = uiToBase(r.amountUi);
      if (amountBase > BigInt(0)) {
        ixs.push(
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
    }

    try {
      const sig = await sendAirdropBatch(ixs);
      console.log(`[AIRDROP] batch (${group.length}) | https://solscan.io/tx/${sig}`);
      idx = end;
      // optionally ease back up, but never exceed 10
      if (groupSize < groupSizeMax) groupSize = Math.min(groupSizeMax, groupSize + 1);
    } catch (e: any) {
      if (isTxTooLarge(e) && groupSize > 1) {
        groupSize = Math.max(1, Math.floor(groupSize / 2));
        console.warn(`[AIRDROP] tx too large; reducing group size to ${groupSize} and retrying…`);
        await sleep(150);
        continue;
      }
      const msg = String(e?.message || e);
      if (looksRetryableMessage(msg)) {
        console.warn(`[AIRDROP] retryable error; pausing then retrying same batch… | ${msg}`);
        await sleep(600);
        continue; // go around and rebuild same batch
      }
      throw e;
    }
  }
}

async function snapshotAndDistribute() {
  const cycleId = String(floorCycleStart().getTime());
  if (sentCycles.has(cycleId)) return;

  // 1) Snapshot holders
  const holdersRaw = await getHoldersAll(TRACKED_MINT);

  // Exclude whales (optional)
  const excluded = holdersRaw.filter(h => h.balance > AUTO_BLACKLIST_BALANCE);
  if (excluded.length > 0) {
    console.log(`[SNAPSHOT] Excluded ${excluded.length} wallets over cap ${AUTO_BLACKLIST_BALANCE}`);
  }

  const holders = holdersRaw.filter(h => h.balance <= AUTO_BLACKLIST_BALANCE);
  if (holders.length === 0) { console.log(`[AIRDROP] no eligible holders`); return; }

  // 2) Determine pool to send (90% of DEV wallet token balance)
  const poolUi   = await tokenBalance(devWallet.publicKey);
  const toSendUi = Math.floor(poolUi * 0.90);
  if (!(toSendUi > 0)) { console.log(`[AIRDROP] pool empty after 90% rule`); return; }

  // 3) Proportional amounts
  const totalEligible = holders.reduce((a, h) => a + (Number(h.balance) || 0), 0);
  if (!(totalEligible > 0)) { console.log(`[AIRDROP] total eligible balance is 0`); return; }

  // round down each; filter zeroes
  const rows = holders.map(h => ({
    wallet: h.wallet,
    amountUi: Math.floor((toSendUi * (Number(h.balance) || 0)) / totalEligible),
  })).filter(r => r.amountUi > 0);

  if (rows.length === 0) { console.log(`[AIRDROP] all computed shares rounded to 0`); return; }

  // 4) Send (strict <=10 per batch with adaptive shrink + robust confirmation)
  const decimals = await getMintDecimals(mintPubkey);
  await sendAirdropsAdaptive(rows, decimals);

  sentCycles.add(cycleId);

  // 5) Publish (optional telemetry)
  const totalSent = rows.reduce((a, r) => a + r.amountUi, 0);
  await recordOps({
    lastAirdrop: {
      at: new Date().toISOString(),
      cycleId,
      totalSentUi: totalSent,
      wallets: rows.length,
      mode: "proportional",
    }
  });

  console.log(`[AIRDROP] done | wallets=${rows.length} | totalSentUi=${totalSent} | cycle=${cycleId}`);
}

/* ================= Main loop ================= */
async function loop() {
  const fired = new Set<string>();
  for (;;) {
    const { id, end, tMinus90, tMinus5 } = nextTimes();
    const now = new Date();

    if (!fired.has(id + ":claim") && now >= tMinus90) {
      try { await triggerClaimAndSwap90(); } catch (e) { console.error("Claim/swap error:", e); }
      fired.add(id + ":claim");
    }
    if (!fired.has(id + ":dist") && now >= tMinus5) {
      try { await snapshotAndDistribute(); } catch (e) { console.error("Airdrop error:", e); }
      fired.add(id + ":dist");
    }
    if (now >= end) fired.clear();

    await sleep(1000);
  }
}

loop().catch((err) => {
  console.error("bananaWorker crashed:", err);
  process.exit(1);
});
