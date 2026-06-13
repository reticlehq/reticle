/** Domain constants for the demo dashboard. No free strings in components. */

export const DashboardTab = {
  ITEMS: 'items',
  ERRORS: 'errors',
  GENERATE: 'generate',
  SCORE: 'score',
  NOTIFICATIONS: 'notifications',
} as const;
export type DashboardTab = (typeof DashboardTab)[keyof typeof DashboardTab];

export const TAB_LABELS: Readonly<Record<DashboardTab, string>> = {
  [DashboardTab.ITEMS]: 'Items',
  [DashboardTab.ERRORS]: 'Errors',
  [DashboardTab.GENERATE]: 'Generate',
  [DashboardTab.SCORE]: 'Score a file',
  [DashboardTab.NOTIFICATIONS]: 'Notifications',
};

export const TAB_ORDER: readonly DashboardTab[] = [
  DashboardTab.ITEMS,
  DashboardTab.ERRORS,
  DashboardTab.GENERATE,
  DashboardTab.SCORE,
  DashboardTab.NOTIFICATIONS,
];

export const TestId = {
  LOGIN_EMAIL: 'login-email',
  LOGIN_PASSWORD: 'login-password',
  LOGIN_SUBMIT: 'login-submit',
  LOGIN_ERROR: 'login-error',
  TAB: 'dashboard-tab',
  ADD_ITEM_INPUT: 'add-item-input',
  ADD_ITEM_BUTTON: 'add-item-button',
  REFRESH_ITEMS: 'refresh-items',
  ITEM_LIST: 'item-list',
  PENDING_BANNER: 'pending-banner',
  NOTIFY_BUTTON: 'notify-button',
  NOTIFICATION_LIST: 'notification-list',
  SCRIPT_PROMPT: 'script-prompt',
  GENERATE_BUTTON: 'generate-button',
  SCRIPT_OUTPUT: 'script-output',
  FILE_INPUT: 'file-input',
  ANALYZE_BUTTON: 'analyze-button',
  SCORE_MODAL: 'score-modal',
  SCORE_VALUE: 'score-value',
  HOVER_BUTTON: 'hover-button',
} as const;
export type TestId = (typeof TestId)[keyof typeof TestId];
