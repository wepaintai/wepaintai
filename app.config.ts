import { defineConfig } from '@tanstack/react-start/config'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  server: {
    preset: 'vercel',
  },
  vite: {
    plugins: [tailwindcss()],
    css: {
      postcss: './postcss.config.js',
    },
    build: {
      cssMinify: true,
    },
  },
})
