import { useState } from 'react';
import { Colors, Radius, Spacing } from '../design/tokens.js';
import { TestId } from '../constants/index.js';

/**
 * Color changes on hover via JS state (not CSS :hover), so the change is observable in the
 * DOM/computed style — see how Iris verifies it in the real-world tests.
 */
export function HoverButton() {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      data-testid={TestId.HOVER_BUTTON}
      data-hovered={hovered ? 'true' : 'false'}
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={() => {
        setHovered(false);
      }}
      style={{
        padding: `${Spacing.sm} ${Spacing.md}`,
        borderRadius: Radius.md,
        border: 'none',
        cursor: 'pointer',
        color: Colors.text,
        background: hovered ? Colors.success : Colors.primary,
        transition: 'background 150ms ease',
      }}
    >
      {hovered ? 'Hovering!' : 'Hover me'}
    </button>
  );
}
