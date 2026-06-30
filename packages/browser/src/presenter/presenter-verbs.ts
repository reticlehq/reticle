// Present-tense verb for an action label in the presenter HUD (cursor status + act-log row).
// Presenter-only UI copy — never a wire string. Shared by presenter.ts (cursor) and reticle.ts
// (act-log row) so the two stay in lockstep.
export function actionVerb(action: string): string {
  switch (action) {
    case 'click':
    case 'dblclick':
      return 'Clicking';
    case 'fill':
    case 'type':
      return 'Typing into';
    case 'hover':
      return 'Hovering';
    case 'select':
      return 'Selecting';
    case 'submit':
      return 'Submitting';
    case 'check':
    case 'uncheck':
      return 'Toggling';
    case 'upload':
      return 'Uploading to';
    case 'drag':
      return 'Dragging';
    default:
      return action;
  }
}
