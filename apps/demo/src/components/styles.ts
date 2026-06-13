import type { CSSProperties } from 'react';
import { Colors, Radius, Spacing } from '../design/tokens.js';

export const card: CSSProperties = {
  background: Colors.surface,
  border: `1px solid ${Colors.border}`,
  borderRadius: Radius.lg,
  padding: Spacing.lg,
  marginTop: Spacing.md,
};

export const button: CSSProperties = {
  padding: `${Spacing.sm} ${Spacing.md}`,
  borderRadius: Radius.md,
  border: 'none',
  background: Colors.primary,
  color: Colors.text,
  cursor: 'pointer',
};

export const subtleButton: CSSProperties = {
  ...button,
  background: Colors.surfaceMuted,
  color: Colors.textMuted,
  border: `1px solid ${Colors.border}`,
};

export const input: CSSProperties = {
  padding: `${Spacing.sm} ${Spacing.md}`,
  borderRadius: Radius.md,
  border: `1px solid ${Colors.border}`,
  background: Colors.bg,
  color: Colors.text,
  width: '100%',
  boxSizing: 'border-box',
};

export const row: CSSProperties = {
  display: 'flex',
  gap: Spacing.sm,
  alignItems: 'center',
};
