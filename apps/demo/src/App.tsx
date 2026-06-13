import { useState, type CSSProperties } from 'react';
import { Colors, Radius, Spacing, Typography } from './design/tokens.js';
import { DashboardTab, TAB_LABELS, TestId } from './constants/index.js';

const TAB_ORDER: readonly DashboardTab[] = [
  DashboardTab.OVERVIEW,
  DashboardTab.ACTIVITY,
  DashboardTab.SETTINGS,
];

export function App(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<DashboardTab>(DashboardTab.OVERVIEW);
  const [items, setItems] = useState<string[]>(['First item']);

  const addItem = (): void => {
    setItems((prev) => [...prev, `Item ${String(prev.length + 1)}`]);
  };

  const removeItem = (index: number): void => {
    setItems((prev) => prev.filter((_value, i) => i !== index));
  };

  return (
    <main style={pageStyle}>
      <h1 style={{ fontSize: Typography.fontSize.xl }}>Iris Demo Dashboard</h1>

      <div role="tablist" aria-label="Dashboard sections" style={tablistStyle}>
        {TAB_ORDER.map((tab) => {
          const selected = tab === activeTab;
          return (
            <button
              key={tab}
              role="tab"
              aria-selected={selected}
              data-testid={TestId.TAB}
              onClick={() => {
                setActiveTab(tab);
              }}
              style={tabStyle(selected)}
            >
              {TAB_LABELS[tab]}
            </button>
          );
        })}
      </div>

      <section role="tabpanel" data-testid={TestId.TAB_PANEL} style={panelStyle}>
        {activeTab === DashboardTab.OVERVIEW ? (
          <div>
            <button data-testid={TestId.ADD_ITEM} onClick={addItem} style={primaryButtonStyle}>
              Add item
            </button>
            <ul data-testid={TestId.ITEM_LIST} style={{ marginTop: Spacing.md }}>
              {items.map((item, index) => (
                <li key={item} style={listItemStyle}>
                  <span>{item}</span>
                  <button
                    aria-label={`Remove ${item}`}
                    onClick={() => {
                      removeItem(index);
                    }}
                    style={removeButtonStyle}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {activeTab === DashboardTab.ACTIVITY ? <p>No recent activity.</p> : null}
        {activeTab === DashboardTab.SETTINGS ? <p>Settings go here.</p> : null}
      </section>
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

const tablistStyle: CSSProperties = {
  display: 'flex',
  gap: Spacing.sm,
  marginTop: Spacing.lg,
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

const panelStyle: CSSProperties = {
  marginTop: Spacing.lg,
  padding: Spacing.lg,
  background: Colors.surface,
  borderRadius: Radius.lg,
  border: `1px solid ${Colors.border}`,
};

const primaryButtonStyle: CSSProperties = {
  padding: `${Spacing.sm} ${Spacing.md}`,
  borderRadius: Radius.md,
  border: 'none',
  background: Colors.primary,
  color: Colors.text,
  cursor: 'pointer',
};

const listItemStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: `${Spacing.sm} 0`,
  borderBottom: `1px solid ${Colors.border}`,
};

const removeButtonStyle: CSSProperties = {
  padding: `${Spacing.xs} ${Spacing.sm}`,
  borderRadius: Radius.sm,
  border: `1px solid ${Colors.border}`,
  background: Colors.surfaceMuted,
  color: Colors.textMuted,
  cursor: 'pointer',
};
