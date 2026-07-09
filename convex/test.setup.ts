/// <reference types="vite/client" />

export const modules = import.meta.glob(['./**/*.{js,ts}', '!./**/*.test.ts', '!./test.setup.ts'])
