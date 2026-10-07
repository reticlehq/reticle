import { afterEach, describe, expect, it } from 'vitest';
import { HEAD_READ_MAX_TAGS, REDACTED_VALUE } from '@reticlehq/core';
import { HEAD_VALUE_MAX_CHARS, readHead } from './head-read.js';

/**
 * The HEAD_READ command (#1425): what is in the live `<head>`, read when asked rather than at load,
 * with credentials redacted before anything crosses the bridge.
 */
function addToHead(html: string): void {
  document.head.insertAdjacentHTML('beforeend', html);
}

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('readHead', () => {
  it('reads each link by rel and href, as the page wrote them', () => {
    addToHead('<link rel="icon" href="/icon.svg"><link rel="canonical" href="https://app.test/a">');
    expect(readHead().links).toEqual([
      { rel: 'icon', href: '/icon.svg' },
      { rel: 'canonical', href: 'https://app.test/a' },
    ]);
  });

  it('reads each meta by name or property, and leaves out the ones that have neither', () => {
    addToHead(
      '<meta charset="utf-8"><meta name="description" content="Plan your week">' +
        '<meta property="og:image" content="/card.png"><meta http-equiv="refresh" content="30">',
    );
    expect(readHead().metas).toEqual([
      { name: 'description', content: 'Plan your week' },
      { property: 'og:image', content: '/card.png' },
    ]);
  });

  it('sees a tag a head manager adds after load', () => {
    expect(readHead().metas).toEqual([]);
    addToHead('<meta name="description" content="Set later">');
    expect(readHead().metas).toEqual([{ name: 'description', content: 'Set later' }]);
  });

  it('reads only the head: a meta rendered into the body is not one', () => {
    document.body.innerHTML = '<meta name="description" content="In the body">';
    expect(readHead().metas).toEqual([]);
  });

  it('redacts a meta whose name is a credential, such as a CSRF token', () => {
    addToHead(
      '<meta name="csrf-token" content="s3cr3t-rails"><meta name="_csrf" content="s3cr3t-spring">',
    );
    expect(readHead().metas).toEqual([
      { name: 'csrf-token', content: REDACTED_VALUE, altered: true },
      { name: '_csrf', content: REDACTED_VALUE, altered: true },
    ]);
  });

  it('redacts a credential carried in an href, and marks the href as altered', () => {
    addToHead('<link rel="preload" href="https://cdn.test/a.js?access_token=abc123secretvalue">');
    const [link] = readHead().links;
    expect(link?.href).not.toContain('abc123secretvalue');
    expect(link?.href).toContain('https://cdn.test/a.js');
    expect(link?.altered).toBe(true);
  });

  it('redacts a meta when EITHER name or property is a credential', () => {
    addToHead('<meta name="description" property="csrf" content="opaque-token-value">');
    const [meta] = readHead().metas;
    expect(meta?.content).toBe(REDACTED_VALUE);
    expect(meta?.altered).toBe(true);
  });

  it('caps a long value well under the transport limit, and marks it altered', () => {
    const long = 'x'.repeat(HEAD_VALUE_MAX_CHARS + 50);
    addToHead(`<meta name="description" content="${long}">`);
    const [meta] = readHead().metas;
    expect(meta?.content).toHaveLength(HEAD_VALUE_MAX_CHARS);
    expect(meta?.altered).toBe(true);
  });

  it('does not mark a value it reported exactly as the page wrote it', () => {
    addToHead('<link rel="icon" href="/icon.svg"><meta name="description" content="Plan">');
    const head = readHead();
    expect(head.links[0]?.altered).toBeUndefined();
    expect(head.metas[0]?.altered).toBeUndefined();
  });

  it(`stops at ${String(HEAD_READ_MAX_TAGS)} tags and says the answer is incomplete`, () => {
    addToHead('<meta name="k" content="v">'.repeat(HEAD_READ_MAX_TAGS + 5));
    const head = readHead();
    expect(head.links.length + head.metas.length).toBe(HEAD_READ_MAX_TAGS);
    expect(head.truncated).toBe(true);
  });

  it('does not claim truncation when everything fit', () => {
    addToHead('<link rel="icon" href="/icon.svg">');
    expect(readHead().truncated).toBeUndefined();
  });
});
