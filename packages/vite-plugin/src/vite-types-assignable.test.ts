/**
 * The documented install must not red-build a project that typechecks its own config.
 *
 * `reticle()` in a Vite plugin array failed `vue-tsc --noEmit` with TS2322: the real `ViteDevServer`
 * is not assignable to our structural stand-in. The cause is contravariance, and it is the opposite
 * of what the loose types look like they are doing — declaring `invalidateModule: (mod: object) =>
 * void` as a PROPERTY makes the parameter checked strictly, so a wider `object` in that position
 * makes the type STRICTER, not looser, and Vite's real `(mod: ModuleNode, …)` cannot satisfy it.
 *
 * Method syntax is checked bivariantly, which is exactly the latitude a structural stand-in wants.
 *
 * The failure mode is the nastiest kind: the plugin WORKS at runtime, so nothing here or in any
 * fixture app catches it — only a user who typechecks their config in CI does, and what they see is
 * a red build from following the documented install exactly. Hence a compile-time test: it fails at
 * `tsc`, which is the only place the defect is visible.
 */

import { describe, expect, it } from 'vitest';
import type { ViteDevServer, PluginOption, UserConfig, Plugin } from 'vite';
import type { ViteDevServerLike } from './index.js';
import { reticle } from './index.js';

describe('public types stay consumable from a strict TS project', () => {
  it('accepts Vite’s real ViteDevServer where the plugin asks for one', () => {
    // The assertion IS the assignment: if the stand-in drifts back to a stricter shape, this file
    // stops compiling and `pnpm typecheck` goes red.
    const narrow: (server: ViteDevServer) => ViteDevServerLike = (server) => server;
    expect(typeof narrow).toBe('function');
  });

  it('drops into a Vite plugin array without a cast', () => {
    // What the docs tell a user to write. `plugins: [reticle()]` is a PluginOption[] in every real
    // config, and this is the exact position that produced TS2322.
    const plugins: PluginOption[] = [reticle()];
    expect(plugins).toHaveLength(1);
  });
});

/**
 * The second half of the same defect, and the half our own repo cannot see: we develop against ONE
 * Vite major. `plugins: [reticle()]` typechecking here proves nothing about the majors users are on,
 * and two independent reporters could not adopt 2.13.1 because `tsc` / `svelte-check` rejected it.
 *
 * The concrete shape is `server.watch`, which Vite declares as `WatchOptions | null` — `null` is how
 * a config turns the watcher off, and SvelteKit's template does exactly that. Our `config` hook was
 * declared as a PROPERTY taking `server?: { watch?: {…} }`, and a property's parameter is checked
 * strictly, so the stand-in REJECTED the config Vite hands it. Same contravariance trap the top of
 * this file documents, one hook further down.
 */
describe('the config hook accepts the config Vite actually hands it', () => {
  it('accepts a config whose watcher is switched off with null', () => {
    const plugin = reticle();
    // Vite's own type, not a hand-written stand-in: this is the value Vite passes.
    const config: UserConfig = { server: { watch: null } };
    // The assertion IS the call: if the hook's parameter narrows again, this stops compiling.
    expect(plugin.config?.(config)).toBeTruthy();
  });

  it('is assignable to Vite’s own Plugin, not merely to a member of the PluginOption union', () => {
    // `PluginOption` is a wide union, so a stand-in can satisfy it while still being rejected in the
    // `Plugin` slot a typed config or a wrapping framework (SvelteKit, Nuxt) puts it in. This is the
    // position that actually failed for reporters, and the one the array test above cannot see.
    const asVitePlugin: Plugin = reticle();
    expect(asVitePlugin.name).toContain('reticle');
  });
});
