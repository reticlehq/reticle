import { describe, expect, it, afterEach } from 'vitest';
import { sameOriginFrameBodies, observeSameOriginFrames } from './frames.js';
import { countClosedShadowRoots } from './blind-spots.js';
import { installShadowRegistry } from '../dom/shadow-registry.js';

/**
 * A frame's document is a separate node tree, so the top document's MutationObserver never saw it.
 * Symptom measured on a console with an embedded panel: the click landed, the panel updated, and the
 * observe window held zero DOM events — the exact shape of "the app ignored you".
 */
describe('same-origin frames', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('finds the body of a same-origin frame', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const bodies = sameOriginFrameBodies(document);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toBe(frame.contentDocument?.body);
  });

  it('finds nothing when there are no frames', () => {
    document.body.innerHTML = '<div><p>plain</p></div>';
    expect(sameOriginFrameBodies(document)).toHaveLength(0);
  });

  it('attaches to frames present at install', () => {
    document.body.appendChild(document.createElement('iframe'));
    const attached: HTMLElement[] = [];
    const stop = observeSameOriginFrames((body) => attached.push(body));
    expect(attached).toHaveLength(1);
    stop();
  });

  it('re-attaches when a frame loads, because a navigated frame is a NEW document', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const attached: HTMLElement[] = [];
    const stop = observeSameOriginFrames((body) => attached.push(body));
    expect(attached).toHaveLength(1);

    frame.dispatchEvent(new Event('load'));
    expect(attached).toHaveLength(2);

    // Torn down: a load after stop() must not re-attach.
    stop();
    frame.dispatchEvent(new Event('load'));
    expect(attached).toHaveLength(2);
  });
});

describe('closed shadow roots', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('declares a custom element that renders from a root nothing captured', () => {
    const host = document.createElement('atlas-badge');
    document.body.appendChild(host);
    host.attachShadow({ mode: 'closed' }).innerHTML = '<span>hidden</span>';
    // jsdom has no layout, so the size gate is stubbed to what a rendering engine would report.
    Object.defineProperty(host, 'offsetHeight', { value: 20, configurable: true });
    expect(countClosedShadowRoots()).toBe(1);
  });

  it('does NOT declare a root the registry captured — it is readable after all', () => {
    const stop = installShadowRegistry();
    const host = document.createElement('atlas-badge');
    document.body.appendChild(host);
    host.attachShadow({ mode: 'closed' }).innerHTML = '<span>hidden</span>';
    Object.defineProperty(host, 'offsetHeight', { value: 20, configurable: true });
    expect(countClosedShadowRoots()).toBe(0);
    stop();
  });

  it('does not declare an ordinary element, or a custom element that renders nothing', () => {
    document.body.innerHTML = '<div>plain</div><atlas-empty></atlas-empty>';
    expect(countClosedShadowRoots()).toBe(0);
  });
});
