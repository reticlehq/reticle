/** Domain constants for the demo dashboard. No free strings in components. */

export const DashboardTab = {
  OVERVIEW: 'overview',
  ACTIVITY: 'activity',
  SETTINGS: 'settings',
} as const;
export type DashboardTab = (typeof DashboardTab)[keyof typeof DashboardTab];

export const TAB_LABELS: Readonly<Record<DashboardTab, string>> = {
  [DashboardTab.OVERVIEW]: 'Overview',
  [DashboardTab.ACTIVITY]: 'Activity',
  [DashboardTab.SETTINGS]: 'Settings',
};

export const TestId = {
  TAB: 'dashboard-tab',
  TAB_PANEL: 'dashboard-panel',
  ADD_ITEM: 'add-item-button',
  ITEM_LIST: 'item-list',
} as const;
export type TestId = (typeof TestId)[keyof typeof TestId];
