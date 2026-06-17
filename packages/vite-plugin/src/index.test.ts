import { describe, it, expect } from 'vitest';
import { SOURCE_ATTR } from '@syrin/iris-babel-plugin';
import { IRIS_DEFAULT_PORT } from '@syrin/iris-protocol';
import { iris, IRIS_VITE_PLUGIN_NAME } from './index.js';

describe('iris vite plugin', () => {
  it('only applies during serve (never ships to production builds)', () => {
    const plugin = iris();
    expect(plugin.name).toBe(IRIS_VITE_PLUGIN_NAME);
    expect(plugin.apply).toBe('serve');
    expect(plugin.enforce).toBe('pre');
  });

  it('stamps data-iris-source on host elements in .tsx files', () => {
    const plugin = iris();
    const result = plugin.transform?.('const x = <button>Hi</button>;', '/app/src/Foo.tsx');
    expect(result).not.toBeNull();
    expect(result?.code).toContain(SOURCE_ATTR);
  });

  it('skips non-jsx and node_modules and virtual ids', () => {
    const plugin = iris();
    expect(plugin.transform?.('const x = 1;', '/app/src/util.ts')).toBeNull();
    expect(plugin.transform?.('const x = <a/>;', '/app/node_modules/pkg/Foo.tsx')).toBeNull();
    expect(plugin.transform?.('const x = <a/>;', '\0virtual:foo.tsx')).toBeNull();
  });

  it('disables stamping when sourceMapping is false', () => {
    const plugin = iris({ sourceMapping: false });
    expect(plugin.transform?.('const x = <button>Hi</button>;', '/app/src/Foo.tsx')).toBeNull();
  });

  it('injects a dev-gated connect() module importing @syrin/iris', () => {
    const plugin = iris();
    const tags = plugin.transformIndexHtml?.('<html></html>');
    expect(tags).toHaveLength(1);
    const tag = tags?.[0];
    expect(tag?.tag).toBe('script');
    expect(tag?.attrs?.['type']).toBe('module');
    expect(tag?.children).toContain("from '@syrin/iris'");
    expect(tag?.children).toContain('iris.connect(');
    expect(tag?.children).toContain('install()');
  });

  it('does not inject connect() when inject is false', () => {
    const plugin = iris({ inject: false });
    expect(plugin.transformIndexHtml?.('<html></html>')).toEqual([]);
  });

  it('bakes a non-default port into the injected connect() url', () => {
    const customPort = IRIS_DEFAULT_PORT + 1;
    const tags = iris({ port: customPort }).transformIndexHtml?.('<html></html>');
    expect(tags?.[0]?.children).toContain(String(customPort));
    expect(tags?.[0]?.children).toContain('ws://localhost:');
  });

  it('omits the url for the default port (SDK default applies)', () => {
    const tags = iris().transformIndexHtml?.('<html></html>');
    expect(tags?.[0]?.children).not.toContain('ws://localhost:');
  });

  it('forwards session and token when provided', () => {
    const tags = iris({ session: 'my-app', token: 'secret' }).transformIndexHtml?.('<html></html>');
    expect(tags?.[0]?.children).toContain('my-app');
    expect(tags?.[0]?.children).toContain('secret');
  });
});
