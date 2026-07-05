import { useMemo, useState } from 'react';
import { useApp, type ViewId } from '../store/store.js';
import { IconBug, IconGrid, IconPlus, IconRocket, IconSearch, IconSparkles } from './icons.js';

interface Cmd {
  id: string;
  label: string;
  hint: string;
  icon: (p: { size?: number }) => React.ReactElement;
  run: () => void;
}

export function CommandPalette(): React.ReactElement | null {
  const open = useApp((s) => s.paletteOpen);
  const setPalette = useApp((s) => s.setPalette);
  const setView = useApp((s) => s.setView);
  const setNewDeploy = useApp((s) => s.setNewDeploy);
  const [q, setQ] = useState('');

  const go = (v: ViewId): void => {
    setView(v);
    setPalette(false);
  };

  const cmds: Cmd[] = useMemo(
    () => [
      {
        id: 'overview',
        label: 'Go to Overview',
        hint: 'view',
        icon: IconGrid,
        run: () => go('overview'),
      },
      {
        id: 'deployments',
        label: 'Go to Deployments',
        hint: 'view',
        icon: IconRocket,
        run: () => go('deployments'),
      },
      {
        id: 'compose',
        label: 'Go to Compose',
        hint: 'view',
        icon: IconSparkles,
        run: () => go('compose'),
      },
      {
        id: 'diagnostics',
        label: 'Go to Diagnostics',
        hint: 'view',
        icon: IconBug,
        run: () => go('diagnostics'),
      },
      {
        id: 'new',
        label: 'New deployment',
        hint: 'action',
        icon: IconPlus,
        run: () => {
          setView('deployments');
          setNewDeploy(true);
          setPalette(false);
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  if (!open) return null;
  const filtered = cmds.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="palette-scrim" onClick={() => setPalette(false)}>
      <div className="palette" data-testid="palette" onClick={(e) => e.stopPropagation()}>
        <div
          className="row"
          style={{ gap: 12, padding: '16px 18px', borderBottom: '1px solid var(--hairline)' }}
        >
          <span style={{ color: 'var(--faint)' }}>
            <IconSearch size={17} />
          </span>
          <input
            className="field"
            data-testid="palette-input"
            autoFocus
            placeholder="Type a command or search…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setPalette(false);
              if (e.key === 'Enter' && filtered[0]) filtered[0].run();
            }}
            style={{ border: 'none', background: 'none', padding: 0, fontSize: 15 }}
          />
          <span className="kbd">esc</span>
        </div>
        <div style={{ padding: 8, maxHeight: 320, overflowY: 'auto' }}>
          {filtered.map((c) => (
            <button
              key={c.id}
              type="button"
              className="menu-item"
              data-testid={`cmd-${c.id}`}
              onClick={c.run}
            >
              <span style={{ color: 'var(--muted)' }}>
                <c.icon size={16} />
              </span>
              {c.label}
              <span className="kbd" style={{ marginLeft: 'auto' }}>
                {c.hint}
              </span>
            </button>
          ))}
          {filtered.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--faint)' }}>
              No matches
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
