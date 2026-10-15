export const FRONTEND_ONLY: string[]
export const FRONTEND_SHARED: string[]
export const BACKEND_ONLY: string[]
export const BACKEND_SHARED: string[]

export function isFrontendOnly(file: string): boolean
export function isBackendOnly(file: string): boolean
export function scopes(input: { event: string; files: string[] | null }): { backend: boolean; frontend: boolean }
