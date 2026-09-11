import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { EventType } from '@reticlehq/core';
import { installDownload } from './download.js';

interface Captured {
  type: EventType;
  data: Record<string, unknown>;
}

/**
 * jsdom implements no object-URL API, so the real code path can only be exercised with a stand-in.
 * Deliberately a real-ish implementation (unique urls, a revoke) rather than a stub that returns a
 * constant — a shared url would let one blob's record answer for another's and hide a correlation bug.
 */
let urlSeq = 0;
const blobsByUrl = new Map<string, Blob>();
beforeAll(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (blob: Blob) => {
      urlSeq += 1;
      const url = `blob:test/${String(urlSeq)}`;
      blobsByUrl.set(url, blob);
      return url;
    },
  });
});

const teardowns: (() => void)[] = [];
afterEach(() => {
  for (const t of teardowns.splice(0)) t();
  document.body.innerHTML = '';
});

/** Let the detached blob read resolve — the report is deliberately async. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

function saveAs(text: string, type: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.setAttribute('download', filename);
  document.body.append(a);
  a.click();
}

/**
 * A file the app PRODUCES is the one artifact class no outside-the-browser tool can inspect: it never
 * crosses the network, and Playwright MCP has no tool that returns one.
 *
 * The defect this exists for, measured on a real merchant dashboard: one Export click produced a CSV
 * wrong three ways at once — 25 data rows in a file named `transactions-128-rows.csv`, an unquoted
 * `3 Aug, 10:00 pm` that shifts every column after it, and an `amount_inr` header over rows
 * denominated in USD — while the click reported a clean success and every other channel agreed. The
 * benchmark's ground truth records all three as missed by BOTH toolchains, for one reason: nobody
 * opened the file.
 */
describe('a file the app generates is observed before it reaches disk', () => {
  it('reports the filename, size and LINE COUNT of a generated CSV', async () => {
    const events: Captured[] = [];
    teardowns.push(installDownload((type, data) => events.push({ type, data })));

    saveAs('id,amount\n1,10\n2,20\n', 'text/csv', 'transactions-128-rows.csv');
    await settle();

    const download = events.find((e) => e.type === EventType.DOWNLOAD);
    expect(download).toBeDefined();
    expect(download?.data['filename']).toBe('transactions-128-rows.csv');
    expect(download?.data['mimeType']).toBe('text/csv');
    // The tell for "25 rows in a file the toast calls 128" — a COUNT, not customer data, so it is
    // reported whether or not preview capture is on.
    expect(download?.data['lines']).toBe(3);
    expect(download?.data['preview']).toBeUndefined();
  });

  it('includes the content only when preview capture is on', async () => {
    const events: Captured[] = [];
    teardowns.push(
      installDownload((type, data) => events.push({ type, data }), { capturePreview: true }),
    );

    saveAs('a,b\n1,"3 Aug, 10:00 pm"\n', 'text/csv', 'x.csv');
    await settle();

    const preview = events[0]?.data['preview'];
    expect(typeof preview).toBe('string');
    expect(preview as string).toContain('3 Aug, 10:00 pm');
  });

  it('reports a programmatic a.click() on an anchor never added to the document', async () => {
    // The common shape: build the anchor, click it, revoke. It never enters the DOM, so a document
    // listener alone would never see it.
    const events: Captured[] = [];
    teardowns.push(installDownload((type, data) => events.push({ type, data })));

    const url = URL.createObjectURL(new Blob(['x\n'], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.setAttribute('download', 'detached.csv');
    a.click();
    await settle();

    expect(events[0]?.data['filename']).toBe('detached.csv');
  });

  it('reports size and type for a BINARY blob without reading it', async () => {
    const events: Captured[] = [];
    teardowns.push(installDownload((type, data) => events.push({ type, data })));

    saveAs('....', 'application/pdf', 'invoice.pdf');
    await settle();

    expect(events[0]?.data['mimeType']).toBe('application/pdf');
    expect(events[0]?.data['bytes']).toBe(4);
    expect(events[0]?.data['lines']).toBeUndefined();
  });

  it('says nothing for an object URL that is never downloaded', async () => {
    // An <img> src or a preview blob is not a file the user received.
    const events: Captured[] = [];
    teardowns.push(installDownload((type, data) => events.push({ type, data })));

    URL.createObjectURL(new Blob(['not a download'], { type: 'text/plain' }));
    await settle();

    expect(events).toHaveLength(0);
  });

  it('restores the globals it patched on teardown', () => {
    // Read through descriptors: referencing a prototype method directly trips the unbound-method
    // rule, and the point here is identity, not invocation.
    const createOf = (): unknown => Object.getOwnPropertyDescriptor(URL, 'createObjectURL')?.value;
    const clickOf = (): unknown =>
      Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'click')?.value;
    const beforeCreate = createOf();
    const beforeClick = clickOf();

    const stop = installDownload(() => undefined);
    expect(createOf()).not.toBe(beforeCreate);
    stop();
    expect(createOf()).toBe(beforeCreate);
    expect(clickOf()).toBe(beforeClick);
  });
});
