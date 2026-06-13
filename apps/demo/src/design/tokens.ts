/**
 * The only place design values are defined. Change here -> reflects everywhere.
 * (Foundation skill Step 5: single source of truth for design tokens.)
 */

export const Colors = {
  bg: '#0b0d12',
  surface: '#151823',
  surfaceMuted: '#1d212e',
  border: '#2a2f3d',
  text: '#e6e9f0',
  textMuted: '#9aa3b2',
  primary: '#6366f1',
  primaryHover: '#7c7ff2',
  success: '#22c55e',
  danger: '#ef4444',
} as const;

export const Typography = {
  fontFamily:
    "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  fontSize: {
    xs: '12px',
    sm: '14px',
    md: '16px',
    lg: '20px',
    xl: '28px',
  },
  lineHeight: { tight: 1.2, normal: 1.5 },
  fontWeight: { regular: 400, medium: 500, semibold: 600, bold: 700 },
} as const;

/** 4px base unit. */
export const Spacing = {
  xs: '4px',
  sm: '8px',
  md: '16px',
  lg: '24px',
  xl: '40px',
} as const;

export const Radius = {
  sm: '6px',
  md: '10px',
  lg: '16px',
  xl: '24px',
  full: '9999px',
} as const;

export const Shadow = {
  sm: '0 1px 2px rgba(0,0,0,0.4)',
  md: '0 4px 12px rgba(0,0,0,0.45)',
  lg: '0 12px 32px rgba(0,0,0,0.5)',
  glow: `0 0 0 3px ${Colors.primary}33`,
} as const;
