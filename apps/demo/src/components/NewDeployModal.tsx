import { useState } from 'react';
import { useApp } from '../store/store.js';
import type { Env } from '../data/seed.js';
import { IconRocket, IconX } from './icons.js';

const ENVS: Env[] = ['production', 'staging', 'preview'];

/** New-deploy modal: pick a service + env, submit → optimistic row + building→live toast. */
export function NewDeployModal(): React.ReactElement | null {
  const open = useApp((s) => s.newDeployOpen);
  const close = (): void => useApp.getState().setNewDeploy(false);
  const create = useApp((s) => s.createDeployment);
  const [service, setService] = useState('');
  const [env, setEnv] = useState<Env>('staging');

  if (!open) return null;

  const submit = (): void => {
    if (service.trim().length === 0) return;
    create(service.trim(), env);
    setService('');
    close();
  };

  return (
    <div className="scrim" onClick={close}>
      <div
        className="panel modal panel-pad"
        data-testid="deploy-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 18 }}>
          <div className="row" style={{ gap: 10 }}>
            <span style={{ color: 'var(--iris2)' }}>
              <IconRocket size={18} />
            </span>
            <h3 style={{ fontSize: 16 }}>New deployment</h3>
          </div>
          <button
            type="button"
            className="btn-ghost btn"
            data-testid="deploy-cancel"
            onClick={close}
            aria-label="Close"
          >
            <IconX size={16} />
          </button>
        </div>

        <label className="label" htmlFor="dep-name">
          Service
        </label>
        <input
          id="dep-name"
          className="field"
          data-testid="deploy-name"
          placeholder="e.g. payments-api"
          value={service}
          autoFocus
          onChange={(e) => setService(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />

        <label className="label" htmlFor="dep-env" style={{ marginTop: 16 }}>
          Environment
        </label>
        <div className="row" data-testid="deploy-env-select" style={{ gap: 8 }}>
          {ENVS.map((e) => (
            <button
              key={e}
              type="button"
              data-testid={`deploy-env-${e}`}
              className={`btn${env === e ? ' btn-primary' : ''}`}
              onClick={() => setEnv(e)}
              style={{ flex: 1, justifyContent: 'center' }}
            >
              {e}
            </button>
          ))}
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 10, marginTop: 24 }}>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="deploy-submit"
            onClick={submit}
            disabled={service.trim().length === 0}
          >
            <IconRocket size={15} /> Deploy
          </button>
        </div>
      </div>
    </div>
  );
}
