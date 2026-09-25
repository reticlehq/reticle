/**
 * The names a flow step can carry, and the address of a whole-journey finding.
 *
 * A LEAF module on purpose, and the reason is measurable. These are plain constants, but they used
 * to live in `flow-types.ts` beside eleven zod schemas built at module scope — so the browser SDK,
 * which imports `FlowStepTool` and nothing else from that file, loaded every one of them into every
 * page it instruments. A browser never validates a flow FILE; flows are read and written by the
 * daemon. The schemas were pure weight on every page load, and they grew whenever the daemon's file
 * format did: three separate schema additions moved the SDK's first-load ceiling in one week.
 *
 * This is the same defect this repository has already recorded once, in the first-load guard's own
 * words: "a single z-index dragged the panel's whole stylesheet into the first load, a hundred
 * kilobytes reached through one integer." A constant that a light consumer needs belongs in a file
 * of its own, not beside the heavy thing it happens to describe.
 */

/** The `step` address of a finding that belongs to the whole journey, not to one step in it. */
export const CROSS_STEP_ADDRESS = -1;

export const FlowStepTool = {
  ACT: 'reticle_act',
  ACT_SEQUENCE: 'reticle_act_sequence',
  ACT_AND_WAIT: 'reticle_act_and_wait',
  /**
   * Run another flow. The step drives nothing itself; `invoke` names the document to replay.
   *
   * Here rather than in the recorder, for the reason stated above this object: it crosses the
   * recorder, the saved file and the replayer, and a string spelled in three places is a rename
   * away from a recorder that writes what no replayer reads. That is the exact drift this enum was
   * created to end, and a new one would have re-opened it.
   */
  INVOKE: 'reticle_invoke',
} as const;

/** The companion type. It lives beside the const, so naming either one reaches only this leaf. */
export type FlowStepTool = (typeof FlowStepTool)[keyof typeof FlowStepTool];
