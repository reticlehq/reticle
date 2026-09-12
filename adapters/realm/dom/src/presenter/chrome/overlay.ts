interface OverlayStats {
  connected: boolean;
  events: number;
}

export interface OverlayHandle {
  update: (stats: OverlayStats) => void;
  destroy: () => void;
}

const STYLE = [
  'position:fixed',
  'bottom:8px',
  'right:8px',
  'z-index:2147483647',
  'font:11px ui-monospace,SFMono-Regular,Menlo,monospace',
  'background:#151823',
  'color:#e6e9f0',
  'border:1px solid #2a2f3d',
  'border-radius:8px',
  'padding:6px 10px',
  'pointer-events:none',
  'opacity:0.85',
].join(';');

/** A tiny in-page status chip: connection + event count. Off by default. */
export function installOverlay(): OverlayHandle {
  const el = document.createElement('div');
  el.setAttribute('data-reticle-overlay', '');
  el.style.cssText = STYLE;
  el.textContent = 'Reticle: connecting…';
  document.body.appendChild(el);
  return {
    update: (stats) => {
      el.textContent = `Reticle ${stats.connected ? '●' : '○'} ${String(stats.events)} events`;
    },
    destroy: () => {
      el.remove();
    },
  };
}
