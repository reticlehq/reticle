/**
 * The desktop subject: which scenarios a real Electron shell can be put into, and how.
 *
 * A sibling of `bench-app.mjs`, and here for the same reason that one is: a subject map is the
 * one place an implementation can cheat without anybody noticing, so it is a file a test can
 * read rather than a constant buried in a runner that boots Electron on import.
 *
 * Moving it out also let a fact that was already written here in a comment become something the
 * suite states: this shell plants `fire-and-forget`, which the browser fixture cannot. The two
 * subjects are complementary, not one a subset of the other, and until now nothing said so --
 * each runner printed its own absent list as though it were the whole story.
 */
export const ELECTRON_SMOKE_SUBJECT = Object.freeze({
  /**
   * The screen moves on over an operation that failed.
   *
   * `todos:archive` always rejects and the renderer updates optimistically and swallows it --
   * a defect the smoke app has carried since it was written, for the web battery's benefit.
   * Nothing was added to the fixture to reach this scenario, which matters: inventing a bug to
   * raise a conformance score is building the fixture around the number it produces.
   */
  'effect-failed-surface-advanced': {
    act: { target: 'archive-1', verb: 'click' },
    claim: 'the todo was archived',
    reads: ['net'],
  },

  /**
   * An action whose effect nothing can observe.
   *
   * `todos:seen` is `ipcRenderer.send` with no reply, so the renderer cannot learn whether it
   * ran. This scenario is ABSENT on the web subject and reachable here, which is the first case
   * of the desktop shell covering something the browser fixture cannot.
   */
  'fire-and-forget': {
    act: { target: 'mark-seen', verb: 'click' },
    claim: 'the todo was marked seen',
    reads: ['net'],
  },

  'healthy-app-real-claim': {
    // Crosses the contextBridge and comes back with a row the renderer did not author.
    act: { target: 'add', verb: 'click' },
    claim: 'the todo was added',
    reads: ['net'],
  },
  /**
   * The same claim-is-the-plant scenario the web subject uses, and it needs nothing from this
   * app either. `visual` is undeclared on both shells, so clause 2 answers before any evidence
   * is weighed.
   */
  'claim-reads-an-undeclared-channel': {
    act: { target: 'add', verb: 'click' },
    claim: 'the screen showed the new todo',
    reads: ['visual'],
  },

  /**
   * The healthy run with the claim written down afterwards. Same action, same evidence; only
   * the order differs, which is what makes it the scenario an implementation passes by accident
   * if it ignores `declaredAt`.
   */
  'claim-written-after-the-action': {
    act: { target: 'add', verb: 'click' },
    claim: 'the todo was added',
    reads: ['net'],
    declaredAt: 'after-action',
  },

  'nothing-declared': { act: undefined, claim: undefined, reads: [] },
});
