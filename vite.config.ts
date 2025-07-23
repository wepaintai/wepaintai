import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    tanstackStart({
      server: {
        preset: 'vercel',
      },
    }),
    tailwindcss(),
  ],
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