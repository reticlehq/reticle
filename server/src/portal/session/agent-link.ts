/**
 * What the HUD shows about the coding agent: who is attached, and this tab's latest notes to it with
 * whether an agent's tool call has taken each one. Read from the session's own inbox history, so
 * "Seen" is shown only for a note that was actually handed to an agent.
 */
import { AGENT_NOTE_MAX, AGENT_NOTES_SHOWN, type AgentLink } from '@reticlehq/core';
import { connectedAgents } from '@/hooks/coding-agents.js';
import type { InboxMessage } from './human/live-control.js';

export function agentLinkOf(history: readonly InboxMessage[]): AgentLink {
  return {
    agents: connectedAgents(),
    notes: history.slice(-AGENT_NOTES_SHOWN).map((message) => ({
      text: message.text.slice(0, AGENT_NOTE_MAX),
      seen: true === message.seen,
      ...(message.by === undefined ? {} : { by: message.by }),
    })),
  };
}
