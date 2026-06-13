import { useState } from 'react';
import { useApp } from '../store/store.js';
import { fault } from '../lib/api.js';
import { emit, Sig } from '../lib/iris-bridge.js';
import { IconBolt, IconBug } from '../components/icons.js';

interface FaultDef {
  kind: string;
  testid: string;
  label: string;
  desc: string;
}

const FAULTS: FaultDef[] = [
  { kind: '404', testid: 'fault-404', label: '404 Not Found', desc: 'GET /api/broken/404' },
  { kind: '500', testid: 'fault-500', label: '500 Server Error', desc: 'GET /api/broken/500' },
  { kind: 'cors', testid: 'fault-cors', label: 'CORS blocked', desc: 'missing allow-origin' },
  {
    kind: 'wrong-format',
    testid: 'fault-wrong-format',
    label: 'Wrong format',
    desc: 'HTML where JSON expected',
  },
  {
    kind: 'wrong-data',
    testid: 'fault-wrong-data',
    label: 'Wrong shape',
    desc: '200 OK, no items[]',
  },
];

const statusTone = (s: number | 'ERR'): string =>
  s === 'ERR'
    ? 'var(--danger)'
    : s >= 500
      ? 'var(--danger)'
      : s >= 400
        ? 'var(--warning)'
        : 'var(--success)';

export function Diagnostics(): React.ReactElement {
  const log = useApp((s) => s.requestLog);
  const logRequest = useApp((s) => s.logRequest);
  const [consoleErrors, setConsoleErrors] = useState(0);

  const inject = async (f: FaultDef): Promise<void> => {
    const r = await fault(f.kind);
    logRequest(r);
    emit(Sig.FAULT_INJECTED, { kind: f.kind, status: r.status });
  };

  // A deliberately buggy control: logs a real console error (the crawl/console showcase).
  const triggerBug = (): void => {
    setConsoleErrors((n) => n + 1);
    console.error('Render crash in <ChartWidget>: cannot read property "series" of undefined');
  };

  return (
    <div
      className="view"
      style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 16, maxWidth: 1140 }}
    >
      <div className="panel panel-pad">
        <div className="eyebrow">Fault injection</div>
        <h3 style={{ fontSize: 16, margin: '6px 0 16px' }}>Break things on purpose</h3>
        <div style={{ display: 'grid', gap: 10 }}>
          {FAULTS.map((f) => (
            <button
              key={f.kind}
              type="button"
              className="btn"
              data-testid={f.testid}
              onClick={() => void inject(f)}
              style={{ justifyContent: 'flex-start', padding: '12px 14px', width: '100%' }}
            >
              <span style={{ color: 'var(--warning)' }}>
                <IconBolt size={16} />
              </span>
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 600 }}>{f.label}</div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>
                  {f.desc}
                </div>
              </div>
            </button>
          ))}
          <button
            type="button"
            className="btn"
            data-testid="fault-buggy"
            onClick={triggerBug}
            style={{
              justifyContent: 'flex-start',
              padding: '12px 14px',
              width: '100%',
              borderColor: 'rgba(251,113,133,0.3)',
            }}
          >
            <span style={{ color: 'var(--danger)' }}>
              <IconBug size={16} />
            </span>
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontWeight: 600 }}>Buggy widget</div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>
                throws a console error
              </div>
            </div>
            <span
              className="badge badge-danger mono"
              data-testid="console-count"
              style={{ marginLeft: 'auto' }}
            >
              {consoleErrors} err
            </span>
          </button>
        </div>
      </div>

      <div className="panel">
        <div
          className="row"
          style={{
            justifyContent: 'space-between',
            padding: '14px 16px',
            borderBottom: '1px solid var(--hairline)',
          }}
        >
          <div className="eyebrow">Network</div>
          <span className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>
            {log.length} requests
          </span>
        </div>
        <div data-testid="request-log" style={{ maxHeight: 460, overflowY: 'auto' }}>
          {log.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--faint)' }}>
              Inject a fault to watch the wire.
            </div>
          ) : (
            log.map((r) => (
              <div key={r.id} className="logline">
                <span style={{ color: 'var(--muted)' }}>{r.method}</span>
                <span style={{ color: statusTone(r.status), fontWeight: 600 }}>{r.status}</span>
                <span
                  style={{
                    color: 'var(--text)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {r.path}
                </span>
                <span style={{ color: 'var(--faint)' }}>{r.ms}ms</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
