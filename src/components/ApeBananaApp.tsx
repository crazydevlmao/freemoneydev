// /src/components/FreemoneyApp.tsx
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

/** ================== CONFIG ================== */
const CYCLE_MINUTES = 3; // cycle is 3 minutes

/** ================== TYPES ================== */
type Holder = { wallet: string; balance: number };
type Row = { wallet: string; tokens: number };
type MarketInfo = { marketCapUsd: number | null };
type OpsState = {
  lastClaim: { at: string; amount: number; tx: string | null; url?: string | null } | null;
  lastSwap:  { at: string; amount: number; tx: string | null; url?: string | null } | null;
  lastAirdrop?: { at: string; totalSentUi?: number; count?: number; cycleId?: string } | null;
  totalAirdroppedUi?: number;
};

/** ================== HELPERS ================== */
const toNum = (n: unknown, fallback = 0) => {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
};
const shortAddr = (a?: string, head = 6, tail = 6) => {
  const s = String(a || '');
  return s.length > head + tail ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
};
const nextCycleBoundary = (from = new Date()) => {
  const d = new Date(from);
  d.setSeconds(0, 0);
  const m = d.getMinutes();
  const add = m % CYCLE_MINUTES === 0 ? CYCLE_MINUTES : CYCLE_MINUTES - (m % CYCLE_MINUTES);
  d.setMinutes(m + add);
  return d;
};
const formatHMS = (msRemaining: number) => {
  const s = Math.max(0, Math.floor(toNum(msRemaining, 0) / 1000));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};
const solscanTx = (tx?: string | null) => (tx ? `https://solscan.io/tx/${tx}` : null);
const compact = (n: number) => {
  try {
    return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  } catch {
    return n.toLocaleString();
  }
};
const copyToClipboard = async (text: string) => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {}
  return false;
};

/** ================== COSMIC CURSOR ================== */
function useCosmicCursor() {
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    const pointerFine = matchMedia('(pointer:fine)').matches;
    if (!pointerFine) return;

    const root = document.createElement('div');
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:999999;';
    document.body.appendChild(root);

    const core = document.createElement('div');
    const aura = document.createElement('div');
    const tail: HTMLDivElement[] = Array.from({ length: 8 }, () => document.createElement('div'));
    const styleBase = (el: HTMLDivElement) => { el.style.position = 'absolute'; el.style.willChange = 'transform, opacity'; el.style.borderRadius = '9999px'; };
    styleBase(core); core.style.width = core.style.height = '12px'; core.style.border = '1px solid rgba(255,255,255,0.8)'; core.style.boxShadow = '0 0 20px rgba(255,255,255,0.55)'; core.style.mixBlendMode = 'difference';
    styleBase(aura); aura.style.width = aura.style.height = '28px'; aura.style.border = '1px solid rgba(255,255,255,0.25)'; aura.style.boxShadow = '0 0 60px rgba(99,102,241,0.35), 0 0 40px rgba(16,185,129,0.35)';
    tail.forEach((el, i) => { styleBase(el); el.style.width = el.style.height = `${10 - i * 0.6}px`; el.style.border = '1px solid rgba(255,255,255,0.35)'; el.style.opacity = `${0.45 - i * 0.045}`; });
    root.appendChild(aura); root.appendChild(core); tail.forEach((el) => root.appendChild(el));

    let x = innerWidth / 2, y = innerHeight / 2, tx = x, ty = y;
    const onMove = (e: PointerEvent) => { x = e.clientX; y = e.clientY; };
    const onDown = () => {
      aura.animate([{ transform: aura.style.transform, opacity: 1 }, { transform: aura.style.transform + ' scale(1.25)', opacity: 0.4 }], { duration: 160, easing: 'ease-out' });
      core.animate([{ transform: core.style.transform }, { transform: core.style.transform + ' scale(0.85)' }], { duration: 120, easing: 'ease-out' });
    };
    let raf = 0;
    const frame = () => {
      tx += (x - tx) * 0.22; ty += (y - ty) * 0.22;
      core.style.transform = `translate(${tx - 6}px, ${ty - 6}px)`;
      aura.style.transform = `translate(${tx - 14}px, ${ty - 14}px)`;
      tail.forEach((el, i) => {
        const k = (i + 1) * 0.06;
        const lx = tx - (x - tx) * k * 4; const ly = ty - (y - ty) * k * 4;
        el.style.transform = `translate(${lx - 5}px, ${ly - 5}px) scale(${1 - i * 0.06})`;
      });
      raf = requestAnimationFrame(frame);
    };
    addEventListener('pointermove', onMove, { passive: true });
    addEventListener('pointerdown', onDown, { passive: true });
    raf = requestAnimationFrame(frame);
    document.documentElement.classList.add('freemoney-hide-cursor');
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerdown', onDown);
      root.remove();
      document.documentElement.classList.remove('freemoney-hide-cursor');
    };
  }, []);
}

/** ================== SUB-COMPONENTS ================== */
function FlipDigit({ char }: { char: string }) {
  return (
    <motion.span
      key={char}
      className="inline-flex h-12 md:h-16 w-10 md:w-12 items-center justify-center rounded-xl bg-white/10 border border-white/15 text-2xl md:text-4xl font-extrabold text-white/90 [transform-style:preserve-3d]"
      initial={{ rotateX: -90, opacity: 0 }}
      animate={{ rotateX: 0, opacity: 1 }}
      exit={{ rotateX: 90, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 28 }}
    >
      {char}
    </motion.span>
  );
}
function FlipTimer({ msLeft, cycleMs }: { msLeft: number; cycleMs: number }) {
  const label = formatHMS(msLeft);
  const p = 1 - Math.min(1, Math.max(0, msLeft / cycleMs));
  const spd1 = Math.max(6, 18 - 12 * p);
  const spd2 = Math.max(7, 22 - 14 * p);
  const spd3 = Math.max(8, 26 - 16 * p);
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/5 p-6">
      <div className="pointer-events-none absolute inset-0">
        <span className="absolute -z-[1] h-[240px] w-[240px] -left-20 -top-10 blur-2xl opacity-40"
          style={{ background: 'radial-gradient(closest-side, rgba(34,197,94,.35), transparent)', animation: `floatXY ${spd1}s ease-in-out infinite` }} />
        <span className="absolute -z-[1] h-[300px] w-[300px] right-[-60px] top-[-40px] blur-3xl opacity-35"
          style={{ background: 'radial-gradient(closest-side, rgba(6,182,212,.35), transparent)', animation: `floatXY2 ${spd2}s ease-in-out infinite` }} />
        <span className="absolute -z-[1] h-[280px] w-[280px] left-1/3 bottom-[-80px] blur-3xl opacity-30"
          style={{ background: 'radial-gradient(closest-side, rgba(168,85,247,.35), transparent)', animation: `floatXY3 ${spd3}s ease-in-out infinite` }} />
        <span className="absolute inset-[-20%] opacity-[.35]"
          style={{ background: 'conic-gradient(from 0deg at 50% 50%, rgba(255,255,255,.08), transparent 40%, rgba(255,255,255,.08) 70%, transparent)', animation: 'rotateSlow 24s linear infinite', filter: 'blur(24px)' }} />
        <span className="absolute inset-0"
          style={{ background: 'linear-gradient(120deg, transparent 40%, rgba(255,255,255,.12), transparent 60%)', animation: 'sweep 6.5s ease-in-out infinite', mixBlendMode: 'screen' }} />
      </div>
      <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Next Drop</div>
      <div className="mt-2 [perspective:1000px] flex items-center gap-2 select-none">
        {label.split('').map((ch, idx) => (ch === ':' ? (
          <motion.span key={`colon-${idx}`} className="text-3xl md:text-5xl font-extrabold text-white/90" animate={{ opacity: [0.5, 1, 0.5] }} transition={{ duration: 1.0, repeat: Infinity, ease: 'easeInOut' }}>
            :
          </motion.span>
        ) : <FlipDigit key={`${idx}-${ch}`} char={ch} />))}
      </div>
      <motion.div className="absolute inset-0 rounded-2xl" initial={false} animate={{ opacity: [0.06, 0.0, 0.06] }} transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
        style={{ background: 'radial-gradient(closest-side, rgba(16,185,129,0.24), transparent)' }} />
      <style>{`
        @keyframes rotateSlow { to { transform: rotate(360deg) } }
        @keyframes sweep { 0%,100% { transform: translateX(-30%) } 50% { transform: translateX(30%) } }
        @keyframes floatXY { 0%,100% { transform: translate(0,0) } 50% { transform: translate(24px, -16px) } }
        @keyframes floatXY2 { 0%,100% { transform: translate(0,0) } 50% { transform: translate(-28px, 18px) } }
        @keyframes floatXY3 { 0%,100% { transform: translate(0,0) } 50% { transform: translate(18px, 26px) } }
      `}</style>
    </div>
  );
}

/** Holders Growth (Recharts) */
function HoldersGrowthChart({ data }: { data: { t: number; holders: number }[] }) {
  const fmt = (ts: number) => new Date(ts).toLocaleTimeString();
  return (
    <div className="h-40 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="hg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity={0.7} />
              <stop offset="100%" stopColor="#10b981" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <XAxis dataKey="t" tickFormatter={fmt} stroke="rgba(255,255,255,0.35)" tick={{ fontSize: 11 }} />
          <YAxis stroke="rgba(255,255,255,0.35)" tick={{ fontSize: 11 }} width={40} />
          <Tooltip
            labelFormatter={(label) => fmt(label as number)}
            contentStyle={{ background: 'rgba(10,13,22,0.9)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12 }}
          />
          <Area type="monotone" dataKey="holders" stroke="#10b981" fill="url(#hg)" strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Simple confetti burst using framer-motion (no extra deps) */
function ConfettiBurst({ active }: { active: boolean }) {
  const pieces = useMemo(
    () =>
      Array.from({ length: 70 }).map((_, i) => ({
        id: i,
        x: Math.random() * 100,
        delay: Math.random() * 0.2,
        rot: (Math.random() * 2 - 1) * 360,
        scale: 0.6 + Math.random() * 0.8,
      })),
    [active]
  );
  if (!active) return null;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {pieces.map((p) => (
        <motion.span
          key={p.id}
          initial={{ x: `${p.x}%`, y: '-10%', rotate: 0, opacity: 0 }}
          animate={{ y: '110%', rotate: p.rot, opacity: [0, 1, 1, 0] }}
          transition={{ duration: 1.4 + Math.random() * 0.4, delay: p.delay, ease: 'ease-out' }}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: 8,
            height: 12,
            borderRadius: 2,
            transformOrigin: 'center',
            background: ['#22c55e', '#06b6d4', '#a855f7', '#fde047', '#f43f5e'][p.id % 5],
            filter: 'drop-shadow(0 0 4px rgba(255,255,255,.3))',
            scale: p.scale,
          }}
        />
      ))}
    </div>
  );
}

/** ================== MAIN APP ================== */
export default function FreemoneyApp() {
  useCosmicCursor();

  // Entry Gate
  const [gateOpen, setGateOpen] = useState(false);

  // State
  const [holders, setHolders] = useState<Holder[] | null>(null);
  const [poolSOL, setPoolSOL] = useState<number | null>(null);
  const [market, setMarket] = useState<MarketInfo>({ marketCapUsd: null });
  const [mint, setMint] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [ops, setOps] = useState<OpsState>({ lastClaim: null, lastSwap: null });
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [coinHoldingsTokens, setCoinHoldingsTokens] = useState<number | null>(null); // FREEMONEY available
  const [totalCoinAirdropped, setTotalCoinAirdropped] = useState<number | null>(null); // FREEMONEY given away
  const [coinPriceUsd, setCoinPriceUsd] = useState<number | null>(null);

  // Growth data
  const growthRef = useRef<{ t: number; holders: number }[]>([]);
  const [growth, setGrowth] = useState<{ t: number; holders: number }[]>([]);
  const [range, setRange] = useState<'1H' | '1D' | '1W' | '1M' | '1Y' | 'YTD' | 'ALL'>('ALL');

  // Poll snapshot
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/snapshot', { cache: 'no-store' });
        if (!alive) return;
        if (res.ok) {
          const j: any = await res.json();

          const hs: Holder[] = Array.isArray(j?.holders)
            ? j.holders.map((x: { address?: string; wallet?: string; balance?: number | string }) => ({
                wallet: String(x.address ?? x.wallet ?? ''),
                balance: Number(x.balance) || 0,
              }))
            : [];
          setHolders(hs);
          setPoolSOL(j?.rewardPoolSol != null ? Number(j.rewardPoolSol) : null);
          setMint(String(j?.mint || ''));
          setUpdatedAt(j?.updatedAt ? String(j.updatedAt) : null);
          const mc = Number(j?.marketCapUsd);
          setMarket({ marketCapUsd: Number.isFinite(mc) ? mc : null });

          if (j?.ops) setOps(j.ops);

          // FREEMONEY stats
          setCoinHoldingsTokens(
            j?.coinHoldingsTokens != null
              ? Number(j.coinHoldingsTokens)
              : j?.rewardPoolBanana != null
              ? Number(j.rewardPoolBanana)
              : null
          );

          // Robust fallbacks for "given away"
          const totalGivenRaw =
            j?.totalCoinAirdropped ??
            j?.airdropTotalUi ??
            j?.totalAirdropped ??
            j?.stats?.totalAirdroppedUi ??
            j?.ops?.totalAirdroppedUi ??
            j?.ops?.lastAirdrop?.totalSentUi ??
            null;

          setTotalCoinAirdropped(totalGivenRaw != null ? Number(totalGivenRaw) : null);
          setCoinPriceUsd(j?.coinPriceUsd != null ? Number(j.coinPriceUsd) : null);

          // Growth tick
          const point = { t: Date.now(), holders: hs.length };
          const next = [...growthRef.current, point].slice(-2000);
          growthRef.current = next;
          setGrowth(next);
        } else {
          setHolders([]); setPoolSOL(null); setMarket({ marketCapUsd: null }); setOps({ lastClaim: null, lastSwap: null }); setUpdatedAt(null);
        }
      } catch {
        setHolders([]); setPoolSOL(null); setMarket({ marketCapUsd: null }); setOps({ lastClaim: null, lastSwap: null }); setUpdatedAt(null);
      }
    };
    load();
    const id = setInterval(() => document.visibilityState === 'visible' && load(), 5000);
    const vis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', vis); alive = false; };
  }, []);

  // Derived holders table
  const enriched = useMemo(() => {
    const list = Array.isArray(holders) ? holders : [];
    const rows: Row[] = list
      .map((h) => ({ wallet: h.wallet, tokens: Number(h.balance) || 0 }))
      .filter((r) => r.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens);
    return { rows, totalTokens: rows.reduce((a, r) => a + r.tokens, 0) };
  }, [holders]);

  // Countdown
  const [target, setTarget] = useState(() => nextCycleBoundary());
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 200); return () => clearInterval(t); }, []);
  const msLeft = Math.max(0, target.getTime() - now.getTime());
  useEffect(() => { if (msLeft <= 0) setTarget(nextCycleBoundary()); }, [msLeft]);
  const cycleMs = CYCLE_MINUTES * 60 * 1000;

  // Growth range
  const rangedGrowth = useMemo(() => {
    if (range === 'ALL') return growth;
    const nowTs = Date.now();
    let start = 0;
    if (range === '1H') start = nowTs - 3_600_000;
    if (range === '1D') start = nowTs - 86_400_000;
    if (range === '1W') start = nowTs - 7 * 86_400_000;
    if (range === '1M') start = nowTs - 30 * 86_400_000;
    if (range === '1Y') start = nowTs - 365 * 86_400_000;
    if (range === 'YTD') start = new Date(new Date().getFullYear(), 0, 1).getTime();
    return growth.filter((p) => p.t >= start);
  }, [growth, range]);

  // Latest Drop + USD value of given-away tokens
  const lastDrop = (ops?.lastClaim as any) ?? (ops as any)?.lastDrop ?? null;
  const droppedValueUsd =
    coinPriceUsd != null && totalCoinAirdropped != null ? Math.round(coinPriceUsd * totalCoinAirdropped) : null;

  // Holders Milestones
  const holderMilestones = [25, 50, 100, 150, 250, 350, 500, 750, 1000, 1250, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
  const holdersCount = enriched.rows.length;
  const nextHoldersTarget = holderMilestones.find((m) => m > holdersCount) ?? (Math.ceil(holdersCount / 1000) + 1) * 1000;
  const holdersPct = Math.min(100, Math.round((holdersCount / nextHoldersTarget) * 100));

  // Market Cap Milestones (25k → 100k, 50k → 250k, 100k → 1m, 250k → 5m)
  const mc = market.marketCapUsd ?? 0;
  const mcStep = (x: number) => (x < 100_000 ? 25_000 : x < 250_000 ? 50_000 : x < 1_000_000 ? 100_000 : 250_000);
  const nextMcTarget = (x: number) => Math.ceil((x + 0.0001) / mcStep(x)) * mcStep(x);
  const mcTarget = nextMcTarget(mc);
  const mcStart = mcTarget - mcStep(mc);
  const mcPct = Math.min(100, Math.max(0, Math.round(((mc - mcStart) / (mcTarget - mcStart)) * 100)));

  // Confetti triggers when crossing a target
  const [confettiHold, setConfettiHold] = useState(false);
  const [confettiMc, setConfettiMc] = useState(false);
  const prevHolders = useRef(holdersCount);
  const prevMc = useRef(mc);

  useEffect(() => {
    const prevTarget = holderMilestones.find((m) => m > prevHolders.current) ?? (Math.ceil(prevHolders.current / 1000) + 1) * 1000;
    if (prevHolders.current < prevTarget && holdersCount >= prevTarget) {
      setConfettiHold(true);
      setTimeout(() => setConfettiHold(false), 1700);
    }
    prevHolders.current = holdersCount;
  }, [holdersCount]);

  useEffect(() => {
    const pTarget = nextMcTarget(prevMc.current);
    if (prevMc.current < pTarget && mc >= pTarget) {
      setConfettiMc(true);
      setTimeout(() => setConfettiMc(false), 1700);
    }
    prevMc.current = mc;
  }, [mc]);

  // Paging
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const filtered = useMemo(
    () => enriched.rows.filter((r) => (q ? r.wallet.toLowerCase().includes(q.toLowerCase()) : true)),
    [enriched.rows, q]
  );
  useEffect(() => setPage(1), [q]);
  const maxPage = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageRows = filtered.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);

  // Snapshot download
  const handleDownloadSnapshot = async () => {
    try {
      const res = await fetch('/api/snapshot', { cache: 'no-store' });
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `freemoney_snapshot_${Date.now()}.json`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { console.error('Download failed', e); }
  };

  return (
    <div className="relative min-h-screen w-full bg-[#070a12] text-white overflow-hidden flex flex-col">
      {/* BACKDROP */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 [background:radial-gradient(60%_40%_at_70%_10%,rgba(34,197,94,0.15),transparent),radial-gradient(40%_30%_at_0%_100%,rgba(168,85,247,0.12),transparent)]" />
        <div className="absolute inset-0 [background-image:linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)]; bg-[length:36px_36px]" />
      </div>

      {/* HEADER */}
      <header className="relative z-10 mx-auto max-w-7xl px-4 py-4 w-full">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_12px_2px_rgba(16,185,129,0.7)]" />
            <div className="text-sm tracking-[0.2em] uppercase text-zinc-300">Live</div>
          </div>
          <div className="flex flex-col items-center">
            <div className="text-[10px] uppercase tracking-[0.4em] text-zinc-400">Project</div>
            <motion.div
              initial={{ letterSpacing: '0.6em', opacity: 0, y: -6 }}
              animate={{ letterSpacing: '0.2em', opacity: 1, y: 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
              className="text-2xl font-extrabold tracking-[0.2em] bg-clip-text text-transparent bg-[linear-gradient(90deg,#22c55e,#06b6d4,#a855f7)] bg-[length:200%_100%] animate-[shine_3s_linear_infinite]"
              style={{ textShadow: '0 4px 24px rgba(34,197,94,0.2)' }}
            >
              FREEMONEY
            </motion.div>
            <style>{`@keyframes shine{0%{background-position:0% 50%}100%{background-position:200% 50%}}`}</style>
          </div>
          <div className="flex items-center gap-2">
            <div className="px-3 py-1.5 rounded-xl border border-white/10 bg-white/5">
              <div className="flex items-center gap-2 text-[11px]">
                <span className="uppercase tracking-[0.18em] text-zinc-400">CA</span>
                <span className="font-mono">{mint ? shortAddr(mint, 6, 6) : '••••••'}</span>
                <button
                  onClick={async () => {
                    if (await copyToClipboard(mint || '')) { setCopied(true); setTimeout(() => setCopied(false), 1200); }
                  }}
                  className="text-zinc-300 hover:text-white transition cursor-pointer"
                  title="Copy contract address"
                >
                  {copied ? '✓' : '⧉'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* GATE */}
      {!gateOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-md">
          <div className="relative text-center">
            <div className="absolute -inset-10 pointer-events-none [background:radial-gradient(50%_40%_at_50%_50%,rgba(34,197,94,0.18),transparent)]" />
            <motion.button
              onClick={() => setGateOpen(true)}
              data-interactive
              className="relative px-14 py-9 text-4xl font-extrabold rounded-2xl overflow-hidden cursor-pointer select-none"
              whileHover={{ rotate: [-4, 4, -4, 4, 0], scale: [1, 1.03, 1.02, 1.03, 1], transition: { duration: 0.6, repeat: Infinity, ease: 'easeInOut' } }}
              whileTap={{ scale: 0.95 }}
            >
              <span className="absolute inset-0 bg-gradient-to-r from-emerald-500 via-cyan-500 to-fuchsia-500" />
              <span className="relative z-10">CLAIM FREE MONEY</span>
              <span className="absolute -inset-1 bg-[linear-gradient(120deg,transparent,rgba(255,255,255,.6),transparent)] opacity-40 [mask-image:radial-gradient(circle_at_center,white,transparent_60%)] animate-[sheen_1.2s_ease-in-out_infinite]" />
              <span className="absolute -inset-[2px] rounded-2xl ring-2 ring-white/60" />
            </motion.button>
          </div>
          <style>{`@keyframes sheen{0%{transform:translateX(-120%)}100%{transform:translateX(120%)}}`}</style>
        </div>
      )}

      {/* Entrance reveal */}
      <AnimatePresence>
        {gateOpen && (
          <motion.div
            initial={{ clipPath: 'circle(0% at 50% 50%)', opacity: 0.9 }}
            animate={{ clipPath: 'circle(150% at 50% 50%)', opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.05, ease: 'easeOut' }}
            className="pointer-events-none fixed inset-0 z-[55] bg-gradient-to-br from-emerald-500/30 via-cyan-500/20 to-fuchsia-500/30"
          />
        )}
      </AnimatePresence>

      {/* MAIN */}
      <main className={`relative z-10 mx-auto max-w-7xl px-4 pb-16 w-full flex-1 transition duration-500 ${gateOpen ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>
        <div className="grid grid-cols-12 gap-6">
          {/* LEFT */}
          <div className="col-span-12 lg:col-span-5 flex flex-col gap-6">
            <FlipTimer msLeft={msLeft} cycleMs={cycleMs} />

            {/* Snapshot controls */}
            <div className="p-4 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md flex items-center justify-between gap-3">
              <div className="text-sm text-zinc-300">Latest snapshot {updatedAt ? `@ ${new Date(updatedAt).toLocaleTimeString()}` : ''}</div>
              <button data-interactive onClick={handleDownloadSnapshot} className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 transition text-sm cursor-pointer ring-1 ring-white/10 hover:ring-white/30">
                Download JSON
              </button>
            </div>

            {/* Key stats */}
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 rounded-2xl border border-white/10 bg-white/5">
                <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-300/80">Market Cap</div>
                <div className="mt-1 text-2xl font-semibold">{market.marketCapUsd == null ? '--' : `$${compact(Math.max(0, market.marketCapUsd))}`}</div>
              </div>
              <div className="p-4 rounded-2xl border border-white/10 bg-white/5">
                <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-300/80">Reward Pool (SOL)</div>
                <div className="mt-1 text-2xl font-semibold">{poolSOL == null ? '--' : Number(poolSOL).toLocaleString()}</div>
              </div>
              <div className="p-4 rounded-2xl border border-white/10 bg-white/5">
                <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-300/80">FREEMONEY available</div>
                <div className="mt-1 text-2xl font-semibold">{coinHoldingsTokens == null ? '--' : Math.floor(coinHoldingsTokens).toLocaleString()}</div>
              </div>
              <div className="p-4 rounded-2xl border border-white/10 bg-white/5">
                <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-300/80">FREEMONEY given away</div>
                <div className="mt-1 text-2xl font-semibold">
                  {totalCoinAirdropped == null ? '--' : Math.floor(totalCoinAirdropped).toLocaleString()}
                </div>
                {droppedValueUsd != null && <div className="mt-1 text-[11px] text-zinc-400">≈ ${droppedValueUsd.toLocaleString()} USD</div>}
              </div>
            </div>

            {/* Milestones (Holders + Market Cap) */}
            <div className="relative p-4 rounded-2xl border border-white/10 bg-white/5 overflow-hidden">
              {/* Confetti overlays (independent) */}
              <ConfettiBurst active={confettiHold} />
              <ConfettiBurst active={confettiMc} />

              <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-300/80">Milestones</div>

              {/* Holders */}
              <div className="mt-2 text-sm text-zinc-300">
                Holders:{' '}
                <span className="font-semibold text-white">{holdersCount.toLocaleString()}</span>
                <span className="mx-2 opacity-40">•</span>
                Next target:{' '}
                <span className="font-semibold text-white">{nextHoldersTarget.toLocaleString()}</span>
                <span className="mx-2 opacity-40">•</span>
                Progress:{' '}
                <span className="font-semibold text-white">{holdersPct}%</span>
              </div>
              <div className="mt-2 h-2 w-full rounded-full bg-white/10 overflow-hidden">
                <div className="h-full bg-gradient-to-r from-emerald-400 via-cyan-400 to-fuchsia-400" style={{ width: `${holdersPct}%` }} />
              </div>

              {/* Market Cap */}
              <div className="mt-4 text-sm text-zinc-300">
                Market cap:{' '}
                <span className="font-semibold text-white">{market.marketCapUsd == null ? '--' : `$${Number(mc).toLocaleString()}`}</span>
                <span className="mx-2 opacity-40">•</span>
                Next target:{' '}
                <span className="font-semibold text-white">${mcTarget.toLocaleString()}</span>
                <span className="mx-2 opacity-40">•</span>
                Progress:{' '}
                <span className="font-semibold text-white">{mcPct}%</span>
              </div>
              <div className="mt-2 h-2 w-full rounded-full bg-white/10 overflow-hidden">
                <div className="h-full bg-gradient-to-r from-emerald-400 via-cyan-400 to-fuchsia-400" style={{ width: `${mcPct}%` }} />
              </div>
            </div>

            {/* Latest Drop (SOL) */}
            <div className="grid grid-cols-1 gap-4">
              <div className="p-4 rounded-2xl border border-white/10 bg-white/5">
                <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-300/80">Latest Drop (SOL)</div>
                <div className="mt-1 text-xl font-semibold">
                  {lastDrop != null
                    ? toNum((lastDrop as any).amount).toLocaleString(undefined, { maximumFractionDigits: 9 })
                    : '--'}
                </div>
                <div className="mt-1 text-[11px] text-zinc-400">
                  {lastDrop?.tx || (lastDrop as any)?.url ? (
                    <a
                      data-interactive
                      className="underline decoration-zinc-500/50 hover:decoration-white cursor-pointer transition hover:scale-[1.02]"
                      href={(lastDrop as any)?.url ?? solscanTx((lastDrop as any)?.tx)!}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View on Solscan
                    </a>
                  ) : (
                    'No tx yet'
                  )}
                  {lastDrop?.at && <span className="opacity-70"> • {new Date(lastDrop.at).toLocaleTimeString()}</span>}
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT: Top Holders + Growth */}
          <div className="col-span-12 lg:col-span-7 flex flex-col gap-4">
            {/* Top Holders */}
            <div className="p-4 rounded-2xl border border-white/10 bg-white/5">
              <div className="mb-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="text-sm font-medium tracking-wide text-zinc-200">Top Holders</div>
                <div className="flex items-center gap-2">
                  <input
                    placeholder="Search wallet…"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    className="h-9 w-64 rounded-lg border border-white/10 bg-white/5 px-3 text-sm outline-none placeholder:text-zinc-500 focus:border-white/20"
                  />
                </div>
              </div>

              <div className="overflow-hidden rounded-xl border border-white/10">
                <table className="w-full">
                  <thead className="bg-white/[0.03] text-[11px] uppercase tracking-wide text-zinc-400">
                    <tr>
                      <th className="py-2 pl-3 pr-2 text-left font-medium">#</th>
                      <th className="py-2 px-2 text-left font-medium">Wallet</th>
                      <th className="py-2 pr-3 pl-2 text-right font-medium">Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holders === null && (
                      <tr>
                        <td colSpan={3} className="py-8 text-center text-sm text-zinc-400">Loading…</td>
                      </tr>
                    )}
                    {holders !== null && filtered.length === 0 && (
                      <tr>
                        <td colSpan={3} className="py-8 text-center text-sm text-zinc-400">No matches.</td>
                      </tr>
                    )}
                    {holders !== null &&
                      pageRows.map((r, i) => (
                        <tr key={r.wallet} className="text-sm">
                          <td className="py-2 pl-3 pr-2 font-mono text-zinc-300 whitespace-nowrap">{(page - 1) * pageSize + i + 1}</td>
                          <td className="py-2 px-2 font-mono">{shortAddr(r.wallet)}</td>
                          <td className="py-2 pr-3 pl-2 font-semibold text-right tabular-nums">{r.tokens.toLocaleString()}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex items-center justify-between text-[12px] text-zinc-400">
                <div>Page {page} / {maxPage} • {filtered.length.toLocaleString()} wallets • {pageSize}/page</div>
                <div className="flex items-center gap-2">
                  {['First', 'Prev', 'Next', 'Last'].map((label) => (
                    <button
                      key={label}
                      data-interactive
                      onClick={() => {
                        if (label === 'First') setPage(1);
                        if (label === 'Prev') setPage((p) => Math.max(1, p - 1));
                        if (label === 'Next') setPage((p) => Math.min(maxPage, p + 1));
                        if (label === 'Last') setPage(maxPage);
                      }}
                      className="h-8 px-3 rounded-lg bg-white/10 cursor-pointer transition ring-1 ring-white/10 hover:ring-white/30"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Holders Growth */}
            <div className="p-4 rounded-2xl border border-white/10 bg-white/5">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-medium tracking-wide text-zinc-200">Holders Growth</div>
                <div className="flex items-center gap-1">
                  {(['1H', '1D', '1W', '1M', '1Y', 'YTD', 'ALL'] as const).map((k) => (
                    <button
                      key={k}
                      data-interactive
                      onClick={() => setRange(k)}
                      className={`px-2.5 py-1 rounded-lg text-[11px] border ${range === k ? 'border-emerald-400/70 bg-emerald-400/10' : 'border-white/10 bg-white/5'} cursor-pointer transition`}
                    >
                      {k}
                    </button>
                  ))}
                </div>
              </div>
              <HoldersGrowthChart data={rangedGrowth} />
            </div>
          </div>
        </div>
      </main>

      {/* FOOTER */}
      <footer className="relative z-10 border-t border-white/10 bg-black/20 w-full mt-auto">
        <div className="mx-auto max-w-7xl px-4 py-3 text-center text-[11px] text-zinc-500">© 2025 FREEMONEY — All rights reserved.</div>
      </footer>

      {/* Hide native cursor only on pointer-fine devices */}
      <style>{`.freemoney-hide-cursor * { cursor: none !important }`}</style>
    </div>
  );
}
