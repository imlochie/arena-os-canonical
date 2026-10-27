/**
 * LUMA design tokens.
 *
 * A dark-first, photographic, minimal visual language. Kept as plain constants
 * (no theming library) so it is trivial to consume from both React components
 * and Skia render code, and cheap to import in tests.
 */

export const palette = {
  // Near-black backgrounds with a hint of warmth so photos feel "framed".
  bg0: '#0A0A0B', // deepest background (behind everything)
  bg1: '#121214', // primary surface
  bg2: '#1B1B1F', // raised surface / cards
  bg3: '#26262B', // controls / chips
  bg4: '#33333A', // pressed / active control

  hairline: 'rgba(255,255,255,0.08)',
  hairlineStrong: 'rgba(255,255,255,0.14)',

  text: '#F5F5F7',
  textDim: '#A8A8B0',
  textFaint: '#6E6E78',

  // A single restrained accent. Warm amber reads "photographic".
  accent: '#F5B843',
  accentDim: 'rgba(245,184,67,0.16)',

  danger: '#FF5A52',
  success: '#4ADE80',

  overlay: 'rgba(0,0,0,0.6)',
  scrim: 'rgba(0,0,0,0.35)',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  xl: 28,
  pill: 999,
} as const;

export const typography = {
  display: { fontSize: 30, fontWeight: '700' as const, letterSpacing: 0.2 },
  title: { fontSize: 20, fontWeight: '700' as const },
  heading: { fontSize: 17, fontWeight: '600' as const },
  body: { fontSize: 15, fontWeight: '500' as const },
  label: { fontSize: 13, fontWeight: '600' as const, letterSpacing: 0.3 },
  caption: { fontSize: 11, fontWeight: '600' as const, letterSpacing: 0.6 },
  mono: { fontSize: 12, fontWeight: '500' as const },
} as const;

export const timing = {
  fast: 120,
  base: 200,
  slow: 320,
} as const;

export const layout = {
  shutterSize: 74,
  tabBarHeight: 84,
  controlHeight: 44,
} as const;
