/**
 * Real-Chromium checks for `isInViewport` — geometry from layout, not stubbed getBoundingClientRect.
 *
 * Loads the built browser SDK modules via a tiny static server + import map (see
 * test/fixtures/in-viewport.html). Proves the issue #398 scenario: below-the-fold content is
 * `visible` but not `inViewport` until scrollIntoView brings it into the clip region.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const ROOT = process.cwd();
const BROWSER_DIST = join(ROOT, 'packages/browser/dist');
const CORE_DIST = join(ROOT, 'packages/core/dist');

function sendFile(file: string, res: ServerResponse): void {
  const ext = extname(file);
  if (ext === '.js') res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  else if (ext === '.html') res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(readFileSync(file));
}

function staticHandler(reqUrl: string, res: ServerResponse): boolean {
  const url = reqUrl.split('?')[0] ?? '/';
  if (url === '/') {
    sendFile(join(ROOT, 'test/fixtures/in-viewport.html'), res);
    return true;
  }
  if (url === '/core/browser-shim.js') {
    sendFile(join(ROOT, 'test/fixtures/core-browser-shim.js'), res);
    return true;
  }
  if (url.startsWith('/browser/')) {
    const file = join(BROWSER_DIST, url.slice('/browser/'.length));
    if (!existsSync(file)) {
      res.statusCode = 404;
      res.end('not found');
      return true;
    }
    sendFile(file, res);
    return true;
  }
  if (url.startsWith('/core/')) {
    const file = join(CORE_DIST, url.slice('/core/'.length));
    if (!existsSync(file)) {
      res.statusCode = 404;
      res.end('not found');
      return true;
    }
    sendFile(file, res);
    return true;
  }
  return false;
}

let server: Server;
let baseUrl: string;
let browser: Browser;

beforeAll(async () => {
  if (!existsSync(join(BROWSER_DIST, 'dom/a11y.js')) || !existsSync(join(CORE_DIST, 'index.js'))) {
    throw new Error('build required: run pnpm build before pnpm test:integration');
  }
  server = createServer((req, res) => {
    if (!staticHandler(req.url ?? '/', res)) {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('server failed to bind'));
        return;
      }
      baseUrl = `http://127.0.0.1:${String(addr.port)}`;
      resolve();
    });
  });
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

async function openHarness(): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__reticleViewport !== undefined);
  return page;
}

describe('isInViewport (real Chromium layout)', () => {
  it('below-the-fold: visible but not inViewport until scrollIntoView', async () => {
    const page = await openHarness();

    const before = await page.evaluate(() => {
      const el = document.getElementById('below-fold');
      const vp = globalThis.__reticleViewport;
      const states = vp.getStates(el);
      return {
        inView: vp.isInViewport(el),
        hasVisible: states.includes(vp.ElementState.VISIBLE),
        hasInView: states.includes(vp.ElementState.IN_VIEWPORT),
      };
    });
    expect(before.inView).toBe(false);
    expect(before.hasVisible).toBe(true);
    expect(before.hasInView).toBe(false);

    const afterScroll = await page.evaluate(() => {
      const el = document.getElementById('below-fold');
      el?.scrollIntoView({ block: 'center', inline: 'center' });
      const vp = globalThis.__reticleViewport;
      const states = vp.getStates(el);
      return {
        inView: vp.isInViewport(el),
        hasInView: states.includes(vp.ElementState.IN_VIEWPORT),
      };
    });
    expect(afterScroll.inView).toBe(true);
    expect(afterScroll.hasInView).toBe(true);
    await page.close();
  });

  it('overflow:auto panel: row is out of view until the panel scrolls or scrollIntoView runs', async () => {
    const page = await openHarness();
    const out = await page.evaluate(() => {
      const el = document.getElementById('panel-row');
      const vp = globalThis.__reticleViewport;
      return vp.isInViewport(el);
    });
    expect(out).toBe(false);

    const scrolled = await page.evaluate(() => {
      const el = document.getElementById('panel-row');
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return globalThis.__reticleViewport.isInViewport(el);
    });
    expect(scrolled).toBe(true);
    await page.close();
  });

  it('overflow:hidden clips a child that extends past the clip box', async () => {
    const page = await openHarness();
    const clipped = await page.evaluate(() => {
      const el = document.getElementById('hidden-clip');
      const vp = globalThis.__reticleViewport;
      return {
        inView: vp.isInViewport(el),
        visible: vp.getStates(el).includes(vp.ElementState.VISIBLE),
      };
    });
    expect(clipped.visible).toBe(true);
    expect(clipped.inView).toBe(false);
    await page.close();
  });

  it('nested overflow:auto containers: deep row only inViewport after scrollIntoView', async () => {
    const page = await openHarness();
    const before = await page.evaluate(() => {
      const el = document.getElementById('nested-deep');
      const vp = globalThis.__reticleViewport;
      return vp.isInViewport(el);
    });
    expect(before).toBe(false);

    const after = await page.evaluate(() => {
      const el = document.getElementById('nested-deep');
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return globalThis.__reticleViewport.isInViewport(el);
    });
    expect(after).toBe(true);
    await page.close();
  });

  it('partially visible at the viewport edge still counts as inViewport', async () => {
    const page = await openHarness();
    await page.evaluate(() => {
      const el = document.createElement('button');
      el.id = 'edge';
      el.textContent = 'edge';
      el.style.position = 'fixed';
      el.style.left = '-15px';
      el.style.top = '10px';
      el.style.width = '40px';
      el.style.height = '30px';
      document.body.appendChild(el);
    });
    const edge = await page.evaluate(() =>
      globalThis.__reticleViewport.isInViewport(document.getElementById('edge')),
    );
    expect(edge).toBe(true);
    await page.close();
  });

  it('disconnected and zero-size elements are never inViewport', async () => {
    const page = await openHarness();
    const detached = await page.evaluate(() => {
      const vp = globalThis.__reticleViewport;
      const detached = document.createElement('button');
      const zero = document.createElement('button');
      zero.style.width = '0';
      zero.style.height = '0';
      zero.style.padding = '0';
      zero.style.border = 'none';
      document.body.appendChild(zero);
      return {
        detached: vp.isInViewport(detached),
        zero: vp.isInViewport(zero),
      };
    });
    expect(detached.detached).toBe(false);
    expect(detached.zero).toBe(false);
    await page.close();
  });
});

declare global {
  var __reticleViewport: {
    ElementState: {
      VISIBLE: string;
      IN_VIEWPORT: string;
    };
    isInViewport: (el: Element | null) => boolean;
    getStates: (el: Element | null) => string[];
  };
}
