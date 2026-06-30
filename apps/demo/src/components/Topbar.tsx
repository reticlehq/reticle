import { useApp, type ViewId } from '../store/store.js';
import { IconSearch } from './icons.js';

const TITLES: Record<ViewId, { title: string; sub: string }> = {
  overview: { title: 'Overview', sub: 'fleet health at a glance' },
  deployments: { title: 'Deployments', sub: 'every ship, every service' },
  compose: { title: 'Compose', sub: 'generate a release note' },
  diagnostics: { title: 'Diagnostics', sub: 'inject faults, watch the wire' },
};

export function Topbar(): React.ReactElement {
  const view = useApp((s) => s.view);
  const setPalette = useApp((s) => s.setPalette);
  const auth = useApp((s) => s.auth);
  const t = TITLES[view];

  return (
    <header className="topbar">
      <div className="crumb">
        <span className="eyebrow">Reticle</span>
        <span className="sep">/</span>
        <h1>{t.title}</h1>
        <span style={{ color: 'var(--faint)', fontSize: 13 }}>{t.sub}</span>
      </div>
      <div className="spacer" />
      <button
        type="button"
        className="kbd-search"
        data-testid="cmdk-open"
        onClick={() => setPalette(true)}
      >
        <IconSearch size={15} />
        Search or jump to…
        <span className="kbd">⌘K</span>
      </button>
      <div
        title={auth?.email}
        style={{
          width: 34,
          height: 34,
          borderRadius: 999,
          background: 'var(--reticle)',
          display: 'grid',
          placeItems: 'center',
          color: '#0a0b12',
          fontWeight: 800,
          fontSize: 13,
        }}
      >
        {(auth?.email ?? 'A')[0]?.toUpperCase()}
      </div>
    </header>
  );
}
