import { useState } from 'react';

/** A premium area chart: iris-gradient fill, glowing stroke, hover crosshair + tooltip. */
export function AreaChart({
  data,
  height = 220,
}: {
  data: number[];
  height?: number;
}): React.ReactElement {
  const [hover, setHover] = useState<number | null>(null);
  const w = 1000;
  const h = height;
  const pad = 16;
  const max = Math.max(...data) * 1.1;
  const min = Math.min(...data) * 0.6;
  const span = max - min || 1;
  const step = (w - pad * 2) / (data.length - 1);
  const x = (i: number): number => pad + i * step;
  const y = (v: number): number => pad + (1 - (v - min) / span) * (h - pad * 2);
  const line = data.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const area = `${x(0)},${h - pad} ${line} ${x(data.length - 1)},${h - pad}`;

  return (
    <svg
      data-testid="area-chart"
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      height={h}
      preserveAspectRatio="none"
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const i = Math.round(((e.clientX - rect.left) / rect.width) * (data.length - 1));
        setHover(Math.max(0, Math.min(data.length - 1, i)));
      }}
      onMouseLeave={() => setHover(null)}
      style={{ display: 'block', cursor: 'crosshair' }}
    >
      <defs>
        <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6366f1" stopOpacity="0.38" />
          <stop offset="55%" stopColor="#22d3ee" stopOpacity="0.12" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="areaStroke" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#22d3ee" />
          <stop offset="55%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#c084fc" />
        </linearGradient>
        <filter id="glow">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {[0.25, 0.5, 0.75].map((g) => (
        <line
          key={g}
          x1={pad}
          x2={w - pad}
          y1={pad + g * (h - pad * 2)}
          y2={pad + g * (h - pad * 2)}
          stroke="rgba(255,255,255,0.05)"
        />
      ))}
      <polygon points={area} fill="url(#areaFill)" />
      <polyline
        points={line}
        fill="none"
        stroke="url(#areaStroke)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter="url(#glow)"
      />
      {hover !== null ? (
        <g>
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={pad}
            y2={h - pad}
            stroke="rgba(255,255,255,0.18)"
            strokeDasharray="3 3"
          />
          <circle
            cx={x(hover)}
            cy={y(data[hover] ?? 0)}
            r="5"
            fill="#0f111a"
            stroke="#c084fc"
            strokeWidth="2.5"
          />
          <g
            transform={`translate(${Math.min(x(hover) + 10, w - 120)}, ${y(data[hover] ?? 0) - 30})`}
          >
            <rect width="104" height="34" rx="8" fill="#11131b" stroke="#2c3040" />
            <text x="12" y="15" fill="#9398a8" fontSize="10" fontFamily="JetBrains Mono">
              req/min
            </text>
            <text
              x="12"
              y="28"
              fill="#e9ebf2"
              fontSize="13"
              fontFamily="JetBrains Mono"
              fontWeight="600"
            >
              {data[hover]}
            </text>
          </g>
        </g>
      ) : null}
    </svg>
  );
}
