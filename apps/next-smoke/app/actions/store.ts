/**
 * The two lists the Server Actions write.
 *
 * Module state, deliberately: this fixture answers "does a write that reached the server through a
 * Server Action become visible to Reticle", and a database would put the answer behind a second
 * moving part. Held on `globalThis` because Next compiles a `'use server'` module and the page that
 * imports it in separate server layers, and a plain module export would then be two arrays — the
 * page reading one while the action writes the other.
 */
interface ActionStore {
  notes: string[];
  tags: string[];
}

const shared = globalThis as unknown as { __nextSmokeStore?: ActionStore };
shared.__nextSmokeStore ??= { notes: [], tags: [] };

export const notes = shared.__nextSmokeStore.notes;
export const tags = shared.__nextSmokeStore.tags;
