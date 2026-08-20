import { useApp, type ViewId } from '../store/store.js';
import { isEnterpriseEnabled } from '../lib/enterprise-config.js';
import { IconBug, IconGrid, IconRocket, IconSparkles, IconSave } from './icons.js';

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
  // The hostile fixture: reachable by click so the overhead A/B works with the SDK disabled too.
  { id: 'hostile', label: 'Hostile', icon: IconBug },
  // Response-ignored fixture: server-backed write whose render trails the response.
  { id: 'saved-items', label: 'Saved Items', icon: IconSave },
];

// The enterprise-scale fixture is opt-in: without its URL knob the nav item is not even rendered,
// so no existing benchmark sees an extra button or an extra DOM node.
const NAV_ENTERPRISE: NavDef = { id: 'enterprise', label: 'Enterprise', icon: IconGrid };

export function Sidebar(): React.ReactElement {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const deployCount = useApp((s) => s.deployments.length);

  return (
    <aside className="sidebar">
      <div className="brand" data-testid="brand">
        <div className="brand-glyph" />
        <div>
          <div className="brand-name">Reticle</div>
          <div className="brand-sub">mission control</div>
        </div>
      </div>

      <div className="nav-section">Workspace</div>
      {(isEnterpriseEnabled() ? [...NAV, NAV_ENTERPRISE] : NAV).map(({ id, label, icon: Ico }) => (
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
          {'deployments' === id ? <span className="nav-badge mono">{deployCount}</span> : null}
        </button>
      ))}

      <div className="sidebar-foot">
        <div className="session-pill" data-testid="session-pill" title="Reticle agent session">
          <span className="dot live" />
          <div style={{ lineHeight: 1.25 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600 }}>Reticle connected</div>
            <div className="brand-sub" style={{ letterSpacing: '0.1em' }}>
              session · demo
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
