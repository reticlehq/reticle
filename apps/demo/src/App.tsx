import { useState, type CSSProperties } from 'react';
import { Colors, Radius, Spacing, Typography } from './design/tokens.js';
import { DashboardTab, TAB_LABELS, TAB_ORDER } from './constants/index.js';
import { LoginForm } from './components/LoginForm.js';
import { ItemsPanel } from './components/ItemsPanel.js';
import { ErrorsPanel } from './components/ErrorsPanel.js';
import { ScriptPanel } from './components/ScriptPanel.js';
import { ScorePanel } from './components/ScorePanel.js';
import { NotificationsPanel } from './components/NotificationsPanel.js';
import { HoverButton } from './components/HoverButton.js';

export function App() {
  const [token, setToken] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DashboardTab>(DashboardTab.ITEMS);
  const [notifications, setNotifications] = useState<string[]>([]);

  if (token === null) {
    return <LoginForm onAuth={setToken} />;
  }

  const notify = (message: string): void => {
    setNotifications((prev) => [message, ...prev]);
  };

  return (
    <main style={pageStyle}>
      <div style={headerStyle}>
        <h1 style={{ fontSize: Typography.fontSize.xl, margin: 0 }}>Iris Dashboard</h1>
        <HoverButton />
      </div>

      <div role="tablist" aria-label="Dashboard sections" style={tablistStyle}>
        {TAB_ORDER.map((tab) => {
          const selected = tab === activeTab;
          const count = tab === DashboardTab.NOTIFICATIONS ? notifications.length : 0;
          return (
            <button
              key={tab}
              role="tab"
              aria-selected={selected}
              data-testid={`tab-${tab}`}
              onClick={() => {
                setActiveTab(tab);
              }}
              style={tabStyle(selected)}
            >
              {TAB_LABELS[tab]}
              {count > 0 ? ` (${String(count)})` : ''}
            </button>
          );
        })}
      </div>

      <div role="tabpanel">
        {activeTab === DashboardTab.ITEMS ? <ItemsPanel token={token} onNotify={notify} /> : null}
        {activeTab === DashboardTab.ERRORS ? <ErrorsPanel token={token} /> : null}
        {activeTab === DashboardTab.GENERATE ? <ScriptPanel token={token} /> : null}
        {activeTab === DashboardTab.SCORE ? <ScorePanel token={token} /> : null}
        {activeTab === DashboardTab.NOTIFICATIONS ? (
          <NotificationsPanel items={notifications} />
        ) : null}
      </div>
    </main>
  );
}

const pageStyle: CSSProperties = {
  fontFamily: Typography.fontFamily,
  background: Colors.bg,
  color: Colors.text,
  minHeight: '100vh',
  padding: Spacing.xl,
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const tablistStyle: CSSProperties = {
  display: 'flex',
  gap: Spacing.sm,
  marginTop: Spacing.lg,
  flexWrap: 'wrap',
};

function tabStyle(selected: boolean): CSSProperties {
  return {
    padding: `${Spacing.sm} ${Spacing.md}`,
    borderRadius: Radius.md,
    border: `1px solid ${Colors.border}`,
    background: selected ? Colors.primary : Colors.surface,
    color: Colors.text,
    cursor: 'pointer',
  };
}
