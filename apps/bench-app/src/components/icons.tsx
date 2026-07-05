import type { CSSProperties } from 'react';

interface IconProps {
  d: string;
  size?: number;
  style?: CSSProperties;
  className?: string;
}

/** Minimal stroke-icon (1.6 weight, rounded) — one component, many paths. */
function Icon({ d, size = 18, style, className }: IconProps): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      className={className}
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

export const IconGrid = (p: Omit<IconProps, 'd'>) => (
  <Icon {...p} d="M4 4h7v7H4zM13 4h7v7h-7zM13 13h7v7h-7zM4 13h7v7H4z" />
);
export const IconRocket = (p: Omit<IconProps, 'd'>) => (
  <Icon
    {...p}
    d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M9 11a6 6 0 0 1 9-6 6 6 0 0 1-6 9l-3 3-3-3zM15 9h.01"
  />
);
export const IconSparkles = (p: Omit<IconProps, 'd'>) => (
  <Icon
    {...p}
    d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6zM19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z"
  />
);
export const IconBug = (p: Omit<IconProps, 'd'>) => (
  <Icon
    {...p}
    d="M8 9a4 4 0 0 1 8 0v3a4 4 0 0 1-8 0zM5 9h3M16 9h3M5 14H3M21 14h-2M5 19l3-2M19 19l-3-2M9 5L7 3M15 5l2-2"
  />
);
export const IconSearch = (p: Omit<IconProps, 'd'>) => (
  <Icon {...p} d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3" />
);
export const IconPlus = (p: Omit<IconProps, 'd'>) => <Icon {...p} d="M12 5v14M5 12h14" />;
export const IconDots = (p: Omit<IconProps, 'd'>) => (
  <Icon {...p} d="M12 6h.01M12 12h.01M12 18h.01" />
);
export const IconChevron = (p: Omit<IconProps, 'd'>) => <Icon {...p} d="M6 9l6 6 6-6" />;
export const IconX = (p: Omit<IconProps, 'd'>) => <Icon {...p} d="M6 6l12 12M18 6L6 18" />;
export const IconDrag = (p: Omit<IconProps, 'd'>) => (
  <Icon {...p} d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" />
);
export const IconBolt = (p: Omit<IconProps, 'd'>) => <Icon {...p} d="M13 2L4 14h6l-1 8 9-12h-6z" />;
export const IconCheck = (p: Omit<IconProps, 'd'>) => <Icon {...p} d="M20 6L9 17l-5-5" />;
export const IconArrow = (p: Omit<IconProps, 'd'>) => <Icon {...p} d="M5 12h14M13 6l6 6-6 6" />;
export const IconGit = (p: Omit<IconProps, 'd'>) => (
  <Icon
    {...p}
    d="M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9c0 3-3 4-6 4"
  />
);
