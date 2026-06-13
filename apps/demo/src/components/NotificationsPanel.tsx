import { Colors, Typography } from '../design/tokens.js';
import { card } from './styles.js';
import { TestId } from '../constants/index.js';

export function NotificationsPanel({ items }: { items: string[] }) {
  return (
    <section style={card}>
      <h2 style={{ marginTop: 0, fontSize: Typography.fontSize.lg }}>Notifications</h2>
      {items.length === 0 ? (
        <p style={{ color: Colors.textMuted }}>No notifications yet.</p>
      ) : (
        <ul data-testid={TestId.NOTIFICATION_LIST}>
          {items.map((message, i) => (
            <li key={`${String(i)}-${message}`}>{message}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
