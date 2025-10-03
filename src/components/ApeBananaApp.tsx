// /src/components/CandyApp.tsx
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { motion, AnimatePresence } from 'framer-motion';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

/** ================== CONFIG (unchanged APIs) ================== */
const CYCLE_MINUTES = 3;
const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '';
const SNAPSHOT_URL = API_BASE ? `${API_BASE}/api/snapshot` : '/api/snapshot';

/** ================== TYPES ================== */
type Holder = { wallet: string; balance: number };
type Row = { wallet: string; tokens: number };
type MarketInfo = { marketCapUsd: number | null };
type OpsState = {
  lastClaim: { at: string; amount: number; tx: string | null; url?: string | null } | null;
  lastSwap: { at: string; amount: number; tx: string | null; url?: string | null } | null;
  lastAirdrop?: { at: string; totalSentUi?: number; count?: number; cycleId?: string } | null;
  totalAirdroppedUi?: number;
};

/** ================== HELPERS ================== */
const toNum = (n: unknown, fallback = 0) => (Number.isFinite(Number(n)) ? Number(n) : fallback);
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
function CandyCompactTimer({
  msLeft,
  cycleMs,
  maxWidth = 720,
}: {
  msLeft: number;
  cycleMs: number;
  maxWidth?: number;
}) {
  const progress = Math.max(0, Math.min(1, 1 - msLeft / Math.max(1, cycleMs)));
  const totalSeconds = Math.max(0, Math.floor(msLeft / 1000));
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const ss = String(totalSeconds % 60).padStart(2, '0');

  const [logoBroken, setLogoBroken] = React.useState(false);

  // --- FREE $CANDY celebrate window (strict-mode safe) ---
  const [celebrate, setCelebrate] = React.useState(false);
  const prevMsRef = React.useRef(msLeft);

  // detect reset: was near 0, now jumped to (almost) full cycle
  useEffect(() => {
    const prev = prevMsRef.current;
    const resetDetected = prev <= 200 && msLeft >= cycleMs - 200;
    if (resetDetected) setCelebrate(true);
    prevMsRef.current = msLeft;
  }, [msLeft, cycleMs]);

  // ensure it ALWAYS returns to digits after 2s (even in StrictMode)
  useEffect(() => {
    if (!celebrate) return;
    const t = setTimeout(() => setCelebrate(false), 2000);
    return () => clearTimeout(t);
  }, [celebrate]);

  // digits
  const Digit = ({ ch }: { ch: string }) => (
    <span className="inline-block min-w-[1.55ch] text-center align-baseline">
      <AnimatePresence initial={false} mode="wait">
        <motion.span
          key={ch}
          initial={{ y: 12, opacity: 0, filter: 'blur(6px)' }}
          animate={{ y: 0, opacity: 1, filter: 'blur(0px)' }}
          exit={{ y: -12, opacity: 0, filter: 'blur(6px)' }}
          transition={{ type: 'spring', stiffness: 650, damping: 34 }}
          className="inline-block bg-gradient-to-b from-white via-zinc-200 to-zinc-400 bg-clip-text text-transparent"
        >
          {ch}
        </motion.span>
      </AnimatePresence>
    </span>
  );

  const barWidthPct = progress * 100;
  const barWidth = `${barWidthPct}%`;
  const glowWidth = `${Math.max(8, barWidthPct)}%`;
  const message = 'FREE $CANDY';

  return (
    <section className="relative z-30">
      <div className="mx-auto w-full" style={{ maxWidth }}>
        <div className="px-4 pt-3">
          <div className="flex items-center justify-center">
            <div className="font-mono font-extrabold leading-[0.9] tracking-tight text-[32px] md:text-[44px] lg:text-[56px]">
              <AnimatePresence mode="wait">
                {celebrate ? (
                  <motion.span
                    key="msg"
                    initial={{ opacity: 0, y: 10, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8, scale: 0.98 }}
                    transition={{ duration: 0.35 }}
                    className="inline-flex items-baseline gap-[0.12em]"
                  >
                    {message.split('').map((c, i) => (
                      <motion.span
                        key={`${c}-${i}`}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.03, type: 'spring', stiffness: 500, damping: 26 }}
                        className="bg-gradient-to-b from-white via-zinc-200 to-zinc-400 bg-clip-text text-transparent"
                      >
                        {c}
                      </motion.span>
                    ))}
                  </motion.span>
                ) : (
                  <motion.span key="digits" className="inline-block">
                    <Digit ch={mm[0]} />
                    <Digit ch={mm[1]} />
                    <span className="inline-block px-[0.12em] bg-gradient-to-b from-white via-zinc-200 to-zinc-400 bg-clip-text text-transparent">
                      :
                    </span>
                    <Digit ch={ss[0]} />
                    <Digit ch={ss[1]} />
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* bar */}
          <div className="mt-2.5 relative">
            <div className="relative h-2.5 w-full rounded-full bg-white/5 ring-1 ring-white/10 overflow-hidden">
              <div
                className="absolute left-0 top-0 h-full"
                style={{
                  width: barWidth,
                  background:
                    'linear-gradient(90deg, #FF8A00 0%, #FFB86C 35%, #FFD8A0 60%, #C8F7A6 85%, #66FF7F 100%)',
                }}
              />
              <div
                className="absolute left-0 -top-2 -bottom-2 pointer-events-none"
                style={{
                  width: glowWidth,
                  background:
                    'linear-gradient(90deg, rgba(255,138,0,.25), rgba(255,184,108,.20), rgba(102,255,127,.28))',
                  filter: 'blur(10px)',
                }}
              />
            </div>

            {/* marker */}
            <div
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2"
              style={{ left: barWidth }}
            >
              <motion.div
                animate={{ scale: [1, 1.12, 1], y: [0, -0.6, 0] }}
                transition={{ duration: 0.95, repeat: Infinity, ease: 'easeInOut' }}
                className="h-7 w-7 md:h-8 md:w-8 rounded-full ring-2 ring-white/60 shadow-[0_0_14px_rgba(255,184,108,.55)] overflow-hidden bg-transparent grid place-items-center"
              >
                {logoBroken ? (
                  <span className="text-sm md:text-base">🍬</span>
                ) : (
                  <Image
                    src="/logo.png"
                    alt="CANDY"
                    width={28}
                    height={28}
                    className="object-cover"
                    onError={() => setLogoBroken(true)}
                  />
                )}
              </motion.div>
            </div>
          </div>

          <div className="mb-6" />
        </div>
      </div>
    </section>
  );
}




/** ======== localStorage (namespaced for candy) ======== */
const AIRDROP_LS_KEY = 'candy_airdrops_seen';
const LASTCLAIM_LS_KEY = 'candy_last_claim';
const getAirdropMap = (): Record<string, number> => {
  if (typeof window === 'undefined') return {};
  try { return JSON.parse(localStorage.getItem(AIRDROP_LS_KEY) || '{}'); } catch { return {}; }
};
const saveAirdropMap = (m: Record<string, number>) => { if (typeof window !== 'undefined') localStorage.setItem(AIRDROP_LS_KEY, JSON.stringify(m)); };
const addAirdropToLS = (cycleId: string, total: number) => {
  const m = getAirdropMap();
  if (!m[cycleId]) { m[cycleId] = total; saveAirdropMap(m); }
  return Object.values(m).reduce((a, b) => a + (Number(b) || 0), 0);
};
const sumAirdropsFromLS = () => Object.values(getAirdropMap()).reduce((a, b) => a + (Number(b) || 0), 0);

/** ================== THEME: Halloween backdrops & cursor ================== */
function useHalloweenFX() {
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) return; mounted.current = true;
    const fine = matchMedia('(pointer:fine)').matches; if (!fine) return;
    const root = document.createElement('div');
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:99999;';
    document.body.appendChild(root);

    // Bats trail
    const bats: HTMLDivElement[] = Array.from({ length: 6 }, () => document.createElement('div'));
    bats.forEach((el) => { el.innerHTML = `<svg width="22" height="14" viewBox="0 0 22 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 10 C5 6, 17 6, 21 10 C18 6, 4 6, 1 10 Z" fill="rgba(255,255,255,0.75)"/><circle cx="11" cy="7" r="2" fill="rgba(255,149,0,0.95)"/></svg>`; el.style.position='absolute'; el.style.willChange='transform,opacity'; root.appendChild(el); });
    let x = innerWidth/2, y = innerHeight/2, tx = x, ty = y; const onMove=(e:PointerEvent)=>{x=e.clientX;y=e.clientY};
    let raf=0; const frame=()=>{ tx += (x-tx)*0.18; ty += (y-ty)*0.18; bats.forEach((el,i)=>{ const k=(i+1)*0.08; const lx = tx-(x-tx)*k*6; const ly = ty-(y-ty)*k*6; el.style.transform=`translate(${lx-11}px,${ly-7}px) rotate(${(x-tx)*0.05}deg)`; el.style.opacity=String(0.85 - i*0.12);}); raf=requestAnimationFrame(frame);};
    addEventListener('pointermove', onMove, { passive: true }); raf=requestAnimationFrame(frame);
    document.documentElement.classList.add('candy-hide-cursor');
    return ()=>{ cancelAnimationFrame(raf); removeEventListener('pointermove', onMove); root.remove(); document.documentElement.classList.remove('candy-hide-cursor'); };
  }, []);
}

/** ================== MICRO UI ================== */
function FlipDigit({ char }: { char: string }) {
  return (
    <motion.span
      key={char}
      className="inline-flex h-12 md:h-16 w-10 md:w-12 items-center justify-center rounded-xl bg-white/10 border border-white/15 text-2xl md:text-4xl font-extrabold text-white/90 [transform-style:preserve-3d]"
      initial={{ rotateX: -90, opacity: 0 }}
      animate={{ rotateX: 0, opacity: 1 }}
      exit={{ rotateX: 90, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 28 }}
    >{char}</motion.span>
  );
}
function Countdown({ msLeft, cycleMs }: { msLeft: number; cycleMs: number }) {
  const label = formatHMS(msLeft);
  return (
    <div className="flex items-center gap-2 [perspective:1000px]">
      {label.split('').map((ch, i) => ch === ':' ? (
        <motion.span key={`c-${i}`} className="text-3xl md:text-5xl font-extrabold text-white/90" animate={{ opacity: [0.5,1,0.5] }} transition={{ duration: 1, repeat: Infinity }}>
          :
        </motion.span>
      ) : (
        <FlipDigit key={`${i}-${ch}`} char={ch} />
      ))}
    </div>
  );
}

/** ================== VISUALS ================== */
function HoldersGrowthChart({ data }: { data: { t: number; holders: number }[] }) {
  const fmt = (ts: number) => new Date(ts).toLocaleTimeString();
  return (
    <div className="h-36 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="hg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#fb923c" stopOpacity={0.75} />
              <stop offset="100%" stopColor="#fb923c" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <XAxis dataKey="t" tickFormatter={fmt} stroke="rgba(255,255,255,0.35)" tick={{ fontSize: 11 }} />
          <YAxis stroke="rgba(255,255,255,0.35)" tick={{ fontSize: 11 }} width={40} />
          <Tooltip labelFormatter={(label) => fmt(label as number)} contentStyle={{ background: 'rgba(18,12,20,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12 }} />
          <Area type="monotone" dataKey="holders" stroke="#fb923c" fill="url(#hg)" strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function CandyBurst({ active }: { active: boolean }) {
  const pieces = React.useMemo(() => Array.from({ length: 80 }).map((_, i) => ({ id: i, x: Math.random()*100, d: 1.3 + Math.random()*0.6 })), [active]);
  if (!active) return null;
  const colors = ['#fb7185', '#fb923c', '#f59e0b', '#a855f7', '#f97316'];
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {pieces.map((p) => (
        <motion.span key={p.id} initial={{ x: `${p.x}%`, y: '-10%', opacity: 0 }} animate={{ y: '110%', opacity: [0,1,1,0] }} transition={{ duration: p.d, ease: 'easeOut' }} style={{ position:'absolute', left:0, top:0, width:12, height:12, borderRadius:999, background: colors[p.id % colors.length], boxShadow:'inset 0 0 6px rgba(0,0,0,.35), 0 0 6px rgba(255,255,255,.25)'}} />
      ))}
    </div>
  );
}
function CandyRain({ active }: { active: boolean }) {
  const [drops] = useState(() =>
    Array.from({ length: 48 }).map(() => ({
      id: Math.random().toString(36).slice(2),
      x: Math.random() * 100,      // vw %
      delay: Math.random() * 0.8,  // s
      dur: 1.8 + Math.random() * 1.6, // s
      size: 20 + Math.floor(Math.random() * 18), // px
      sway: (Math.random() * 2 - 1) * 18,        // px side drift
    }))
  );
  if (!active) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-[5] overflow-hidden">
      {drops.map((d) => (
        <motion.div
          key={d.id}
          initial={{ x: `${d.x}vw`, y: '-12%', opacity: 0 }}
          animate={{
            // 4-keyframe path so opacity timing can match perfectly
            x: [
              `${d.x}vw`,
              `calc(${d.x}vw + ${d.sway / 2}px)`,
              `calc(${d.x}vw + ${d.sway}px)`,
              `calc(${d.x}vw + ${d.sway}px)`,
            ],
            y: ['-12%', '0%', '100%', '112%'],     // passes the bottom
            opacity: [0, 1, 1, 0],                 // only fade at the end
          }}
          transition={{
            duration: d.dur,
            delay: d.delay,
            repeat: Infinity,
            ease: 'linear',
            times: [0, 0.07, 0.93, 1],            // visible from ~7%→93%
          }}
          className="absolute will-change-transform"
          style={{ width: d.size, height: d.size }}
        >
          <Image src="/logo.png" alt="candy" width={d.size} height={d.size} className="opacity-90" />
        </motion.div>
      ))}
    </div>
  );
}

function CandyAudio() {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  // Default: sound ON. Persist user preference across refreshes.
  const [muted, setMuted] = React.useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("candy_music_muted") === "1";
  });
  const [blocked, setBlocked] = React.useState(false);

  // Keep element muted state + preference in sync
  React.useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.muted = muted;
    localStorage.setItem("candy_music_muted", muted ? "1" : "0");
  }, [muted]);

  // Try autoplay once; if blocked, unlock on first user interaction
  React.useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    el.loop = true;
    el.preload = "auto";
    el.volume = 0.4; // tweak loudness
    // attributes on the element also help on iOS:
    // <audio autoPlay playsInline ... />

    let cleaned = false;

    const tryPlay = async () => {
      try {
        await el.play();
        setBlocked(false);
      } catch {
        setBlocked(true);
        attachUnlock();
      }
    };

    const unlock = async () => {
      try {
        await el.play();
        setBlocked(false);
        detachUnlock();
      } catch {
        /* still blocked until a proper gesture */
      }
    };

    const onPointer = () => unlock();
    const onKey = () => unlock();
    const onVisible = () => {
      if (document.visibilityState === "visible") unlock();
    };

    const attachUnlock = () => {
      window.addEventListener("pointerdown", onPointer, { once: true });
      window.addEventListener("keydown", onKey, { once: true });
      document.addEventListener("visibilitychange", onVisible);
    };

    const detachUnlock = () => {
      if (cleaned) return;
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisible);
      cleaned = true;
    };

    tryPlay();
    return detachUnlock;
  }, []);

  return (
    <>
      {/* Plays unmuted by default; loops forever. If blocked, we show a prompt. */}
      <audio ref={audioRef} src="/music.mp3" autoPlay playsInline />

      <button
        onClick={() => setMuted((m) => !m)}
        className="fixed bottom-4 right-4 z-40 px-3 py-2 rounded-xl bg-white/10 ring-1 ring-white/20 hover:ring-white/40 backdrop-blur text-sm"
        title={muted ? "Unmute" : "Mute"}
        aria-pressed={muted}
      >
        {blocked ? "🔇 Tap to enable" : muted ? "🔇 Music Off" : "🔊 Music On"}
      </button>
    </>
  );
}




/** ================== MAIN ================== */
export default function CandyApp() {
  useHalloweenFX();

  // Gate + Modal
  const [gateOpen, setGateOpen] = useState(true);
  const [howOpen, setHowOpen] = useState(false);

  // Data state
  const [holders, setHolders] = useState<Holder[] | null>(null);
  const [poolSOL, setPoolSOL] = useState<number | null>(null);
  const [market, setMarket] = useState<MarketInfo>({ marketCapUsd: null });
  const [mint, setMint] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [ops, setOps] = useState<OpsState>({ lastClaim: null, lastSwap: null });
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [coinHoldingsTokens, setCoinHoldingsTokens] = useState<number | null>(null);
  const [totalCoinAirdropped, setTotalCoinAirdropped] = useState<number | null>(null);
  const [coinPriceUsd, setCoinPriceUsd] = useState<number | null>(null);

  // Growth tracking
  const growthRef = useRef<{ t: number; holders: number }[]>([]);
  const [growth, setGrowth] = useState<{ t: number; holders: number }[]>([]);
  const [range, setRange] = useState<'1H' | '1D' | '1W' | '1M' | '1Y' | 'YTD' | 'ALL'>('ALL');
  const rangedGrowth = React.useMemo(() => {
    if (range === 'ALL') return growth;
    const nowTs = Date.now(); let start = 0;
    if (range === '1H') start = nowTs - 3_600_000;
    if (range === '1D') start = nowTs - 86_400_000;
    if (range === '1W') start = nowTs - 7 * 86_400_000;
    if (range === '1M') start = nowTs - 30 * 86_400_000;
    if (range === '1Y') start = nowTs - 365 * 86_400_000;
    if (range === 'YTD') start = new Date(new Date().getFullYear(), 0, 1).getTime();
    return growth.filter((p) => p.t >= start);
  }, [growth, range]);

  /** Prefill from LS */
  useEffect(() => {
    try {
      const lcRaw = localStorage.getItem(LASTCLAIM_LS_KEY);
      if (lcRaw) { const lc = JSON.parse(lcRaw); if (lc && typeof lc.amount !== 'undefined') setOps((prev) => ({ ...prev, lastClaim: lc })); }
    } catch {}
    setTotalCoinAirdropped(sumAirdropsFromLS());
  }, []);

  /** Poll snapshot */
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(SNAPSHOT_URL, { cache: 'no-store', mode: API_BASE ? 'cors' : 'same-origin' });
        if (!alive) return;
        if (res.ok) {
          const j: any = await res.json();
          const hs: Holder[] = Array.isArray(j?.holders)
            ? j.holders.map((x: { address?: string; wallet?: string; balance?: number | string }) => ({ wallet: String(x.address ?? x.wallet ?? ''), balance: Number(x.balance) || 0 }))
            : [];
          setHolders(hs);
          setPoolSOL(j?.rewardPoolSol != null ? Number(j.rewardPoolSol) : null);
          setMint(String(j?.mint || ''));
          setUpdatedAt(j?.updatedAt ? String(j.updatedAt) : null);
          const mc = Number(j?.marketCapUsd); setMarket({ marketCapUsd: Number.isFinite(mc) ? mc : null });
          if (j?.ops) {
            setOps((prev) => ({
              ...prev,
              lastClaim: j.ops.lastClaim ?? prev.lastClaim,
              lastSwap: j.ops.lastSwap ?? prev.lastSwap,
              lastAirdrop: j.ops.lastAirdrop ?? prev.lastAirdrop,
              totalAirdroppedUi: typeof j.ops.totalAirdroppedUi === 'number' ? j.ops.totalAirdroppedUi : prev.totalAirdroppedUi,
            }));
            if (j.ops.lastClaim) { try { localStorage.setItem(LASTCLAIM_LS_KEY, JSON.stringify(j.ops.lastClaim)); } catch {} }
          }
          setCoinHoldingsTokens(j?.coinHoldingsTokens != null ? Number(j.coinHoldingsTokens) : j?.rewardPoolBanana != null ? Number(j.rewardPoolBanana) : null);
          const serverTotal = j?.totalCoinAirdropped ?? j?.airdropTotalUi ?? j?.totalAirdropped ?? j?.stats?.totalAirdroppedUi ?? j?.ops?.totalAirdroppedUi ?? null;
          if (serverTotal != null && Number.isFinite(Number(serverTotal))) setTotalCoinAirdropped(Number(serverTotal));
          else {
            const la = j?.ops?.lastAirdrop ?? null;
            if (la?.cycleId && Number.isFinite(Number(la.totalSentUi))) setTotalCoinAirdropped(addAirdropToLS(String(la.cycleId), Number(la.totalSentUi)));
            else setTotalCoinAirdropped(sumAirdropsFromLS());
          }
          setCoinPriceUsd(j?.coinPriceUsd != null ? Number(j.coinPriceUsd) : null);
          const point = { t: Date.now(), holders: hs.length }; const next = [...growthRef.current, point].slice(-2000); growthRef.current = next; setGrowth(next);
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

  // Derived holders
  const enriched = useMemo(() => {
    const list = Array.isArray(holders) ? holders : [];
    const rows: Row[] = list.map((h) => ({ wallet: h.wallet, tokens: Number(h.balance) || 0 })).filter((r) => r.tokens > 0).sort((a, b) => b.tokens - a.tokens);
    return { rows, totalTokens: rows.reduce((a, r) => a + r.tokens, 0) };
  }, [holders]);

  // Countdown
  const [target, setTarget] = useState(() => nextCycleBoundary());
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 200); return () => clearInterval(t); }, []);
  const msLeft = Math.max(0, target.getTime() - now.getTime());
  useEffect(() => { if (msLeft <= 0) setTarget(nextCycleBoundary()); }, [msLeft]);
  const cycleMs = CYCLE_MINUTES * 60 * 1000;

  // Paging & search
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 12; // cards grid
  const filtered = useMemo(() => enriched.rows.filter((r) => (q ? r.wallet.toLowerCase().includes(q.toLowerCase()) : true)), [enriched.rows, q]);
  useEffect(() => setPage(1), [q]);
  const maxPage = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageRows = filtered.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);

  // Latest drop
  const lastDrop = (ops?.lastClaim as any) ?? (ops as any)?.lastDrop ?? null;
  const droppedValueUsd = coinPriceUsd != null && totalCoinAirdropped != null ? Math.round(coinPriceUsd * totalCoinAirdropped) : null;

  // Milestones
  const holderMilestones = [25, 50, 100, 150, 250, 350, 500, 750, 1000, 1500, 2000, 3000, 4000, 5000];
  const holdersCount = enriched.rows.length;
  const nextHoldersTarget = holderMilestones.find((m) => m > holdersCount) ?? (Math.ceil(holdersCount / 1000) + 1) * 1000;
  const holdersPct = Math.min(100, Math.round((holdersCount / nextHoldersTarget) * 100));
  const mc = market.marketCapUsd ?? 0;
  const mcStep = (x: number) => (x < 100_000 ? 25_000 : x < 250_000 ? 50_000 : x < 1_000_000 ? 100_000 : 250_000);
  const nextMcTarget = (x: number) => Math.ceil((x + 0.0001) / mcStep(x)) * mcStep(x);
  const mcTarget = nextMcTarget(mc);
  const mcStart = mcTarget - mcStep(mc);
  const mcPct = Math.min(100, Math.max(0, Math.round(((mc - mcStart) / (mcTarget - mcStart)) * 100)));
  const [burstHold, setBurstHold] = useState(false);
  const [burstMc, setBurstMc] = useState(false);
  const prevHolders = useRef(holdersCount);
  const prevMc = useRef(mc);
  useEffect(() => { const prevTarget = holderMilestones.find((m) => m > prevHolders.current) ?? (Math.ceil(prevHolders.current / 1000) + 1) * 1000; if (prevHolders.current < prevTarget && holdersCount >= prevTarget) { setBurstHold(true); setTimeout(() => setBurstHold(false), 1700); } prevHolders.current = holdersCount; }, [holdersCount]);
  useEffect(() => { const pTarget = nextMcTarget(prevMc.current); if (prevMc.current < pTarget && mc >= pTarget) { setBurstMc(true); setTimeout(() => setBurstMc(false), 1700); } prevMc.current = mc; }, [mc]);

  // Snapshot download
  const handleDownloadSnapshot = async () => {
    try {
      const res = await fetch(SNAPSHOT_URL, { cache: 'no-store', mode: API_BASE ? 'cors' : 'same-origin' });
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = `candy_snapshot_${Date.now()}.json`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { console.error('Download failed', e); }
  };

  return (
    <div className="relative min-h-screen w-full bg-[#0b0710] text-white overflow-hidden flex flex-col">
      {/* === GLOBAL BACKDROP === */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 [background:radial-gradient(60%_40%_at_70%_10%,rgba(168,85,247,0.18),transparent),radial-gradient(40%_30%_at_0%_100%,rgba(249,115,22,0.15),transparent)]" />
        <div className="absolute inset-0 [background-image:linear-gradient(rgba(255,149,0,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,149,0,0.04)_1px,transparent_1px)] bg-[length:36px_36px]" />
      </div>
{/* Rain layer behind content */}
<CandyRain active={msLeft <= 5000} />
      {/* === TOP BAR === */}
      <header className="relative z-20 w-full">
        <div className="mx-auto max-w-7xl px-4 py-3 grid grid-cols-12 items-center gap-3">
          {/* CA pill (top-left) */}
          <div className="col-span-12 sm:col-span-4 order-2 sm:order-1">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5">
              <span className="text-[11px] uppercase tracking-[0.18em] text-zinc-400">CA</span>
              <span className="font-mono text-sm">{mint ? shortAddr(mint, 6, 6) : '••••••'}</span>
              <button onClick={async()=>{ if (await copyToClipboard(mint||'')) { setCopied(true); setTimeout(()=>setCopied(false),1200);} }} className="text-zinc-300 hover:text-white transition cursor-pointer" title="Copy contract">{copied?'✓':'⧉'}</button>
            </div>
          </div>
          {/* Center brand ribbon */}
          <div className="col-span-12 sm:col-span-4 order-1 sm:order-2 flex items-center justify-center">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-full overflow-hidden ring-1 ring-white/20 bg-white/10 grid place-items-center">
                <Image src="/logo.png" alt="CANDY" width={24} height={24} className="object-contain" />
              </div>
              <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 300, damping: 20 }} className="text-xl font-extrabold tracking-[0.2em] bg-clip-text text-transparent bg-[linear-gradient(90deg,#fb7185,#fb923c,#a855f7)] bg-[length:200%_100%] animate-[shine_3s_linear_infinite]"></motion.div>
            </div>
          </div>
          {/* Right controls */}
          <div className="col-span-12 sm:col-span-4 order-3 flex justify-end items-center gap-2">
            <a href="https://x.com/" target="_blank" rel="noreferrer" className="px-3 py-1.5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-[11px]">𝕏</a>
            <button onClick={()=>setHowOpen(true)} className="px-3 py-1.5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-[11px]">How it works</button>
      
          </div>
        </div>
      </header>

{/* Compact, background-less timer */}
<CandyCompactTimer msLeft={msLeft} cycleMs={cycleMs} maxWidth={720} />



      {/* === HERO: Candy Cauldron === */}
      {!gateOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 backdrop-blur-md">
          <div className="relative text-center">
            <div className="absolute -inset-10 pointer-events-none [background:radial-gradient(50%_40%_at_50%_50%,rgba(249,115,22,0.22),transparent)]" />
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.4 }} className="relative mx-auto w-[min(92vw,720px)] rounded-3xl border border-white/10 bg-[rgba(20,10,24,0.85)] p-8 overflow-hidden">
              {/* bubbling cauldron */}
              <div className="pointer-events-none absolute inset-0">
                <div className="absolute left-1/2 top-8 -translate-x-1/2 h-48 w-48 rounded-full blur-2xl opacity-40" style={{ background: 'radial-gradient(closest-side, rgba(251,146,60,.45),transparent)' }} />
              </div>
              <div className="flex flex-col items-center gap-6">
                <div className="text-[11px] uppercase tracking-[0.25em] text-zinc-400">Next Treat Drop</div>
                <Countdown msLeft={Math.max(0, nextCycleBoundary().getTime() - Date.now())} cycleMs={cycleMs} />
                <motion.button onClick={()=>setGateOpen(true)} whileHover={{ scale: 1.03, rotate: [0,-1,1,0] }} whileTap={{ scale: 0.97 }} className="relative px-10 py-5 rounded-2xl font-extrabold text-lg bg-gradient-to-r from-pink-500 via-orange-500 to-violet-500 ring-2 ring-white/50">
                  TRICK OR TREAT — CLAIM $CANDY
                </motion.button>
                <div className="text-xs text-zinc-400">No wallet action needed. Holding = auto treats.</div>
              </div>
            </motion.div>
          </div>
        </div>
      )}

      {/* === BODY LAYOUT: 3 columns (Sidebar / Machine + Stats / Transparency) === */}
      <main
  className={`relative z-10 mx-auto max-w-7xl px-4 pb-16 w-full flex-1 transition duration-500 ${
    gateOpen ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
  }`}
>
  <div className="grid grid-cols-12 gap-6">
    {/* LEFT COLUMN: Milestones then Holders */}
    <section className="col-span-12 lg:col-span-5 flex flex-col gap-6">
      {/* Milestones */}
      <div className="relative p-4 rounded-2xl border border-white/10 bg-white/5 overflow-hidden">
        <CandyBurst active={burstHold} />
        <CandyBurst active={burstMc} />
        <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Milestones</div>

        {/* Holders */}
        <div className="mt-2 text-sm text-zinc-300">
          Holders <span className="font-semibold text-white">{holdersCount.toLocaleString()}</span> →
          <span className="font-semibold text-white"> {nextHoldersTarget.toLocaleString()}</span>
        </div>
        <div className="mt-2 h-2 w-full rounded-full bg-white/10 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-pink-400 via-orange-400 to-violet-400"
            style={{ width: `${holdersPct}%` }}
          />
        </div>

        {/* Market cap */}
        <div className="mt-4 text-sm text-zinc-300">
          Market cap{' '}
          <span className="font-semibold text-white">
            {market.marketCapUsd == null ? '--' : `$${Number(mc).toLocaleString()}`}
          </span>{' '}
          → <span className="font-semibold text-white">${mcTarget.toLocaleString()}</span>
        </div>
        <div className="mt-2 h-2 w-full rounded-full bg-white/10 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-pink-400 via-orange-400 to-violet-400"
            style={{ width: `${mcPct}%` }}
          />
        </div>
      </div>

      {/* Holders list (10 per page) */}
      <div className="p-4 rounded-2xl border border-white/10 bg-white/5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-sm font-medium tracking-wide text-zinc-200">Holders</div>
          <input
            placeholder="Search wallet…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-9 w-44 rounded-lg border border-white/10 bg-[#150b1e] px-3 text-sm outline-none placeholder:text-zinc-500 focus:border-white/20"
          />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 gap-3">
          {holders === null && (
            <div className="col-span-full text-center text-sm text-zinc-400 py-6">Loading…</div>
          )}
          {holders !== null && pageRows.length === 0 && (
            <div className="col-span-full text-center text-sm text-zinc-400 py-6">No matches.</div>
          )}
          {holders !== null &&
            pageRows.map((r) => (
              <div key={r.wallet} className="rounded-xl border border-white/10 bg-[#150b1e] p-3">
                <div className="flex items-center gap-2">
                  <div className="h-7 w-7 rounded-full bg-white/10 grid place-items-center font-mono text-[10px]">
                    {shortAddr(r.wallet, 4, 4).slice(0, 2)}
                  </div>
                  <div className="flex-1">
                    <div className="font-mono text-xs">{shortAddr(r.wallet)}</div>
                    <div className="text-[11px] text-zinc-400">{r.tokens.toLocaleString()} tokens</div>
                  </div>
                  <button
                    onClick={() => copyToClipboard(r.wallet)}
                    className="text-xs text-zinc-300 hover:text-white"
                    title="Copy address"
                  >
                    ⧉
                  </button>
                </div>
              </div>
            ))}
        </div>

        <div className="mt-3 flex items-center justify-end text-[12px] text-zinc-400">
          <div className="flex items-center gap-2">
            {['First', 'Prev', 'Next', 'Last'].map((label) => (
              <button
                key={label}
                onClick={() => {
                  if (label === 'First') setPage(1);
                  if (label === 'Prev') setPage((p) => Math.max(1, p - 1));
                  if (label === 'Next') setPage((p) => Math.min(maxPage, p + 1));
                  if (label === 'Last') setPage(maxPage);
                }}
                className="h-8 px-3 rounded-lg bg-white/10 ring-1 ring-white/10 hover:ring-white/30"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>

    {/* RIGHT COLUMN: Snapshot + Stats + Latest Drop + Growth */}
    <section className="col-span-12 lg:col-span-7 flex flex-col gap-6">
      {/* Snapshot bar */}
      <div className="p-4 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md flex items-center justify-between gap-3">
        <div className="text-sm text-zinc-300">
          Latest snapshot {updatedAt ? `@ ${new Date(updatedAt).toLocaleTimeString()}` : ''}
        </div>
        <button
          onClick={handleDownloadSnapshot}
          className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-sm ring-1 ring-white/10 hover:ring-white/30"
        >
          Download List
        </button>
      </div>

      {/* Stat tiles: Market Cap wide on top, two tiles below */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Market Cap (full width) */}
        <div className="sm:col-span-2 p-5 rounded-2xl border border-white/10 bg-[#150b1e]">
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-300/80">Market Cap</div>
          <div className="mt-1 text-3xl md:text-4xl font-semibold">
            {market.marketCapUsd == null ? '--' : `$${compact(Math.max(0, market.marketCapUsd))}`}
          </div>
        </div>

        {/* $CANDY available */}
        <div className="p-5 rounded-2xl border border-white/10 bg-[#150b1e]">
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-300/80">$CANDY available</div>
          <div className="mt-1 text-2xl font-semibold">
            {coinHoldingsTokens == null ? '--' : Math.floor(coinHoldingsTokens).toLocaleString()}
          </div>
        </div>

        {/* $CANDY given away */}
        <div className="p-5 rounded-2xl border border-white/10 bg-[#150b1e]">
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-300/80">$CANDY given away</div>
          <div className="mt-1 text-2xl font-semibold">
            {totalCoinAirdropped == null ? '--' : Math.floor(totalCoinAirdropped).toLocaleString()}
          </div>
          {droppedValueUsd != null && (
            <div className="mt-1 text-[11px] text-zinc-400">≈ ${droppedValueUsd.toLocaleString()} USD</div>
          )}
        </div>
      </div>

      {/* Latest drop */}
      <div className="p-5 rounded-2xl border border-white/10 bg-[#150b1e]">
        <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-300/80">Latest Drop (SOL)</div>
        <div className="mt-1 text-xl font-semibold">
          {lastDrop != null
            ? toNum((lastDrop as any).amount).toLocaleString(undefined, { maximumFractionDigits: 9 })
            : '--'}
        </div>
        <div className="mt-1 text-[11px] text-zinc-400">
          {lastDrop?.tx || (lastDrop as any)?.url ? (
            <a
              className="underline decoration-zinc-500/50 hover:decoration-white"
              href={(lastDrop as any)?.url ?? solscanTx((lastDrop as any)?.tx)!}
              target="_blank"
              rel="noreferrer"
            >
              View on Solscan
            </a>
          ) : (
            'No tx yet'
          )}
          {lastDrop?.at && (
            <span className="opacity-70"> • {new Date(lastDrop.at).toLocaleTimeString()}</span>
          )}
        </div>
      </div>

      {/* Holders Growth (moved under right column) */}
      <div className="p-4 rounded-2xl border border-white/10 bg-white/5">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-medium tracking-wide text-zinc-200">Holders Growth</div>
          <div className="flex items-center gap-1">
            {(['1H', '1D', '1W', '1M', '1Y', 'YTD', 'ALL'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setRange(k)}
                className={`px-2.5 py-1 rounded-lg text-[11px] border ${
                  range === k ? 'border-orange-400/70 bg-orange-400/10' : 'border-white/10 bg-white/5'
                }`}
              >
                {k}
              </button>
            ))}
          </div>
        </div>
        <HoldersGrowthChart data={rangedGrowth} />
      </div>
    </section>
  </div>
</main>


      {/* === FOOTER === */}
      <footer className="relative z-10 border-t border-white/10 bg-black/20 w-full mt-auto">
        <div className="mx-auto max-w-7xl px-4 py-3 text-center text-[11px] text-zinc-500">© 2025 CANDY — Trick. Treat. Repeat.</div>
      </footer>

      {/* === HOW IT WORKS MODAL === */}
      <AnimatePresence>
        {howOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-center justify-center px-4">
            <motion.div initial={{ y: 16, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 16, scale: 0.98 }} className="relative max-w-lg w-full rounded-2xl border border-white/10 bg-[#150b1e] p-6 text-sm">
              <button onClick={() => setHowOpen(false)} className="absolute right-3 top-3 h-8 w-8 rounded-lg bg-white/10 hover:bg-white/15 grid place-items-center">✕</button>
              <div className="flex items-center gap-3 mb-3">
                <div className="h-8 w-8 rounded-full overflow-hidden ring-1 ring-white/20 bg-white/10">
                  <Image src="/logo.png" alt="CANDY" width={32} height={32} className="object-contain" />
                </div>
                <div className="text-lg font-semibold">How it works</div>
              </div>
              <ol className="list-none space-y-4 text-zinc-200 text-sm">
  {[
    { icon: "🎃", text: <>Every <span className="font-bold text-orange-400">3 minutes</span> the cauldron bubbles & we snapshot holders.</> },
    { icon: "🪄", text: <>Creator rewards get <span className="text-violet-400 font-semibold">magically converted</span> server-side (automatic).</> },
    { icon: "🍬", text: <>Sweet rewards are airdropped straight as <span className="text-pink-400 font-bold">$CANDY</span> into your bags.</> },
    { icon: "👻", text: <>All you do is <span className="font-semibold">hold</span>. Treats arrive on their own — no buttons, no gas, no tricks.</> },
    { icon: "🔮", text: <>Transparency spells: latest <span className="text-orange-300">claim</span>, <span className="text-orange-300">swap</span>, & <span className="text-orange-300">airdrop</span> links glow in the panel.</> },
  ].map((step, i) => (
    <motion.li
      key={i}
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: i * 0.15 }}
      className="flex items-start gap-3"
    >
      <span className="text-lg">{step.icon}</span>
      <span>{step.text}</span>
    </motion.li>
  ))}
</ol>

            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
<CandyAudio />

      {/* Hide native cursor on pointer-fine */}
      <style>{`.candy-hide-cursor * { cursor: none !important }`}</style>
    </div>
  );
}


