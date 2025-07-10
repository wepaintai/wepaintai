import { defineConfig } from '@tanstack/react-start/config'
import tailwindcss from '@tailwindcss/vite'
import { clerkPlugin } from '@clerk/tanstack-start/plugin'

export default defineConfig({
  server: {
    preset: 'vercel',
  },
  vite: {
    plugins: [
      tailwindcss(),
      clerkPlugin({
        publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY,
      }),
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
  },
})
