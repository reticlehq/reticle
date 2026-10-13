/**
 * How an agent must write the text that Reticle keeps: flow names, notes, feedback, reports and plans.
 *
 * The standard is ASD-STE100 (Simplified Technical English), followed about 80% of the way. Other
 * agents, other models and people who do not speak English as a first language read this text later.
 * A short, literal sentence keeps one meaning for all of them.
 *
 * One source for every prompt. The open-source harness, the MCP briefing and the platform harness
 * all import these words, so the rule cannot drift between them.
 */

/** The full rule, for a model prompt that has room for it. */
export const WRITING_RULE =
  'Write all text that you save or report (flow names, notes, feedback, summaries, plans) in Simplified ' +
  'Technical English (ASD-STE100): short sentences (about 20 words), one topic per sentence, active voice, ' +
  'simple tenses, commands for instructions, and one meaning for each word. Do not use idioms or slang. ' +
  'Keep product names, tool names and code identifiers as they are.';

/** The same rule in one line, for the MCP briefing, which has a hard byte cap. */
export const WRITING_RULE_SHORT =
  'Write saved text (flows, notes, feedback) in ASD-STE100 Simplified English: short, active, literal.';
