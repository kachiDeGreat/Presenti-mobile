/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#142748',
    background: '#f2f1ee',
    backgroundElement: '#ffffff',
    backgroundSelected: '#e5e7eb',
    textSecondary: '#52525b',
    border: '#e5e7eb',
    primary: '#142748',
    accent: '#2d81ff',
    error: '#d92d20',
    surface: '#ffffff',
  },
  dark: {
    // ArtCraft strictly specifies Light theme only; provide fallback matching high contrast
    text: '#142748',
    background: '#f2f1ee',
    backgroundElement: '#ffffff',
    backgroundSelected: '#e5e7eb',
    textSecondary: '#52525b',
    border: '#e5e7eb',
    primary: '#142748',
    accent: '#2d81ff',
    error: '#d92d20',
    surface: '#ffffff',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    sans: 'System',
    display: 'System',
    serif: 'ui-serif',
    rounded: 'ui-rounded',
    mono: 'ui-monospace',
  },
  android: {
    sans: 'sans-serif',
    display: 'sans-serif-medium',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  default: {
    sans: 'normal',
    display: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-sans)',
    display: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const ArtCraftTokens = {
  colors: {
    primary: '#142748',
    secondary: '#2d81ff',
    tertiary: '#f2f1ee',
    neutral: '#e5e7eb',
    surface: '#ffffff',
    surfaceAlt: '#f2f1ee',
    background: '#f2f1ee',
    text: '#142748',
    textMuted: '#52525b',
    border: '#e5e7eb',
    borderSecondary: 'rgba(20, 39, 72, 0.4)',
    accent: '#2d81ff',
    error: '#d92d20',
    success: '#059669',
  },
  radius: {
    none: 0,
    sm: 4,
    md: 8,
  },
};

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
