import { Z_OVERLAY } from '../presenter/presenter-styles.js';

/** Markup + CSS for the in-page annotation HUD (markers, hover box, composer). */
const MARK_ATTR = 'data-reticle-mark';
const sel = (role: string): string => `[${MARK_ATTR}="${role}"]`;

export const MARK_PLACEHOLDER = 'What should change?';
export const MARK_SUBMIT = 'Add';
export const MARK_CANCEL = 'Cancel';
export const MARK_PENDING_GLYPH = '+';

/**
 * ABOVE the presenter overlay, because the overlay contains the page blocker annotate mode raises.
 * One below it, the shield painted over the composer: every click on Cancel or Add landed on the
 * blocker instead of the button, so the note could be neither saved nor dismissed. The root here is
 * pointer-events:none, so only the marks and the composer sit above the HUD - not a new shield.
 */
const Z_MARK = Z_OVERLAY + 1;

export const ANNOTATOR_CSS = `
${sel('root')}{position:fixed;inset:0;pointer-events:none;z-index:${String(Z_MARK)};}
${sel('root')}[data-hide="1"] ${sel('pin')}{display:none;}
html[data-reticle-mark-active] *{cursor:crosshair !important;}
html[data-reticle-mark-active] [data-reticle-overlay],
html[data-reticle-mark-active] [data-reticle-overlay] *,
html[data-reticle-mark-active] ${sel('pop')},
html[data-reticle-mark-active] ${sel('pop')} *,
html[data-reticle-mark-active] ${sel('pin')},
html[data-reticle-mark-active] ${sel('pending')}{cursor:pointer !important;}
${sel('hi')}{position:fixed;pointer-events:none;opacity:0;box-sizing:border-box;
  border:2px solid color-mix(in srgb, var(--reticle-mark-accent, #0088ff) 50%, transparent);
  border-radius:4px;background:color-mix(in srgb, var(--reticle-mark-accent, #0088ff) 4%, transparent);}
${sel('hi')}[data-on="1"]{opacity:1;animation:reticle-mark-hi-in .12s ease-out;}
${sel('hilabel')}{position:absolute;top:-28px;left:0;font:500 11px/1.2 system-ui,sans-serif;color:#fff;
  background:rgba(0,0,0,.85);padding:.35rem .6rem;border-radius:.375rem;white-space:nowrap;
  max-width:280px;overflow:hidden;text-overflow:ellipsis;pointer-events:none;}
${sel('sel')}{position:fixed;pointer-events:none;box-sizing:border-box;border-radius:4px;
  border:2px solid color-mix(in srgb, var(--reticle-mark-accent, #0088ff) 60%, transparent);
  background:color-mix(in srgb, var(--reticle-mark-accent, #0088ff) 5%, transparent);}
${sel('pin')},${sel('pending')}{position:fixed;pointer-events:auto;width:22px;height:22px;
  margin:0;border:none;border-radius:50%;background:var(--reticle-mark-accent, #0088ff);color:#fff;
  font:600 11px/22px system-ui,sans-serif;text-align:center;cursor:pointer;
  box-shadow:0 2px 6px rgba(0,0,0,.2),inset 0 0 0 1px rgba(0,0,0,.04);
  transform:translate(-50%,-50%);user-select:none;z-index:1;}
${sel('pin')}:hover{transform:translate(-50%,-50%) scale(1.1);z-index:2;}
${sel('pin')}[data-stale="1"]{opacity:.45;}
${sel('pending')}{cursor:default;}
${sel('tip')}{position:absolute;top:calc(100% + 10px);left:50%;transform:translateX(-50%) scale(.909);
  background:#1a1a1a;color:#fff;padding:8px 12px;border-radius:12px;min-width:120px;max-width:200px;
  box-shadow:0 4px 20px rgba(0,0,0,.3),0 0 0 1px rgba(255,255,255,.08);pointer-events:none;text-align:left;
  font:400 13px/1.4 system-ui,sans-serif;display:none;z-index:3;}
${sel('pin')}:hover ${sel('tip')}{display:block;}
${sel('tipq')}{display:block;font-size:12px;font-style:italic;color:rgba(255,255,255,.6);
  margin-bottom:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
${sel('tipn')}{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
${sel('pop')}{position:fixed;pointer-events:auto;width:280px;box-sizing:border-box;padding:12px 16px 14px;
  background:#1a1a1a;border-radius:16px;color:#fff;z-index:${String(Z_MARK + 8)};
  box-shadow:0 4px 24px rgba(0,0,0,.3),0 0 0 1px rgba(255,255,255,.08);
  font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;transform:translateX(-50%);opacity:0;}
${sel('pop')}[data-in="1"]{opacity:1;animation:reticle-mark-pop-in .2s cubic-bezier(.34,1.56,.64,1) forwards;}
${sel('pop')}.reticle-mark-shake{animation:reticle-mark-shake .25s ease-out;}
${sel('pop')} .reticle-mark-where{font-size:12px;font-weight:400;color:rgba(255,255,255,.5);
  margin-bottom:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
${sel('pop')} textarea{box-sizing:border-box;width:100%;min-height:52px;resize:none;padding:8px 10px;
  font:13px/1.45 inherit;background:rgba(255,255,255,.05);color:#fff;
  border:1px solid rgba(255,255,255,.15);border-radius:8px;outline:none;}
${sel('pop')} textarea:focus{border-color:var(--reticle-mark-accent, #0088ff);}
${sel('pop')} textarea::placeholder{color:rgba(255,255,255,.35);}
${sel('pop')} .reticle-mark-row{display:flex;justify-content:flex-end;gap:6px;margin-top:8px;}
${sel('pop')} button{font:500 12px/1 system-ui,sans-serif;padding:.4rem .875rem;border-radius:1rem;
  border:none;cursor:pointer;background:transparent;color:rgba(255,255,255,.5);}
${sel('pop')} button:hover{background:rgba(255,255,255,.1);color:rgba(255,255,255,.8);}
${sel('pop')} button[data-send]{background:var(--reticle-mark-accent, #0088ff);color:#fff;}
${sel('pop')} button[data-send]:disabled{opacity:.4;cursor:not-allowed;}
@keyframes reticle-mark-hi-in{from{opacity:0;transform:scale(.98)}to{opacity:1;transform:scale(1)}}
@keyframes reticle-mark-pop-in{from{opacity:0;transform:translateX(-50%) scale(.95) translateY(4px)}
  to{opacity:1;transform:translateX(-50%) scale(1) translateY(0)}}
@keyframes reticle-mark-shake{
  0%,100%{transform:translateX(-50%)}
  20%{transform:translateX(calc(-50% - 3px))}
  40%{transform:translateX(calc(-50% + 3px))}
  60%{transform:translateX(calc(-50% - 2px))}
  80%{transform:translateX(calc(-50% + 2px))}}
`;

export const ANNOTATOR_ROOT_HTML = `<div ${MARK_ATTR}="hi"><span ${MARK_ATTR}="hilabel"></span></div><div ${MARK_ATTR}="sel" hidden></div>`;
