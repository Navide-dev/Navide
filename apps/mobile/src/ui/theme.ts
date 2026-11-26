import { useColorScheme } from 'react-native'
import type { PaneState } from '../types/pane.ts'

const light = {
  bg: '#f6f6f4',
  card: '#ffffff',
  text: '#1c1c1e',
  muted: '#6b6b70',
  border: '#e2e2de',
  accent: '#2f6fed',
  danger: '#c8382f',
  state: { busy: '#2f6fed', attention: '#d97706', idle: '#4b9e5f', offline: '#9a9aa0' } as Record<PaneState, string>,
}

const dark: typeof light = {
  bg: '#111113',
  card: '#1c1c1f',
  text: '#f2f2f4',
  muted: '#9a9aa2',
  border: '#2c2c31',
  accent: '#6b9bff',
  danger: '#ff6b5e',
  state: { busy: '#6b9bff', attention: '#fbbf24', idle: '#6fcf87', offline: '#7a7a82' },
}

export type Theme = typeof light

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light
}
