import { ASSET_URL } from './body-relevance.js';
import { byteSizeOf } from './byte-size.js';

/**
 * Collapse the dev server's own traffic out of a network listing.
 *
 * Measured on a connected drive of the bench app: `reticle_network` returned 200 calls and 28,408
 * bytes, mean 142 bytes each, and 68% of those bytes were URLs like `/src/main.tsx` and
 * `/node_modules/.vite/deps/react.js`. None of them carried a body and none of them was evidence of
 * anything being verified — it is the bundler talking to itself, billed to the agent on every read.
 *
 * This is a ROUTE cut and it has to stay one. `lean` is what happens when that line is crossed:
 * dropping evidence to save tokens cost it two of five fixes and produced this project's first
 * measured false green. So a FAILED asset is never folded — a 404 on a chunk is a real defect — and
 * nothing folds once the caller's filter shows they are asking about particular calls. What is
 * folded is reported with a count, a byte total, a sample and the argument that brings it all back,
 * because a saving the reader cannot see or undo is a capability that degrades in silence.
 */

/**
 * The fields this reads. Structural on purpose: it runs over an already-projected call view and
 * must not import that view's type, which lives on the other side of a package boundary.
 *
 * No index signature — one would force every caller's concrete view to declare it, and a projected
 * view that carries exactly the fields it means is the better shape to keep.
 */
export interface ListedCall {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly status?: number | string | undefined;
}

export interface FoldedNote {
  readonly count: number;
  readonly bytes: number;
  readonly sample: string[];
  readonly why: string;
  readonly how: string;
}

export interface FoldOptions {
  /** False whenever the caller filtered: a filter means they are asking about specific calls. */
  readonly folding: boolean;
}

/** How many folded URLs to show, so the reader can see WHAT was folded without paying for all of it. */
const SAMPLE = 3;

function isSuccess(status: number | string | undefined): boolean {
  return 'number' === typeof status && status >= 200 && status < 400;
}

/** A successful GET of something the build produced — the bulk, and the part nobody asked about. */
function isNoise(call: ListedCall): boolean {
  if ('GET' !== (call.method ?? '').toUpperCase()) return false;
  if (!isSuccess(call.status)) return false;
  return ASSET_URL.test(call.url ?? '');
}

export function foldAssetNoise<T extends ListedCall>(
  calls: readonly T[],
  options: FoldOptions,
): { calls: T[]; folded?: FoldedNote } {
  if (!options.folding) return { calls: [...calls] };
  const kept: T[] = [];
  const folded: T[] = [];
  for (const call of calls) (isNoise(call) ? folded : kept).push(call);
  if (0 === folded.length) return { calls: kept };
  return {
    calls: kept,
    folded: {
      count: folded.length,
      bytes: byteSizeOf(JSON.stringify(folded)),
      sample: folded.slice(0, SAMPLE).map((c) => c.url ?? ''),
      why: 'successful GETs of build output (modules, styles, maps, Vite plumbing). They carry no verdict — this is the bundler talking to itself, not the app under test.',
      how: 'pass assets:true to list them, or name what you mean with urlContains / method / status.',
    },
  };
}
