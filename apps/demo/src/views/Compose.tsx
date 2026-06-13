import { useApp } from '../store/store.js';
import { generateScript } from '../lib/api.js';
import { emit, Sig } from '../lib/iris-bridge.js';
import { IconSparkles } from '../components/icons.js';

/** Compose a release note via the real LLM endpoint. Title commits on blur; output is dynamic. */
export function Compose(): React.ReactElement {
  const compose = useApp((s) => s.compose);
  const setCompose = useApp((s) => s.setCompose);
  const logRequest = useApp((s) => s.logRequest);

  const generate = async (): Promise<void> => {
    if (compose.prompt.trim().length === 0) return;
    setCompose({ generating: true, result: '' });
    const { script, source, r } = await generateScript(compose.prompt.trim());
    logRequest(r);
    setCompose({ result: script, generating: false });
    emit(Sig.COMPOSE_GENERATED, { source, length: script.length });
  };

  return (
    <div
      className="view"
      style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, maxWidth: 1100 }}
    >
      <div className="panel panel-pad">
        <div className="eyebrow">Draft</div>
        <h3 style={{ fontSize: 16, margin: '6px 0 18px' }}>Release note generator</h3>

        <label className="label" htmlFor="c-title">
          Title <span style={{ color: 'var(--faint)' }}>· commits on blur</span>
        </label>
        <input
          id="c-title"
          className="field"
          data-testid="compose-title"
          placeholder="v2.4 — faster builds"
          value={compose.title}
          onChange={(e) => setCompose({ title: e.target.value })}
          onBlur={(e) => emit(Sig.TITLE_COMMITTED, { value: e.target.value })}
        />

        <label className="label" htmlFor="c-prompt" style={{ marginTop: 16 }}>
          What shipped?
        </label>
        <textarea
          id="c-prompt"
          className="field"
          data-testid="compose-prompt"
          rows={6}
          placeholder="Summarize the changes in this release…"
          value={compose.prompt}
          onChange={(e) => setCompose({ prompt: e.target.value })}
          style={{ resize: 'vertical', lineHeight: 1.5 }}
        />

        <button
          type="button"
          className="btn btn-primary"
          data-testid="compose-generate"
          onClick={() => void generate()}
          disabled={compose.generating || compose.prompt.trim().length === 0}
          style={{ marginTop: 18 }}
        >
          {compose.generating ? (
            <span className="spin" style={{ display: 'inline-flex' }}>
              <IconSparkles size={15} />
            </span>
          ) : (
            <IconSparkles size={15} />
          )}
          {compose.generating ? 'Generating…' : 'Generate'}
        </button>
      </div>

      <div className="panel panel-pad" style={{ minHeight: 360 }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <div className="eyebrow">Output</div>
          {compose.result !== '' ? (
            <span className="badge badge-info" data-testid="compose-source">
              <span className="dot" /> generated
            </span>
          ) : null}
        </div>
        {compose.generating ? (
          <div style={{ color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="spin" style={{ display: 'inline-flex', color: 'var(--iris2)' }}>
              <IconSparkles size={16} />
            </span>
            Drafting your release note…
          </div>
        ) : compose.result !== '' ? (
          <pre
            data-testid="compose-result"
            className="mono"
            style={{
              whiteSpace: 'pre-wrap',
              fontSize: 12.5,
              lineHeight: 1.6,
              color: 'var(--text)',
              margin: 0,
            }}
          >
            {compose.result}
          </pre>
        ) : (
          <div
            style={{
              color: 'var(--faint)',
              display: 'grid',
              placeItems: 'center',
              height: 280,
              textAlign: 'center',
            }}
          >
            <div>
              <IconSparkles size={28} />
              <div style={{ marginTop: 10, fontSize: 13 }}>Your generated note appears here.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
