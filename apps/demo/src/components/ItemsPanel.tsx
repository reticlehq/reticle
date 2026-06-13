import { useEffect, useState } from 'react';
import { addItem, fetchItems, type Item } from '../api.js';
import { Colors, Spacing, Typography } from '../design/tokens.js';
import { TestId } from '../constants/index.js';
import { button, card, input, row, subtleButton } from './styles.js';

interface Props {
  token: string;
  onNotify: (message: string) => void;
}

export function ItemsPanel({ token, onNotify }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [name, setName] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = (): void => {
    setLoading(true);
    fetchItems(token)
      .then((r) => {
        setItems(r.items);
        setTotal(r.total);
      })
      .catch((e: unknown) => {
        console.error('load items failed', e);
      })
      .finally(() => {
        setLoading(false);
      });
  };

  useEffect(load, [token]);

  const add = (): void => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    addItem(token, trimmed)
      .then((r) => {
        setPending(
          `"${trimmed}" accepted — visible after ${String(r.visibleInMs)}ms. Refresh to see it.`,
        );
        setName('');
      })
      .catch((e: unknown) => {
        console.error('add failed', e);
      });
  };

  return (
    <section style={card}>
      <div style={{ ...row, justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: Typography.fontSize.lg }}>
          Items <span style={{ color: Colors.textMuted }}>({total})</span>
        </h2>
        <button data-testid={TestId.REFRESH_ITEMS} onClick={load} style={subtleButton}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div style={{ ...row, marginTop: Spacing.md }}>
        <input
          data-testid={TestId.ADD_ITEM_INPUT}
          placeholder="New item name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          style={input}
        />
        <button data-testid={TestId.ADD_ITEM_BUTTON} onClick={add} style={button}>
          Add
        </button>
        <button
          data-testid={TestId.NOTIFY_BUTTON}
          onClick={() => {
            onNotify(`New item queued: ${name.trim().length > 0 ? name.trim() : '(unnamed)'}`);
          }}
          style={subtleButton}
        >
          Notify
        </button>
      </div>

      {pending !== null ? (
        <p data-testid={TestId.PENDING_BANNER} role="status" style={{ color: Colors.textMuted }}>
          {pending}
        </p>
      ) : null}

      <ul
        data-testid={TestId.ITEM_LIST}
        style={{ maxHeight: 320, overflow: 'auto', marginTop: Spacing.md, paddingLeft: Spacing.lg }}
      >
        {items.map((item) => (
          <li key={item.id} style={{ padding: '2px 0' }}>
            {item.name}
          </li>
        ))}
      </ul>
    </section>
  );
}
