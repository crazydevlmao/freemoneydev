'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

/** ================== CONFIG ================== */
const CYCLE_MINUTES = 3; // Solana drop cadence

/** ================== TYPES ================== */
type Holder = { wallet: string; balance: number };
type Row = { wallet: string; tokens: number };
type MarketInfo = { marketCapUsd: number | null };
type OpsState = {
  lastClaim: { at: string; amount: number; tx: string | null } | null;
  lastSwap: { at: string; amount: number; tx: string | null } | null;
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
  const minutes = d.getMinutes();
  const add = minutes % CYCLE_MINUTES === 0 ? CYCLE_MINUTES : CYCLE_MINUTES - (minutes % CYCLE_MINUTES);
  d.setMinutes(minutes + add);
  return d;
};
const formatHMS = (msRemaining: number) => {
  const s = Math.max(0, Math.floor(toNum(msRemaining, 0) / 1000));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
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
const solscanTx = (tx?: string | null) => (tx ? `https://solscan.io/tx/${tx}` : null);
const compact = (n: number) => {
  try {
    return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  } catch {
    return n.toLocaleString();
  }
};

/** ================== COSMIC CURSOR (ULTRA-SMOOTH) ================== */
function useCosmicCursor() {
  const mounted = useRef(false);

  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;

    // Only show on pointer-fine devices (desktops)
    const pointerFine = matchMedia('(pointer:fine)').matches;
    if (!pointerFine) return;

    const root = document.createElement('div');
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:999999;';
    document.body.appendChild(root);

    // Layers
    const core = document.createElement('div'); // bright core
    const aura = document.createElement('div'); // soft glow
    const tail: HTMLDivElement[] = Array.from({ length: 8 }, () => document.createElement('div')); // trail

    const styleBase = (el: HTMLDivElement) => {
      el.style.position = 'absolute';
      el.style.willChange = 'transform, opacity';
      el.style.borderRadius = '9999px';
    };

    styleBase(core);
    core.style.width = core.style.height = '12px';
    core.style.border = '1px solid rgba(255,255,255,0.8)';
    core.style.boxShadow = '0 0 20px rgba(255,255,255,0.55)';
    core.style.mixBlendMode = 'difference';

    styleBase(aura);
    aura.style.width = aura.style.height = '28px';
    aura.style.border = '1px solid rgba(255,255,255,0.25)';
    aura.style.boxShadow = '0 0 60px rgba(99, 102, 241, 0.35), 0 0 40px rgba(16,185,129,0.35)';

    tail.forEach((el, i) => {
      styleBase(el);
      el.style.width = el.style.height = `${10 - i * 0.6}px`;
      el.style.border = '1px solid rgba(255,255,255,0.35)';
      el.style.opacity = `${0.45 - i * 0.045}`;
    });

    root.appendChild(aura);
    root.appendChild(core);
    tail.forEach((el) => root.appendChild(el));

    // Motion lerp via RAF (no React state)
    let x = window.innerWidth / 2,
      y = window.innerHeight / 2,
      tx = x,
      ty = y;
    const onMove = (e: PointerEvent) => {
      x = e.clientX;
      y = e.clientY;
    };
    const onDown = () => {
      // tiny click burst
      aura.animate([{ transform: aura.style.transform, opacity: 1 }, { transform: aura.style.transform + ' scale(1.25)', opacity: 0.4 }], {
        duration: 160,
        easing: 'ease-out',
      });
      core.animate([{ transform: core.style.transform }, { transform: core.style.transform + ' scale(0.85)' }], {
        duration: 120,
        easing: 'ease-out',
      });
    };

    let raf = 0;
    const frame = () => {
      // springy easing without jank
      tx += (x - tx) * 0.22;
      ty += (y - ty) * 0.22;

      core.style.transform = `translate(${tx - 6}px, ${ty - 6}px)`;
      aura.style.transform = `translate(${tx - 14}px, ${ty - 14}px)`;

      tail.forEach((el, i) => {
        const k = (i + 1) * 0.06;
        const lx = tx - (x - tx) * k * 4;
        const ly = ty - (y - ty) * k * 4;
        el.style.transform = `translate(${lx - 5}px, ${ly - 5}px) scale(${1 - i * 0.06})`;
      });

      raf = requestAnimationFrame(frame);
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onDown, { passive: true });
    raf = requestAnimationFrame(frame);

    // hide native cursor
    document.documentElement.classList.add('freemoney-hide-cursor');

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      root.remove();
      document.documentElement.classList.remove('freemoney-hide-cursor');
    };
  }, []);
}

/** ================== SUB-COMPONENTS ================== */
function FlipTimer({ msLeft, cycleMs }: { msLeft: number; cycleMs: number }) {
  const label = formatHMS(msLeft);

  // Near-zero intensifies speed subtly
  const p = 1 - Math.min(1, Math.max(0, msLeft / cycleMs));
  const spd1 = Math.max(6, 18 - 12 * p);
  const spd2 = Math.max(7, 22 - 14 * p);
  const spd3 = Math.max(8, 26 - 16 * p);

  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/5 p-6">
      {/* SLICK AURORA FIELD */}
      <div className="pointer-events-none absolute inset-0">
        {/* soft gradient blobs (very smooth float) */}
        <span
          className="absolute -z-[1] h-[240px] w-[240px] -left-20 -top-10 blur-2xl opacity-40"
          style={{
            background: 'radial-gradient(closest-side, rgba(34,197,94,.35), transparent)',
            animation: `floatXY ${spd1}s ease-in-out infinite`,
          }}
        />
        <span
          className="absolute -z-[1] h-[300px] w-[300px] right-[-60px] top-[-40px] blur-3xl opacity-35"
          style={{
            background: 'radial-gradient(closest-side, rgba(6,182,212,.35), transparent)',
            animation: `floatXY2 ${spd2}s ease-in-out infinite`,
          }}
        />
        <span
          className="absolute -z-[1] h-[280px] w-[280px] left-1/3 bottom-[-80px] blur-3xl opacity-30"
          style={{
            background: 'radial-gradient(closest-side, rgba(168,85,247,.35), transparent)',
            animation: `floatXY3 ${spd3}s ease-in-out infinite`,
          }}
        />

        {/* subtle aurora sweep */}
        <span
          className="absolute inset-[-20%] opacity-[.35]"
          style={{
            background:
              'conic-gradient(from 0deg at 50% 50%, rgba(255,255,255,.08), transparent 40%, rgba(255,255,255,.08) 70%, transparent)',
            animation: 'rotateSlow 24s linear infinite',
            filter: 'blur(24px)',
          }}
        />

        {/* thin scan beam */}
        <span
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(120deg, transparent 40%, rgba(255,255,255,.12), transparent 60%)',
            animation: 'sweep 6.5s ease-in-out infinite',
            mixBlendMode: 'screen',
          }}
        />

        {/* micro starfield drift */}
        <span
          className="absolute inset-0 mix-blend-screen opacity-60"
          style={{
            backgroundImage:
              'radial-gradient(circle at 20% 30%, rgba(255,255,255,0.08) 1px, transparent 1px), radial-gradient(circle at 80% 70%, rgba(255,255,255,0.06) 1px, transparent 1px)',
            backgroundSize: '140px 140px, 160px 160px',
            animation: 'parallax 18s linear infinite',
          }}
        />
      </div>

      <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Next Drop</div>

      {/* Flip digits (unchanged) */}
      <div className="mt-2 [perspective:1000px] flex items-center gap-2 select-none">
        {label.split('').map((ch, idx) =>
          ch === ':' ? (
            <motion.span
              key={`colon-${idx}`}
              className="text-3xl md:text-5xl font-extrabold text-white/90"
              animate={{ opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 1.0, repeat: Infinity, ease: 'easeInOut' }}
            >
              :
            </motion.span>
          ) : (
            <FlipDigit key={`${idx}-${ch}`} char={ch} />
          ),
        )}
      </div>

      {/* imperceptible heartbeat to keep it alive */}
      <motion.div
        className="absolute inset-0 rounded-2xl"
        initial={false}
        animate={{ opacity: [0.06, 0.0, 0.06] }}
        transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
        style={{ background: 'radial-gradient(closest-side, rgba(16,185,129,0.24), transparent)' }}
      />

      <style>{`
        @keyframes rotateSlow { to { transform: rotate(360deg) } }
        @keyframes sweep {
          0%,100% { transform: translateX(-30%) }
          50%     { transform: translateX(30%) }
        }
        @keyframes parallax {
          0%   { transform: translate3d(0,0,0) }
          100% { transform: translate3d(-30px, 18px, 0) }
        }
        @keyframes floatXY {
          0%,100% { transform: translate(0,0) }
          50%     { transform: translate(24px, -16px) }
        }
        @keyframes floatXY2 {
          0%,100% { transform: translate(0,0) }
          50%     { transform: translate(-28px, 18px) }
        }
        @keyframes floatXY3 {
          0%,100% { transform: translate(0,0) }
          50%     { transform: translate(18px, 26px) }
        }
      `}</style>
    </div>
  );
}


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
            contentStyle={{
              background: 'rgba(10,13,22,0.9)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 12,
            }}
          />
          <Area type="monotone" dataKey="holders" stroke="#10b981" fill="url(#hg)" strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** ================== MAIN APP ================== */
export default function FreemoneyApp() {
  // Custom cursor
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
          const j = await res.json();
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

          // FREEMONEY stats (rename mapping)
          setCoinHoldingsTokens(
            j?.coinHoldingsTokens != null
              ? Number(j.coinHoldingsTokens)
              : j?.rewardPoolBanana != null
              ? Number(j.rewardPoolBanana)
              : null,
          );
          setTotalCoinAirdropped(j?.totalCoinAirdropped != null ? Number(j.totalCoinAirdropped) : null);
          setCoinPriceUsd(j?.coinPriceUsd != null ? Number(j.coinPriceUsd) : null);

          // Growth tick
          const point = { t: Date.now(), holders: hs.length };
          const next = [...growthRef.current, point].slice(-2000);
          growthRef.current = next;
          setGrowth(next);
        } else {
          setHolders([]);
          setPoolSOL(null);
          setMarket({ marketCapUsd: null });
          setOps({ lastClaim: null, lastSwap: null });
          setUpdatedAt(null);
        }
      } catch {
        setHolders([]);
        setPoolSOL(null);
        setMarket({ marketCapUsd: null });
        setOps({ lastClaim: null, lastSwap: null });
        setUpdatedAt(null);
      }
    };
    load();
    const id = setInterval(() => document.visibilityState === 'visible' && load(), 5000);
    const vis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', vis);
      alive = false;
    };
  }, []);

// Derived
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
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 200);
    return () => clearInterval(t);
  }, []);
  const msLeft = Math.max(0, target.getTime() - now.getTime());
  useEffect(() => {
    if (msLeft <= 0) setTarget(nextCycleBoundary());
  }, [msLeft]);
  const cycleMs = CYCLE_MINUTES * 60 * 1000;

  // Ranged growth
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

  const droppedValueUsd =
    coinPriceUsd != null && totalCoinAirdropped != null ? Math.round(coinPriceUsd * totalCoinAirdropped) : null;

  const lastDrop = (ops?.lastClaim as any) ?? (ops as any)?.lastDrop ?? null;

  // Paging
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const filtered = useMemo(
    () => enriched.rows.filter((r) => (q ? r.wallet.toLowerCase().includes(q.toLowerCase()) : true)),
    [enriched.rows, q],
  );
  useEffect(() => setPage(1), [q]);
  const maxPage = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageRows = filtered.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);

  // Milestones: hidden numbers (just show the bar)
  const milestones = [25, 50, 100, 150, 250, 350, 500, 750, 1000, 1250, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
  const nextMilestone = milestones.find((m) => m > enriched.rows.length) ?? 10000;
  const milestonePct = Math.min(100, Math.round((enriched.rows.length / nextMilestone) * 100));

  // Snapshot download
  const handleDownloadSnapshot = async () => {
    try {
      const res = await fetch('/api/snapshot', { cache: 'no-store' });
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `freemoney_snapshot_${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Download failed', e);
    }
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
                    if (await copyToClipboard(mint || '')) {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1200);
                    }
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

      {/* GATE OVERLAY (CRAZY HOVER) */}
{!gateOpen && (
  <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-md">
    <div className="relative text-center">
      <div className="absolute -inset-10 pointer-events-none [background:radial-gradient(50%_40%_at_50%_50%,rgba(34,197,94,0.18),transparent)]" />

      {/* Wrapper so we can position arrows around the button */}
      <div className="relative inline-block group">
        {/* ARROWS (appear + dance on hover) */}
        <span className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 text-4xl opacity-0 group-hover:opacity-100 animate-[pointPulse_1.2s_ease-in-out_infinite]">
          ⬇
        </span>
        <span className="pointer-events-none absolute -bottom-10 left-1/2 -translate-x-1/2 text-3xl opacity-0 group-hover:opacity-100 animate-[pointPulse_1.2s_ease-in-out_infinite] [animation-delay:.15s]">
          ⬆
        </span>
        <span className="pointer-events-none absolute top-1/2 -left-12 -translate-y-1/2 text-5xl opacity-0 group-hover:opacity-100 animate-[pointPulse_1.2s_ease-in-out_infinite] [animation-delay:.3s]">
          ⇨
        </span>
        <span className="pointer-events-none absolute top-1/2 -right-12 -translate-y-1/2 text-5xl opacity-0 group-hover:opacity-100 animate-[pointPulse_1.2s_ease-in-out_infinite] [animation-delay:.45s]">
          ⇦
        </span>

        {/* floating mini arrows */}
        {[...Array(6)].map((_,i)=>(
          <span
            key={i}
            className="pointer-events-none absolute text-2xl opacity-0 group-hover:opacity-100"
            style={{
              left: `${-22 + i*10}%`,
              top: `${10 + (i%3)*30}%`,
              animation: `floatArrow ${1.4 + (i%3)*0.3}s ease-in-out ${i*0.08}s infinite`,
            }}
          >
            ↘︎
          </span>
        ))}

        <motion.button
          data-interactive
          onClick={() => setGateOpen(true)}
          className="relative px-14 py-9 text-4xl font-extrabold rounded-2xl overflow-hidden cursor-pointer select-none"
          whileHover={{
            rotate: [-4, 4, -4, 4, 0],
            scale: [1, 1.03, 1.02, 1.03, 1],
            transition: { duration: 0.6, repeat: Infinity, ease: 'easeInOut' },
          }}
          whileTap={{ scale: 0.95 }}
        >
          {/* base gradient */}
          <span className="absolute inset-0 bg-gradient-to-r from-emerald-500 via-cyan-500 to-fuchsia-500" />
          {/* chroma ghost */}
          <span
            className="absolute inset-0 mix-blend-screen opacity-0 group-hover:opacity-100 transition"
            style={{ background: 'radial-gradient(closest-side, rgba(255,255,255,0.18), transparent)' }}
          />
          {/* chaos sparkles */}
          {[...Array(18)].map((_, i) => (
            <span
              key={i}
              className="absolute h-1 w-1 rounded-full bg-white/90 mix-blend-screen"
              style={{
                left: `${5 + (i * 95) / 18}%`,
                top: `${20 + ((i % 4) * 60) / 3}%`,
                animation: `spark ${0.7 + (i % 5) * 0.15}s ${(i * 37) % 300}ms infinite alternate`,
              }}
            />
          ))}
          {/* text with subtle chroma split */}
          <span className="relative z-10 inline-flex items-center gap-4">
            <span className="tracking-wider">⇨</span>
            <span className="relative">
              <span className="block">CLAIM FREE MONEY</span>
              <span className="pointer-events-none absolute inset-0 blur-[1px] text-cyan-300 opacity-50 translate-x-[1px] -translate-y-[1px]">
                CLAIM FREE MONEY
              </span>
              <span className="pointer-events-none absolute inset-0 blur-[1px] text-fuchsia-300 opacity-50 -translate-x-[1px] translate-y-[1px]">
                CLAIM FREE MONEY
              </span>
            </span>
            <span className="tracking-wider">⇦</span>
          </span>
          {/* sheen sweep */}
          <span className="absolute -inset-1 bg-[linear-gradient(120deg,transparent,rgba(255,255,255,.6),transparent)] opacity-0 group-hover:opacity-70 [mask-image:radial-gradient(circle_at_center,white,transparent_60%)] animate-[sheen_1.2s_ease-in-out_infinite]" />
          {/* ring pulse */}
          <span className="absolute -inset-[2px] rounded-2xl ring-2 ring-white/60 group-hover:ring-white/90 transition" />
        </motion.button>
      </div>

      <style>{`
        @keyframes sheen{0%{transform:translateX(-120%)}100%{transform:translateX(120%)}}
        @keyframes spark{0%{transform:translateY(-2px);opacity:.6}100%{transform:translateY(2px);opacity:1}}
        @keyframes pointPulse {
          0%,100% { transform: scale(1);   text-shadow: 0 0 8px rgba(255,255,255,.4) }
          50%     { transform: scale(1.2); text-shadow: 0 0 20px rgba(255,255,255,.8) }
        }
        @keyframes floatArrow {
          0%,100% { transform: translateY(-3px) rotate(-8deg) }
          50%     { transform: translateY(3px)  rotate( 8deg) }
        }
      `}</style>
    </div>
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
      <main
        className={`relative z-10 mx-auto max-w-7xl px-4 pb-16 w-full flex-1 transition duration-500 ${
          gateOpen ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
        }`}
      >
        <div className="grid grid-cols-12 gap-6">
          {/* LEFT: Timer & Stats */}
          <div className="col-span-12 lg:col-span-5 flex flex-col gap-6">
            {/* Holographic Flip Timer (animated) */}
            <FlipTimer msLeft={msLeft} cycleMs={cycleMs} />

            {/* Snapshot controls */}
            <div className="p-4 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md flex items-center justify-between gap-3">
              <div className="text-sm text-zinc-300">
                Latest snapshot {updatedAt ? `@ ${new Date(updatedAt).toLocaleTimeString()}` : ''}
              </div>
              <button
                data-interactive
                onClick={handleDownloadSnapshot}
                className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 transition text-sm cursor-pointer transform hover:scale-105 hover:-translate-y-px active:translate-y-px active:scale-95 ring-1 ring-white/10 hover:ring-white/30"
              >
                Download JSON
              </button>
            </div>

            {/* Key stats */}
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 rounded-2xl border border-white/10 bg-white/5">
                <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-300/80">Market Cap</div>
                <div className="mt-1 text-2xl font-semibold">
                  {market.marketCapUsd == null ? '--' : `$${compact(Math.max(0, market.marketCapUsd))}`}
                </div>
              </div>
              <div className="p-4 rounded-2xl border border-white/10 bg-white/5">
                <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-300/80">Reward Pool (SOL)</div>
                <div className="mt-1 text-2xl font-semibold">{poolSOL == null ? '--' : Number(poolSOL).toLocaleString()}</div>
              </div>
              <div className="p-4 rounded-2xl border border-white/10 bg-white/5">
                <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-300/80">FREEMONEY available</div>
                <div className="mt-1 text-2xl font-semibold">
                  {coinHoldingsTokens == null ? '--' : Math.floor(coinHoldingsTokens).toLocaleString()}
                </div>
              </div>
              <div className="p-4 rounded-2xl border border-white/10 bg-white/5">
                <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-300/80">FREEMONEY given away</div>
                <div className="mt-1 text-2xl font-semibold">
                  {totalCoinAirdropped == null ? '--' : Math.floor(totalCoinAirdropped).toLocaleString()}
                </div>
                {droppedValueUsd != null && (
                  <div className="mt-1 text-[11px] text-zinc-400">≈ ${droppedValueUsd.toLocaleString()} USD</div>
                )}
              </div>
            </div>

            {/* Milestone Tracker — show numbers on top, no chips below */}
<div className="p-4 rounded-2xl border border-white/10 bg-white/5">
  <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-300/80">Milestones</div>

  {/* Top numbers back in */}
  <div className="mt-1 text-sm text-zinc-300">
    Holders: <span className="font-semibold text-white">{enriched.rows.length.toLocaleString()}</span>
    <span className="mx-2 opacity-40">•</span>
    Next target: <span className="font-semibold text-white">{nextMilestone.toLocaleString()}</span>
    <span className="mx-2 opacity-40">•</span>
    Progress: <span className="font-semibold text-white">{milestonePct}%</span>
  </div>

  <div className="mt-2 h-2 w-full rounded-full bg-white/10 overflow-hidden">
    <div
      className="h-full bg-gradient-to-r from-emerald-400 via-cyan-400 to-fuchsia-400"
      style={{ width: `${milestonePct}%` }}
    />
  </div>
  {/* Intentionally no milestone numbers/chips under the bar */}
</div>


            {/* Latest Drop (SOL) */}
            <div className="grid grid-cols-1 gap-4">
              <div className="p-4 rounded-2xl border border-white/10 bg-white/5">
                <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-300/80">Latest Drop (SOL)</div>
                <div className="mt-1 text-xl font-semibold">
                  {lastDrop ? Math.floor(toNum((lastDrop as any).amount)).toLocaleString() : '--'}
                </div>
                <div className="mt-1 text-[11px] text-zinc-400">
                  {lastDrop?.tx ? (
                    <a
                      data-interactive
                      className="underline decoration-zinc-500/50 hover:decoration-white cursor-pointer transition hover:scale-[1.02]"
                      href={solscanTx(lastDrop.tx)!}
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
                        <td colSpan={3} className="py-8 text-center text-sm text-zinc-400">
                          Loading…
                        </td>
                      </tr>
                    )}
                    {holders !== null && filtered.length === 0 && (
                      <tr>
                        <td colSpan={3} className="py-8 text-center text-sm text-zinc-400">
                          No matches.
                        </td>
                      </tr>
                    )}
                    {holders !== null &&
                      pageRows.map((r, i) => (
                        <tr key={r.wallet} className="text-sm">
                          <td className="py-2 pl-3 pr-2 font-mono text-zinc-300 whitespace-nowrap">
                            {(page - 1) * pageSize + i + 1}
                          </td>
                          <td className="py-2 px-2 font-mono">{shortAddr(r.wallet)}</td>
                          <td className="py-2 pr-3 pl-2 font-semibold text-right tabular-nums">
                            {r.tokens.toLocaleString()}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex items-center justify-between text-[12px] text-zinc-400">
                <div>
                  Page {page} / {maxPage} • {filtered.length.toLocaleString()} wallets • {pageSize}/page
                </div>
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
                      className="h-8 px-3 rounded-lg bg-white/10 cursor-pointer transition transform hover:scale-105 hover:-translate-y-px active:translate-y-px ring-1 ring-white/10 hover:ring-white/30"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Holders Growth Graph */}
            <div className="p-4 rounded-2xl border border-white/10 bg-white/5">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-medium tracking-wide text-zinc-200">Holders Growth</div>
                <div className="flex items-center gap-1">
                  {(['1H', '1D', '1W', '1M', '1Y', 'YTD', 'ALL'] as const).map((k) => (
                    <button
                      key={k}
                      data-interactive
                      onClick={() => setRange(k)}
                      className={`group px-2.5 py-1 rounded-lg text-[11px] border ${
                        range === k ? 'border-emerald-400/70 bg-emerald-400/10' : 'border-white/10 bg-white/5'
                      } cursor-pointer transition transform hover:scale-105 hover:-translate-y-px active:translate-y-px`}
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
        <div className="mx-auto max-w-7xl px-4 py-3 text-center text-[11px] text-zinc-500">
          © 2025 FREEMONEY — All rights reserved.
        </div>
      </footer>

      {/* Edge glow */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />

      {/* Hide native cursor only on pointer-fine devices */}
      <style>{`.freemoney-hide-cursor * { cursor: none !important }`}</style>
    </div>
  );
}

