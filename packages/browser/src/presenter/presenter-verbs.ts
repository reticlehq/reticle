// Present-tense verb for an action label in the presenter HUD (cursor status + act-log row).
// Presenter-only UI copy - never a wire string. Shared by presenter.ts (cursor) and reticle.ts
// (act-log row) so the two stay in lockstep.
//
// The CASES are wire values though, and they are core's ActionType. Spelled as free strings here,
// a rename in core left this switch silently falling through to `default` - which returns the raw
// action name, so the HUD degrades to "webmcp Save" instead of a verb and nothing fails.
import { ActionType } from '@reticlehq/core';

export function actionVerb(action: string): string {
  switch (action) {
    case ActionType.CLICK:
    case ActionType.DBLCLICK:
      return 'Clicking';
    case ActionType.FILL:
    case ActionType.TYPE:
      return 'Typing into';
    case ActionType.HOVER:
      return 'Hovering';
    case ActionType.SELECT:
      return 'Selecting';
    case ActionType.SUBMIT:
      return 'Submitting';
    case ActionType.CHECK:
    case ActionType.UNCHECK:
      return 'Toggling';
    case ActionType.UPLOAD:
      return 'Uploading to';
    case ActionType.DRAG:
      return 'Dragging';
    default:
      return action;
  }
}
