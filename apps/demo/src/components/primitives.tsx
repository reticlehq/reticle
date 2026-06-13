import { useEffect, useRef, useState } from 'react';
import type { DeployStatus, Env } from '../data/seed.js';

/** A status pill with a colored dot. Maps deploy status / env to the badge tone. */
const STATUS_TONE: Record<DeployStatus, string> = {
  live: 'badge-success',
  building: 'badge-info',
  queued: 'badge-warning',
  failed: 'badge-danger',
};

export function StatusBadge({ status }: { status: DeployStatus }): React.ReactElement {
  return (
    <span className={`badge ${STATUS_TONE[status]}`}>
      <span className="dot" />
      {status}
    </span>
  );
}

const ENV_TONE: Record<Env, string> = {
  production: 'badge-danger',
  staging: 'badge-warning',
  preview: 'badge-info',
};

export function EnvBadge({ env }: { env: Env }): React.ReactElement {
  return <span className={`badge ${ENV_TONE[env]}`}>{env}</span>;
}

/** Counts up to `value` on mount — the satisfying KPI animation. Respects reduced motion via CSS. */
export function CountUp({
  value,
  decimals = 0,
  suffix = '',
}: {
  value: number;
  decimals?: number;
  suffix?: string;
}): React.ReactElement {
  const [n, setN] = useState(0);
  const raf = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const dur = 900;
    const tick = (t: number): void => {
      const p = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setN(value * eased);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value]);
  return (
    <span className="mono">
      {n.toFixed(decimals)}
      {suffix}
    </span>
  );
}

/** A tiny filled sparkline (used inside KPI cards). */
export function Sparkline({
  data,
  w = 96,
  h = 36,
  stroke = 'var(--iris2)',
}: {
  data: number[];
  w?: number;
  h?: number;
  stroke?: string;
}): React.ReactElement {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const span = max - min || 1;
  const step = w / (data.length - 1);
  const pts = data.map((v, i) => `${i * step},${h - ((v - min) / span) * (h - 6) - 3}`);
  const id = `sg-${stroke.replace(/[^a-z0-9]/gi, '')}`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline points={`0,${h} ${pts.join(' ')} ${w},${h}`} fill={`url(#${id})`} stroke="none" />
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke={stroke}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
