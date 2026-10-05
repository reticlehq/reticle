import { ReticleTool } from '@reticlehq/core';
import { FeedbackKind } from '@reticlehq/core/telemetry';
import type { MergePlan } from './merge-tools.js';

/** Fold `reticle_sessions` and `reticle_feedback` into `reticle_session` on the merged surface only. */
export function withMergedSessionMembers(plan: MergePlan): MergePlan {
  if (plan.name !== ReticleTool.SESSION) return plan;
  return {
    ...plan,
    members: {
      ...plan.members,
      list: ReticleTool.SESSIONS,
      feedback: ReticleTool.FEEDBACK,
    },
    description: `${plan.description} Also here: "list" is the default; "feedback" needs kind (${Object.values(FeedbackKind).join('|')}) and text.`,
    example: {
      action: 'feedback',
      kind: FeedbackKind.BUG,
      text: 'The merged session tool never showed that feedback needs a kind.',
    },
    defaultAction: 'list',
  };
}
