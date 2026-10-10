import { describe, it, expect, beforeEach } from 'vitest';
import { ElementState } from '@reticlehq/core';
import { matchQuery, runQuery } from './query.js';
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

  it('reads visible descendants overflowing back from a clipped container', () => {
    document.body.innerHTML =
      '<div id="clip" style="overflow-x:hidden;overflow-y:hidden"><div id="row">Hidden own text' +
      '<span>Move to </span><span>Repro Folder</span></div></div>';
    const clip = document.getElementById('clip');
    const row = document.getElementById('row');
    expect(clip).not.toBeNull();
    expect(row).not.toBeNull();
    if (null === clip || null === row) return;
    clip.getBoundingClientRect = () => new DOMRect(0, 0, 200, 100);
    row.getBoundingClientRect = () => new DOMRect(240, 0, 180, 20);
    for (const span of row.children) {
      span.getBoundingClientRect = () => new DOMRect(0, 0, 100, 20);
    }
    const hint = runQuery({ text: 'Move to Repro Folder' }).hint?.splitText;
    expect(hint?.ref).toBe(refs.refFor(row));
    expect(runQuery({ scope: '#row', self: true, text: 'Move to Repro Folder' }).count).toBe(1);
    expect(runQuery({ scope: '#row', self: true, text: 'Hidden own text' }).count).toBe(0);
  });

  it.each(['auto', 'scroll'])(
    'keeps the splitText hint and scoped retry below an overflow:%s scrollport',
    (overflow) => {
      document.body.innerHTML =
        `<div id="port" style="overflow-x:${overflow};overflow-y:${overflow}">` +
        '<div id="row"><span>Move to </span><span>Repro Folder</span></div></div>';
      const port = document.getElementById('port') as HTMLElement;
      const row = document.getElementById('row') as HTMLElement;
      port.getBoundingClientRect = () => new DOMRect(0, 0, 200, 100);
      row.getBoundingClientRect = () => new DOMRect(0, 200, 180, 20);
      for (const span of row.children) {
        span.getBoundingClientRect = () => new DOMRect(0, 200, 100, 20);
      }
      expect(runQuery({ text: 'Move to Repro Folder' }).hint?.splitText?.ref).toBe(
        refs.refFor(row),
      );
      expect(runQuery({ scope: '#row', self: true, text: 'Move to Repro Folder' }).count).toBe(1);
    },
  );

  it('still names the container when the split text is really on screen', () => {
    document.body.innerHTML = '<div id="row"><span>Move to </span><span>Repro Folder</span></div>';
    const r = runQuery({ text: 'Move to Repro Folder' });
    expect(r.hint?.splitText?.ref).toBeDefined();
  });
});

describe('ariaHiddenMatch hint names the accessibility exclusion (#1070)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('reports when a text search misses and the string is inside an aria-hidden subtree', () => {
    document.body.innerHTML =
      '<div aria-hidden="true"><span>Order </span><span>confirmed</span></div>';
    const r = runQuery({ text: 'Order confirmed' });
    expect(r.elements).toHaveLength(0);
    expect(r.hint?.ariaHiddenMatch).toBe(true);
  });

  it('stays silent when the text is hidden by CSS, not just aria-hidden', () => {
    document.body.innerHTML =
      '<div style="display: none" aria-hidden="true"><span>Order </span><span>confirmed</span></div>';
    const r = runQuery({ text: 'Order confirmed' });
    expect(r.elements).toHaveLength(0);
    expect(r.hint?.ariaHiddenMatch).toBeUndefined();
  });

  it('stays silent when the text is genuinely absent', () => {
    document.body.innerHTML = '<div><span>Nothing here</span></div>';
    const r = runQuery({ text: 'Order confirmed' });
    expect(r.elements).toHaveLength(0);
    expect(r.hint?.ariaHiddenMatch).toBeUndefined();
  });

  it('stays silent when a visible non-aria-hidden element also has the text (#1070)', () => {
    document.body.innerHTML =
      '<button style="position:absolute;top:9999px">Order confirmed</button>' +
      '<div aria-hidden="true"><span>Order confirmed</span></div>';
    const r = matchQuery({ text: 'Order confirmed' }, ElementState.IN_VIEWPORT);
    expect(r.count).toBe(0);
    expect(r.hint?.ariaHiddenMatch).toBeUndefined();
  });

  it('skips the scan on interim polls (diagnose=false)', () => {
    document.body.innerHTML =
      '<div aria-hidden="true"><span>Order </span><span>confirmed</span></div>';
    const interim = matchQuery({ text: 'Order confirmed' }, undefined, undefined, false);
    expect(interim.hint?.ariaHiddenMatch).toBeUndefined();
    const final = matchQuery({ text: 'Order confirmed' }, undefined, undefined, true);
    expect(final.hint?.ariaHiddenMatch).toBe(true);
  });
});
