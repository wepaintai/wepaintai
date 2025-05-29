import { defineConfig } from '@tanstack/react-start/config'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
  },
})
