import { describe, it, expect } from 'vitest';
import { SOURCE_ATTR } from '@syrin/iris-babel-plugin';
import { IRIS_DEFAULT_PORT } from '@syrin/iris-protocol';
import { iris, IRIS_VITE_PLUGIN_NAME, IRIS_CONNECT_MODULE } from './index.js';

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

  it('injects a script that references the connect module by src (not an inline import)', () => {
    // Regression: an inline injected <script> with a bare import is NOT run through Vite import
    // resolution, so it must be served as a real module via src.
    const plugin = iris();
    const tags = plugin.transformIndexHtml?.('<html></html>');
    expect(tags).toHaveLength(1);
    const tag = tags?.[0];
    expect(tag?.tag).toBe('script');
    expect(tag?.attrs?.['type']).toBe('module');
    expect(tag?.attrs?.['src']).toBe(IRIS_CONNECT_MODULE);
  });

  it('serves the connect module via resolveId + load with a real @syrin/iris import', () => {
    const plugin = iris();
    expect(plugin.resolveId?.(IRIS_CONNECT_MODULE)).toBe(IRIS_CONNECT_MODULE);
    expect(plugin.resolveId?.('some/other/id')).toBeNull();
    const code = plugin.load?.(IRIS_CONNECT_MODULE);
    expect(code).toContain("from '@syrin/iris'");
    expect(code).toContain('install()');
    expect(code).toContain('iris.connect(');
  });

  it('does not inject or serve the module when inject is false', () => {
    const plugin = iris({ inject: false });
    expect(plugin.transformIndexHtml?.('<html></html>')).toEqual([]);
    expect(plugin.resolveId?.(IRIS_CONNECT_MODULE)).toBeNull();
    expect(plugin.load?.(IRIS_CONNECT_MODULE)).toBeNull();
  });

  it('bakes a non-default port into the connect module url', () => {
    const customPort = IRIS_DEFAULT_PORT + 1;
    const code = iris({ port: customPort }).load?.(IRIS_CONNECT_MODULE);
    expect(code).toContain(String(customPort));
    expect(code).toContain('ws://localhost:');
  });

  it('omits the url for the default port (SDK default applies)', () => {
    const code = iris().load?.(IRIS_CONNECT_MODULE);
    expect(code).not.toContain('ws://localhost:');
  });

  it('forwards session and token when provided', () => {
    const code = iris({ session: 'my-app', token: 'secret' }).load?.(IRIS_CONNECT_MODULE);
    expect(code).toContain('my-app');
    expect(code).toContain('secret');
  });
});
