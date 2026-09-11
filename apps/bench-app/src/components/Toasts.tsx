import { useApp, type Toast } from '../store/store.js';
import { IconBolt, IconCheck, IconX } from './icons.js';

const TONE: Record<
  Toast['tone'],
  { color: string; icon: (p: { size?: number }) => React.ReactElement }
> = {
  success: { color: 'var(--success)', icon: IconCheck },
  danger: { color: 'var(--danger)', icon: IconX },
  info: { color: 'var(--info)', icon: IconBolt },
};

export function Toasts(): React.ReactElement {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((t) => {
        const { color, icon: Ico } = TONE[t.tone];
        return (
          <div key={t.id} className="toast" data-testid="toast" style={{ position: 'relative' }}>
            <span className="toast-bar" style={{ background: color }} />
            <span style={{ color, display: 'grid', placeItems: 'center' }}>
              <Ico size={16} />
            </span>
            <div style={{ lineHeight: 1.3 }}>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t.title}</div>
              {t.detail !== undefined ? (
                <div className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                  {t.detail}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              style={{
                marginLeft: 8,
                background: 'none',
                border: 'none',
                color: 'var(--faint)',
                cursor: 'pointer',
              }}
            >
              <IconX size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
