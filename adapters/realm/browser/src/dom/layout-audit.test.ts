/**
 * What a person sees wrong at a glance, measured: text cut mid-word, controls on top of each other,
 * text too faint for its background. jsdom lays nothing out, so each box is given its size here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LayoutDefect, auditLayout } from './layout-audit.js';
import { buildSnapshot } from './snapshot.js';

afterEach(() => {
  document.body.innerHTML = '';
});

const box = (el: Element, left: number, top: number, width: number, height: number): void => {
  el.getBoundingClientRect = () => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  });
};
const size = (el: Element, scroll: number, client: number): void => {
  Object.defineProperty(el, 'scrollWidth', { value: scroll });
  Object.defineProperty(el, 'clientWidth', { value: client });
};

describe('the layout audit', () => {
  it('finds text cut off with no ellipsis, and leaves a declared ellipsis alone', () => {
    document.body.innerHTML =
      '<p id="cut" style="overflow-x:hidden">A project name far too long for its card</p>' +
      '<p id="ok" style="overflow-x:hidden;text-overflow:ellipsis">Another long name</p>';
    for (const id of ['cut', 'ok']) {
      const el = document.getElementById(id) as HTMLElement;
      box(el, 0, 0, 100, 20);
      size(el, 240, 100);
    }
    const found = auditLayout();
    expect(found.map((f) => [f.kind, f.what])).toEqual([
      [LayoutDefect.CLIPPED, 'A project name far too long for its card'],
    ]);
    expect(found[0]?.detail).toMatch(/240px of text in a 100px box/);
  });

  it('finds two controls drawn over each other, but not a control inside another', () => {
    document.body.innerHTML =
      '<button id="a">Save</button><button id="b">Delete</button><a id="c" href="/x">Help</a>';
    box(document.getElementById('a') as Element, 0, 0, 80, 30);
    box(document.getElementById('b') as Element, 20, 5, 80, 30);
    box(document.getElementById('c') as Element, 300, 0, 40, 20);
    const overlap = auditLayout().filter((f) => LayoutDefect.OVERLAP === f.kind);
    expect(overlap).toHaveLength(1);
    expect(overlap[0]?.what).toBe('Save');
    expect(overlap[0]?.detail).toMatch(/drawn over "Delete"/);
  });

  it('finds body text under 4.5:1 on its own background, and passes text that clears it', () => {
    document.body.innerHTML =
      '<div style="background-color:rgb(255,255,255)"><span id="faint" style="color:rgb(200,200,200)">Last synced</span><span id="ink" style="color:rgb(20,20,20)">Synced</span></div>';
    for (const id of ['faint', 'ink']) box(document.getElementById(id) as Element, 0, 0, 60, 16);
    const contrast = auditLayout().filter((f) => LayoutDefect.CONTRAST === f.kind);
    expect(contrast.map((f) => f.what)).toEqual(['Last synced']);
    expect(contrast[0]?.detail).toMatch(/under 4\.5:1/);
  });

  it('carries what it measured, and passes over screen-reader-only text in a 1px box', () => {
    document.body.innerHTML =
      '<span id="sr" style="overflow-x:hidden">Skip to content</span><p id="cut" style="overflow-x:hidden">Cut</p>';
    const sr = document.getElementById('sr') as Element;
    box(sr, 0, 0, 1, 1);
    size(sr, 90, 1);
    const cut = document.getElementById('cut') as Element;
    box(cut, 0, 0, 100, 20);
    size(cut, 240, 100);
    expect(auditLayout().map((f) => [f.what, f.value, f.bound])).toEqual([['Cut', 240, 100]]);
  });

  it('passes over a skip link hidden by clip, whatever its padding makes its box', () => {
    document.body.innerHTML =
      '<a id="skip" href="#main" style="overflow-x:hidden;clip:rect(0px, 0px, 0px, 0px)">Skip to content</a>';
    const skip = document.getElementById('skip') as Element;
    box(skip, 0, 0, 25, 17);
    size(skip, 117, 24);
    expect(auditLayout()).toEqual([]);
  });

  it('passes over an overlap nobody sees: where they meet, something else is drawn', () => {
    document.body.innerHTML =
      '<div id="pane" style="overflow:hidden"><button id="node">A node</button></div><button id="chip">Flows</button>';
    const node = document.getElementById('node') as Element;
    const chip = document.getElementById('chip') as Element;
    box(node, 0, 0, 80, 30);
    box(chip, 0, 0, 80, 30);
    const pane = document.getElementById('pane') as Element;
    document.elementFromPoint = () => pane;
    expect(auditLayout()).toEqual([]);
    // The chip drawn everywhere: the node is clipped away entirely, so nothing a person sees overlaps.
    document.elementFromPoint = () => chip;
    expect(auditLayout()).toEqual([]);
    // Each seen somewhere (the chip over the node's middle, the node at its corners): a real overlap.
    document.elementFromPoint = (x, y) => (40 === x && 15 === y ? chip : node);
    expect(auditLayout().map((f) => f.kind)).toEqual([LayoutDefect.OVERLAP]);
    Reflect.deleteProperty(document, 'elementFromPoint');
  });

  it('rides on a snapshot only when asked', () => {
    document.body.innerHTML = '<button>Go</button>';
    expect(buildSnapshot({ mode: 'interactive' }).audit).toBeUndefined();
    expect(buildSnapshot({ mode: 'interactive', audit: true }).audit).toEqual([]);
  });
});
