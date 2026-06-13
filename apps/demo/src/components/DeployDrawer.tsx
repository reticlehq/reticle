import { useApp } from '../store/store.js';
import { EnvBadge, StatusBadge } from './primitives.js';
import { IconBolt, IconGit, IconX } from './icons.js';

/** Right-side detail drawer for a deployment — opened from a row (network-free, store-driven). */
export function DeployDrawer(): React.ReactElement | null {
  const id = useApp((s) => s.drawerId);
  const dep = useApp((s) => s.deployments.find((d) => d.id === id));
  const close = useApp((s) => s.closeDrawer);
  const ship = useApp((s) => s.shipDeployment);
  if (id === null || dep === undefined) return null;

  const Field = ({ k, v }: { k: string; v: string }): React.ReactElement => (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '11px 0',
        borderBottom: '1px solid var(--hairline)',
      }}
    >
      <span style={{ color: 'var(--muted)', fontSize: 13 }}>{k}</span>
      <span className="mono" style={{ fontSize: 12.5 }}>
        {v}
      </span>
    </div>
  );

  return (
    <>
      <div className="drawer-scrim" onClick={close} />
      <aside className="drawer" data-testid="drawer">
        <div
          className="row panel-pad"
          style={{ justifyContent: 'space-between', borderBottom: '1px solid var(--hairline)' }}
        >
          <div className="row" style={{ gap: 10 }}>
            <StatusBadge status={dep.status} />
            <h3 style={{ fontSize: 16 }}>{dep.service}</h3>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            data-testid="drawer-close"
            onClick={close}
            aria-label="Close"
          >
            <IconX size={16} />
          </button>
        </div>

        <div className="panel-pad" style={{ overflowY: 'auto' }}>
          <div className="row" style={{ gap: 8, marginBottom: 8 }}>
            <EnvBadge env={dep.env} />
            <span className="badge badge-muted">
              <IconGit size={11} /> {dep.commit}
            </span>
          </div>
          <Field k="Deployment ID" v={`#${dep.id}`} />
          <Field k="Region" v={dep.region} />
          <Field k="Author" v={dep.author} />
          <Field
            k="Duration"
            v={dep.durationMs === 0 ? 'building…' : `${(dep.durationMs / 1000).toFixed(1)}s`}
          />
          <Field k="Created" v={dep.createdAt} />

          <div className="eyebrow" style={{ margin: '20px 0 10px' }}>
            Build log
          </div>
          <pre
            className="mono"
            style={{
              background: 'var(--panel-2)',
              border: '1px solid var(--hairline)',
              borderRadius: 10,
              padding: 14,
              fontSize: 11.5,
              color: 'var(--muted)',
              overflowX: 'auto',
              margin: 0,
            }}
          >
            {`▸ resolving dependencies … ok
▸ building ${dep.service} … ok
▸ uploading artifact (4.2 MB) … ok
▸ routing ${dep.env} traffic → ${dep.region}
✓ ${dep.status === 'live' ? 'live' : dep.status}`}
          </pre>

          {dep.status !== 'live' ? (
            <button
              type="button"
              className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center', marginTop: 18 }}
              onClick={() => ship(dep.id)}
            >
              <IconBolt size={15} /> Ship now
            </button>
          ) : null}
        </div>
      </aside>
    </>
  );
}
