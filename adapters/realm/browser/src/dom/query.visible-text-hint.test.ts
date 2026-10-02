import { describe, it, expect, beforeEach } from 'vitest';
import { runQuery } from './query.js';
import { refs } from './addressing/refs.js';

/**
 * The `splitText` hint tells an agent "that text IS on the page, split across children — retry
 * scoped, with self:true". Four independent field reports had it fire for text NOBODY could see:
 * a string left behind in a server-render payload after the component unmounted, a price that was
 * simply absent, Reticle's own HUD labels, and a suggested retry that then answered `yes` for
 * unrelated text. The last one is not bad advice, it is a false green — the retry and the hint read
 * the same `textContent`, so they agree with each other and disagree with the page.
 *
 * The rule under test: the hint may claim presence only from text a user can actually SEE, and the
 * retry it suggests must be decided by that same rule. When nothing qualifies, saying nothing is
 * the correct answer.
 */
describe('splitText hint only speaks for visible text', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('stays silent when the string survives only in a server-render script payload', () => {
    // The receipt unmounted; the flight payload still carries the old string. Report: this would
    // have hidden a destroyed purchase receipt.
    document.body.innerHTML =
      '<div id="app"></div>' +
      '<script id="payload" type="application/json">{"receipt":"Order #4021 confirmed"}</script>';
    const r = runQuery({ text: 'Order #4021 confirmed' });
    expect(r.elements).toHaveLength(0);
    expect(r.hint?.splitText).toBeUndefined();
  });

  it('stays silent for a price that is genuinely absent from the rendered page', () => {
    // Split across children in every case, so nothing matches by an element's OWN text and the
    // hint is the only thing that could answer. None of these three is on screen.
    document.body.innerHTML =
      '<div hidden><span>Total </span><span>$19.99</span></div>' +
      '<div aria-hidden="true"><span>Total </span><span>$19.99</span></div>' +
      '<div style="display: none"><span>Total </span><span>$19.99</span></div>';
    const r = runQuery({ text: 'Total $19.99' });
    expect(r.elements).toHaveLength(0);
    expect(r.hint?.splitText).toBeUndefined();
  });

  it('never points at text that belongs to Reticle’s own HUD', () => {
    // isIgnored() excludes the HUD and its descendants, but <body> is its ANCESTOR - and body's
    // textContent carries the HUD's labels, so the hint offered our own chrome as the app's text.
    document.body.innerHTML =
      '<main><p>Nothing relevant here</p></main>' +
      '<div data-reticle-hud><button>Pause</button><button>Export</button></div>';
    const r = runQuery({ text: 'Pause' });
    expect(r.elements).toHaveLength(0);
    expect(r.hint?.splitText).toBeUndefined();
  });

  it('the suggested self:true retry cannot answer yes for text only a script payload carries', () => {
    document.body.innerHTML =
      '<div id="root"><p>Cart is empty</p>' +
      '<script type="application/json">{"line":"Order #4021 confirmed"}</script></div>';
    const root = document.getElementById('root');
    expect(root).not.toBeNull();
    const ref = refs.refFor(root as HTMLElement);
    const retry = runQuery({ scope: ref, self: true, text: 'Order #4021 confirmed' });
    expect(retry.elements).toHaveLength(0);
  });

  it('still names the container when the split text is really on screen', () => {
    document.body.innerHTML = '<div id="row"><span>Move to </span><span>Repro Folder</span></div>';
    const r = runQuery({ text: 'Move to Repro Folder' });
    expect(r.hint?.splitText?.ref).toBeDefined();
  });
});
