import { describe, expect, it } from 'vitest';
import { TOOLS, type ToolDef, type ToolDeps } from './tools.js';
import { runTool } from './invoke-tool.js';
import { BaselineStore } from '../project/baselines.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import type { SessionManager } from '../session/session.js';

/**
 * A consumer embedding this engine may carry its own dependencies on the deps bag.
 *
 * `ToolDeps` is a closed record of what THIS package's tools need. A consumer that adds tools of its
 * own — a service answering out of a store this package has never heard of — had nowhere to put the
 * handle. The options were to widen `ToolDeps` with a field the engine will never read, which makes
 * the free product carry a stranger's vocabulary, or to fork. Both are worse than a slot.
 *
 * `ext` is that slot, and it is deliberately inert: nothing in this package reads it, so it cannot
 * change any behaviour here. The type parameter exists so the consumer's own tools see their own
 * type rather than casting out of `unknown` at every handler — a cast at every call site is how a
 * typed seam decays into an untyped one.
 */

const ROOT = '/tmp/reticle-test/.reticle';

function fakeDeps<Ext>(ext: Ext): ToolDeps<Ext> {
  const sessions: Partial<SessionManager> = {};
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(createNodeFileSystem(), ROOT, { now: () => 0 }),
    project: new ProjectStore(createNodeFileSystem(), ROOT, { now: () => 0 }),
    annotations: new AnnotationStore(),
    fs: createNodeFileSystem(),
    reticleRoot: ROOT,
    now: () => 0,
    ext,
  };
}

/** What a consumer's own dependency bag might look like. The engine never sees this type. */
interface ConsumerExt {
  knowledge: { recall(key: string): string };
}

const CONSUMER_TOOL: ToolDef<ConsumerExt> = {
  name: 'consumer_recall',
  description: 'A tool this package does not ship, answering out of a store it does not know.',
  inputSchema: {},
  handler: (deps, args) => {
    const key = 'string' === typeof args.key ? args.key : '';
    // No cast: `deps.ext` is ConsumerExt here, which is the whole point of the type parameter.
    return Promise.resolve({ answer: deps.ext?.knowledge.recall(key) });
  },
};

describe('ToolDeps.ext', () => {
  it('carries a consumer dependency through runTool to the consumer handler', async () => {
    const deps = fakeDeps<ConsumerExt>({
      knowledge: { recall: (key) => `remembered:${key}` },
    });

    const result = (await runTool(CONSUMER_TOOL, deps, { key: 'routes' })) as {
      answer?: string;
    };

    expect(result.answer).toBe('remembered:routes');
  });

  it('is optional, so every existing deps bag is still a valid one', () => {
    // The engine's own tools never read `ext`, so a caller that supplies none must be unaffected.
    // Typed as the default parameterisation, which is what every existing construction resolves to.
    const deps: ToolDeps = {
      sessions: {} as SessionManager,
      baselines: new BaselineStore(),
      recordings: new RecordingStore(),
      flows: new FlowStore(createNodeFileSystem(), ROOT, { now: () => 0 }),
      project: new ProjectStore(createNodeFileSystem(), ROOT, { now: () => 0 }),
      annotations: new AnnotationStore(),
      fs: createNodeFileSystem(),
      reticleRoot: ROOT,
      now: () => 0,
    };

    expect(deps.ext).toBeUndefined();
  });

  it("lets a consumer compose this package's tools with its own into one surface", () => {
    // The property that decides whether a consumer forks: a shipped tool, whose handler was written
    // against the plain deps bag, must drop into an array typed for the consumer's extension. If this
    // assignment needed a cast, every composed surface would need one, and a surface assembled behind
    // casts is a surface the compiler has stopped checking.
    const surface: ToolDef<ConsumerExt>[] = [...TOOLS, CONSUMER_TOOL];

    // And the other direction, which is what serving that surface needs: `createMcpServer` takes the
    // plain table, so a consumer tool has to fit into it. Both assignments only typecheck because
    // `handler` is declared method-style — see the note on it in tool-kit.ts. A refactor to property
    // style would fail here rather than surfacing as a cast in somebody else's repository.
    const served: readonly ToolDef[] = surface;

    expect(surface).toContain(CONSUMER_TOOL);
    expect(served.length).toBe(TOOLS.length + 1);
  });
});
