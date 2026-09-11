/**
 * Which flows a suite run replays, resolved against the store.
 *
 * Shared by the MCP tool and the `reticle verify` command so the two cannot disagree about what a
 * selection means.
 *
 * Lives beside the flow store rather than under `suite/` on purpose: it needs `flowsForSession`, and
 * from `suite/` that import made `suite` and `flows` need EACH OTHER -- a mutual pair, which the
 * reach guard forbids growing because two directories that need each other cannot be read, moved or
 * tested apart. Here it adds no edge at all: `flows` reaching itself is nothing, and `cli -> flows`
 * already existed. The pure rule lives in core (`selectFlows`); this is the part that has to read
 * the files, because a label lives in one and `list` returns only names.
 */
import { FLOW_FILE_VERSION, selectFlows, type FlowFile } from '@reticlehq/core';
import { flowsForSession } from './flow-store-for-session.js';
import type { ToolDeps } from '../../agent/tools/tools.js';

/**
 * Resolve what a suite run should replay, and what it is holding back.
 *
 * Loads the candidate flows so selection can read their labels and status — `list` returns names,
 * and a label lives in the file. The reads are small and the suite is about to replay these anyway.
 *
 * A flow that fails to load is kept as a candidate rather than dropped: refusing to run it here
 * would turn a corrupt file into missing coverage nobody is told about, and replay reports the parse
 * failure far better than a silent omission does.
 */
export async function resolveSuiteSelection(
  deps: ToolDeps,
  projectId: string | undefined,
  args: Record<string, unknown>,
): Promise<{ run: string[]; quarantined: string[]; unmatched: string[] }> {
  const store = flowsForSession(deps, projectId).flows;
  const names = await store.list(projectId);
  const asStrings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => 'string' === typeof v) : [];
  const wantedNames = asStrings(args['names']);
  const wantedLabels = asStrings(args['labels']);

  const loaded: FlowFile[] = [];
  for (const name of names) {
    const file = await store.load(name, projectId);
    /*
     * The LISTED name wins over the file's own.
     *
     * The listing is what the store says exists and is what every other caller addresses a flow by;
     * the `name` inside the file is data that can disagree with it — a hand-edited file, a copy, a
     * rename that touched one and not the other. Selecting on the file's copy would then run a flow
     * under a name nothing else recognises.
     *
     * An unreadable file keeps its place in the running set rather than being dropped: replay
     * reports a parse failure far better than a silent omission, which would turn a corrupt file
     * into missing coverage nobody is told about.
     */
    const base: Omit<FlowFile, 'name'> = file.ok
      ? file.value
      : { version: FLOW_FILE_VERSION, createdAt: 0, steps: [] };
    loaded.push({ ...base, name });
  }

  const chosen = selectFlows(loaded, {
    ...(0 === wantedNames.length ? {} : { names: wantedNames }),
    ...(0 === wantedLabels.length ? {} : { labels: wantedLabels }),
  });
  /*
   * A name the caller asked for that no file matches is still ATTEMPTED.
   *
   * Replay already answers a missing flow with the real reason, and that is a better answer than
   * quietly running one fewer flow than was asked for. `unmatched` therefore reports labels, where
   * a typo has no other way of surfacing -- ask for `@smoek` and, without this, a suite of zero
   * flows reports a clean pass.
   */
  const missingNames = wantedNames.filter((name) => !names.includes(name));
  return {
    run: [...chosen.run.map((flow) => flow.name), ...missingNames],
    quarantined: chosen.quarantined,
    unmatched: chosen.unmatched.filter((entry) => !wantedNames.includes(entry)),
  };
}
