import { useApp, type ViewId } from '../store/store.js';
import { IconBug, IconGrid, IconRocket, IconSparkles } from './icons.js';

interface NavDef {
  id: ViewId;
  label: string;
  icon: (p: { className?: string }) => React.ReactElement;
}

const NAV: NavDef[] = [
  { id: 'overview', label: 'Overview', icon: IconGrid },
  { id: 'deployments', label: 'Deployments', icon: IconRocket },
  { id: 'compose', label: 'Compose', icon: IconSparkles },
  { id: 'diagnostics', label: 'Diagnostics', icon: IconBug },
];

export function Sidebar(): React.ReactElement {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const deployCount = useApp((s) => s.deployments.length);

  return (
    <aside className="sidebar">
      <div className="brand" data-testid="brand">
        <div className="brand-glyph" />
        <div>
          <div className="brand-name">Iris</div>
          <div className="brand-sub">mission control</div>
        </div>
      </div>

      <div className="nav-section">Workspace</div>
      {NAV.map(({ id, label, icon: Ico }) => (
        <button
          key={id}
          type="button"
          data-testid={`nav-${id}`}
          className={`nav-item${view === id ? ' active' : ''}`}
          aria-current={view === id ? 'page' : undefined}
          onClick={() => setView(id)}
        >
          <Ico className="nav-ico" />
          {label}
          {id === 'deployments' ? <span className="nav-badge mono">{deployCount}</span> : null}
        </button>
      ))}

      <div className="sidebar-foot">
        <div className="session-pill" data-testid="session-pill" title="Iris agent session">
          <span className="dot live" />
          <div style={{ lineHeight: 1.25 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600 }}>Iris connected</div>
            <div className="brand-sub" style={{ letterSpacing: '0.1em' }}>
              session · demo
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
