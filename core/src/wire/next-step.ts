/**
 * What to do next, and who does it, when Reticle refuses something.
 *
 * One file because the daemon, the HUD and the agent each say part of the same answer. When each
 * wrote its own, the Harness refusal said `reticle connect` and the recovery beside it said
 * `npx @reticlehq/server connect`: two spellings of one command, in one answer.
 */
import * as z from 'zod';
import { ReticleTool } from './tool-names.js';

/** The command that signs a person in and links a project. The docs spell it this way. */
export const CONNECT_COMMAND = 'reticle connect';

/** The refusals that say what to do next as data rather than in a sentence. */
export const RefusalCode = {
  /** The Harness was asked for, and this project is not linked to the platform it runs on. */
  HARNESS_NOT_LINKED: 'harness_not_linked',
} as const;
export type RefusalCode = (typeof RefusalCode)[keyof typeof RefusalCode];

/** Who takes a next step: the person (a command to run) or the agent (a tool to call). */
export const NextWho = { HUMAN: 'human', AGENT: 'agent' } as const;

export const NextStepSchema = z.discriminatedUnion('who', [
  z.object({ who: z.literal(NextWho.HUMAN), run: z.string() }),
  z.object({ who: z.literal(NextWho.AGENT), tool: z.string() }),
]);
export type NextStep = z.infer<typeof NextStepSchema>;

/** A coded refusal, as it rides on a tool's error envelope beside `error`. */
export const CodedRefusalSchema = z.object({
  code: z.enum([RefusalCode.HARNESS_NOT_LINKED]),
  next: z.array(NextStepSchema),
});
export type CodedRefusal = z.infer<typeof CodedRefusalSchema>;

/** Not linked: the person connects, or the agent drives the journey itself. */
export const HARNESS_NOT_LINKED_NEXT: readonly NextStep[] = [
  { who: NextWho.HUMAN, run: CONNECT_COMMAND },
  { who: NextWho.AGENT, tool: ReticleTool.ACT_AND_WAIT },
];

/**
 * The same refusal, for the person on the HUD: one sentence, the command, no tool names. No credit
 * number either: free credit is granted once per person, so the engine cannot know what is left.
 */
export const HARNESS_NOT_LINKED_HUMAN = `Connect your Reticle account to run the Harness: \`${CONNECT_COMMAND}\`.`;
