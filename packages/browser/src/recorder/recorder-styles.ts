/**
 * Inline style strings for the floating recorder toolbar. Browser-local UI
 * text (never crosses the wire), split out of recorder.ts to keep that file under the 500-line cap
 * (mirrors how presenter.ts extracts presenter-log.ts). All toolbar nodes also carry
 * data-iris-overlay, so they are snapshot-excluded via dom-ignore.ts regardless of these styles.
 */

export const TOOLBAR_CSS = [
  'position:fixed',
  'top:8px',
  'left:50%',
  'transform:translateX(-50%)',
  'z-index:2147483647',
  'display:flex',
  'gap:6px',
  'align-items:center',
  'flex-wrap:wrap',
  'max-width:90vw',
  'font:12px ui-sans-serif,system-ui,sans-serif',
  'background:#151823',
  'color:#e6e9f0',
  'border:1px solid #2a2f3d',
  'border-radius:10px',
  'padding:6px 10px',
  'box-shadow:0 8px 30px rgba(0,0,0,.5)',
].join(';');

export const BTN_CSS = [
  'font:inherit',
  'cursor:pointer',
  'background:#262b3a',
  'color:#e6e9f0',
  'border:1px solid #3a4151',
  'border-radius:7px',
  'padding:3px 9px',
].join(';');

export const NAME_CSS = [
  'font:inherit',
  'background:#0e1018',
  'color:#e6e9f0',
  'border:1px solid #3a4151',
  'border-radius:7px',
  'padding:3px 8px',
].join(';');

export const STATUS_CSS = ['opacity:.75', 'margin-left:4px'].join(';');
export const MENU_CSS = ['display:flex', 'gap:6px', 'align-items:center', 'flex-wrap:wrap'].join(
  ';',
);
