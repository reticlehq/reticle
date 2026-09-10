import { EventType } from '@reticlehq/core';
import { captureMethod } from '../patching/capture-method.js';
import { projectBody } from './network-body.js';
import type { Emit, Teardown } from './types.js';

/**
 * Files the app PRODUCES — the one artifact class an outside-the-browser tool cannot inspect.
 *
 * A generated export never crosses the network: the app builds a Blob, hands it to
 * `URL.createObjectURL`, and clicks an anchor. There is no request to intercept, and Playwright MCP
 * has no tool that returns a downloaded file at all. Reticle runs inside the page, where the Blob is
 * constructed, so the export is observable before it reaches the disk.
 *
 * Measured on a real merchant dashboard: one Export click produced a CSV wrong three ways at once —
 * 25 data rows in a file named `transactions-128-rows.csv`, an unquoted `3 Aug, 10:00 pm` that
 * shifts every column after it, and an `amount_inr` header over rows denominated in USD — while the
 * click itself reported a clean success and every other channel agreed. The benchmark's ground truth
 * records those three as missed by BOTH toolchains, for the same reason: nobody opened the file.
 */

/** Text-like types worth counting lines in and previewing. Anything else reports type + size only. */
const TEXTUAL = /text\/|json|csv|xml|ndjson|javascript/i;

/** Lines are reported for text files; the preview is capped and redacted by projectBody. */
const PREVIEW_CHARS = 2000;

interface PendingBlob {
  type: string;
  size: number;
  /**
   * Resolves with the file's text, or undefined for a binary type.
   *
   * A PROMISE rather than a value, because the ordering is against us: `blob.text()` is async and the
   * anchor click that carries the FILENAME fires immediately after `createObjectURL`. Reading a
   * settled value at click time therefore always found nothing, and the first version reported every
   * export with `lines: undefined` — the filename without the contents, which is exactly half of what
   * makes "25 rows in a file called 128-rows" visible.
   */
  text: Promise<string | undefined>;
}

interface DownloadOptions {
  /** Include a content preview. Gated for the same reason request bodies are: exports hold PII. */
  capturePreview?: boolean;
}

export function installDownload(emit: Emit, opts: DownloadOptions = {}): Teardown {
  // jsdom does not implement `createObjectURL`, and plenty of users run this SDK under jsdom in their
  // own test suite. Reaching for `.bind` on an absent function threw during `connect()` — an
  // observability layer taking the host app down with it, which is the one failure mode it may never
  // have. No object URLs means no generated files to observe, so this simply stands down.
  if (typeof URL.createObjectURL !== 'function') return () => undefined;
  const objectUrl = URL.createObjectURL.bind(URL);
  const known = new Map<string, PendingBlob>();

  /**
   * `createObjectURL` is where the file becomes real. The filename is NOT here — it lives on the
   * anchor that gets clicked — so the blob is remembered against its URL and reported when either
   * the anchor fires or, failing that, on a microtask so a download that is never clicked (a
   * generated preview, an <img> src) is still visible.
   */
  const originalCreate = captureMethod(URL, 'createObjectURL');
  URL.createObjectURL = function reticleObservedObjectUrl(obj: Blob | MediaSource): string {
    const url = objectUrl(obj);
    if (typeof Blob !== 'undefined' && obj instanceof Blob) {
      // Started here, awaited at report time — never blocking the app's own download path.
      const text = TEXTUAL.test(obj.type)
        ? obj.text().catch(() => undefined)
        : Promise.resolve(undefined);
      known.set(url, { type: obj.type, size: obj.size, text });
    }
    return url;
  };

  const report = (url: string, filename?: string): void => {
    const record = known.get(url);
    if (record === undefined) return;
    known.delete(url);
    void record.text.then((text) => {
      emitDownload(record, filename, text);
    });
  };

  const emitDownload = (record: PendingBlob, filename?: string, text?: string): void => {
    const data: Record<string, unknown> = { mimeType: record.type, bytes: record.size };
    if (filename !== undefined && filename.length > 0) data['filename'] = filename;
    if (text !== undefined) {
      // The LINE COUNT is reported even without preview capture: it is a number, not content, and it
      // is the whole tell for "25 rows in a file the toast calls 128".
      data['lines'] = text.split('\n').filter((l) => l.length > 0).length;
      if (true === opts.capturePreview) {
        const { body, truncated } = projectBody(text.slice(0, PREVIEW_CHARS), record.type);
        data['preview'] = body;
        if (truncated) data['previewTruncated'] = true;
      }
    }
    emit(EventType.DOWNLOAD, data);
  };

  /**
   * An anchor click carries the NAME. Captured at the document level so it sees the click whether the
   * app dispatches it programmatically or a human does, and whether or not the anchor is in the DOM.
   */
  const onClick = (event: Event): void => {
    const target = event.target;
    const anchor =
      target instanceof Element ? target.closest<HTMLAnchorElement>('a[download]') : null;
    if (null === anchor) return;
    report(anchor.getAttribute('href') ?? '', anchor.getAttribute('download') ?? undefined);
  };
  document.addEventListener('click', onClick, true);

  // A programmatic `a.click()` on an anchor never inserted into the document dispatches no bubbling
  // event this listener can see, so the anchor path is patched too.
  const originalClick = captureMethod(HTMLAnchorElement.prototype, 'click');
  HTMLAnchorElement.prototype.click = function reticleObservedAnchorClick(this: HTMLAnchorElement) {
    if (this.hasAttribute('download')) {
      report(this.getAttribute('href') ?? '', this.getAttribute('download') ?? undefined);
    }
    originalClick.call(this);
  };

  return () => {
    // A REAL restore, so teardown leaves the page exactly as it was found.
    document.removeEventListener('click', onClick, true);
    URL.createObjectURL = originalCreate;
    HTMLAnchorElement.prototype.click = originalClick;
    known.clear();
  };
}
