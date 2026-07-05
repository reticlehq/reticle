import { useMemo, useState } from 'react';
import { useApp, type EnvFilter } from '../store/store.js';
import { DeployTable } from '../components/DeployTable.js';
import { NewDeployModal } from '../components/NewDeployModal.js';
import { DeployDrawer } from '../components/DeployDrawer.js';
import { IconChevron, IconPlus, IconSearch } from '../components/icons.js';

const ENV_OPTIONS: { id: EnvFilter; label: string }[] = [
  { id: 'all', label: 'All environments' },
  { id: 'production', label: 'Production' },
  { id: 'staging', label: 'Staging' },
  { id: 'preview', label: 'Preview' },
];

export function Deployments(): React.ReactElement {
  const deployments = useApp((s) => s.deployments);
  const filter = useApp((s) => s.filter);
  const setFilter = useApp((s) => s.setFilter);
  const setNewDeploy = useApp((s) => s.setNewDeploy);
  const [envOpen, setEnvOpen] = useState(false);

  const rows = useMemo(
    () =>
      deployments.filter(
        (d) =>
          (filter.env === 'all' || d.env === filter.env) &&
          (filter.query === '' || d.service.toLowerCase().includes(filter.query.toLowerCase())),
      ),
    [deployments, filter],
  );

  const envLabel = ENV_OPTIONS.find((e) => e.id === filter.env)?.label ?? 'All';

  return (
    <div className="view">
      <div className="panel" data-testid="deploy-table">
        <div className="table-toolbar">
          <div
            className="row"
            style={{
              flex: 1,
              gap: 9,
              maxWidth: 320,
              padding: '8px 12px',
              background: 'var(--panel-2)',
              border: '1px solid var(--border)',
              borderRadius: 10,
            }}
          >
            <span style={{ color: 'var(--faint)' }}>
              <IconSearch size={15} />
            </span>
            <input
              data-testid="filter-search"
              placeholder="Filter by service…"
              value={filter.query}
              onChange={(e) => setFilter({ query: e.target.value })}
              style={{
                background: 'none',
                border: 'none',
                outline: 'none',
                color: 'var(--text)',
                fontFamily: 'inherit',
                fontSize: 13.5,
                width: '100%',
              }}
            />
          </div>

          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="btn"
              data-testid="env-filter"
              onClick={() => setEnvOpen((v) => !v)}
            >
              {envLabel}
              <IconChevron size={14} />
            </button>
            {envOpen ? (
              <div className="popover" data-testid="env-menu" style={{ top: 44, left: 0 }}>
                {ENV_OPTIONS.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    className="menu-item"
                    data-testid={`env-${e.id}`}
                    onClick={() => {
                      setFilter({ env: e.id });
                      setEnvOpen(false);
                    }}
                  >
                    {e.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="spacer" />
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--faint)' }}>
            {rows.length} of {deployments.length}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="new-deploy"
            onClick={() => setNewDeploy(true)}
          >
            <IconPlus size={15} /> New deploy
          </button>
        </div>

        <div className="thead">
          <span />
          <span>Service</span>
          <span>Env</span>
          <span>Status</span>
          <span>Region</span>
          <span>Duration</span>
          <span />
        </div>

        <DeployTable rows={rows} />
      </div>

      <NewDeployModal />
      <DeployDrawer />
    </div>
  );
}
