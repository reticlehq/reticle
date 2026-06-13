import { useApp } from '../store/store.js';
import { AreaChart } from '../components/AreaChart.js';
import { CountUp, Sparkline } from '../components/primitives.js';
import type { ActivityItem } from '../data/seed.js';

const FEED_COLOR: Record<ActivityItem['kind'], string> = {
  deploy: 'var(--success)',
  alert: 'var(--danger)',
  scale: 'var(--info)',
  rollback: 'var(--warning)',
};

export function Overview(): React.ReactElement {
  const kpis = useApp((s) => s.kpis);
  const series = useApp((s) => s.series);
  const activity = useApp((s) => s.activity);

  return (
    <div className="view">
      <div className="grid-kpi stagger" style={{ marginBottom: 16 }}>
        {kpis.map((k) => {
          const up = k.delta >= 0;
          const decimals = k.suffix === '%' ? 1 : 0;
          return (
            <div key={k.key} className="panel kpi" data-testid={`kpi-${k.key}`}>
              <div className="eyebrow">{k.label}</div>
              <div className="kpi-val">
                <CountUp value={k.value} decimals={decimals} suffix={k.suffix ?? ''} />
              </div>
              <div className={`kpi-delta ${up ? 'up' : 'down'}`}>
                {up ? '▲' : '▼'} {Math.abs(k.delta).toFixed(1)}
                {k.suffix === '%' ? 'pt' : '%'}{' '}
                <span style={{ color: 'var(--faint)' }}>vs last week</span>
              </div>
              <div className="kpi-spark">
                <Sparkline data={k.spark} stroke={up ? 'var(--success)' : 'var(--danger)'} />
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 16 }}>
        <div className="panel panel-pad">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
            <div>
              <div className="eyebrow">Traffic</div>
              <h3 style={{ fontSize: 16, marginTop: 4 }}>Requests per minute</h3>
            </div>
            <span className="badge badge-success">
              <span className="dot" /> live
            </span>
          </div>
          <AreaChart data={series} />
        </div>

        <div className="panel panel-pad" data-testid="activity-feed">
          <div className="eyebrow" style={{ marginBottom: 6 }}>
            Activity
          </div>
          {activity.map((a) => (
            <div key={a.id} className="feed-item">
              <span className="feed-dot" style={{ background: FEED_COLOR[a.kind] }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, lineHeight: 1.4 }}>{a.text}</div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
                  {a.at} ago · {a.kind}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
