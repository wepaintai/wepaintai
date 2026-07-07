import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tanstackStart(), nitro(), viteReact(), tailwindcss()],
  ssr: {
    // Required by @convex-dev/better-auth for TanStack Start SSR
    noExternal: ['@convex-dev/better-auth'],
  },
  build: {
    cssCodeSplit: true,
    assetsInlineLimit: 0, // Force CSS to be a separate file
    rollupOptions: {
      output: {
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
