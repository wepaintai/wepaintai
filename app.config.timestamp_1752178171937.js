// app.config.ts
import { defineConfig } from "@tanstack/react-start/config";
import tailwindcss from "@tailwindcss/vite";
var app_config_default = defineConfig({
  server: {
    preset: "vercel"
  },
  vite: {
    plugins: [tailwindcss()],
    build: {
      cssCodeSplit: true,
      assetsInlineLimit: 0,
      // Force CSS to be a separate file
      rollupOptions: {
        output: {
          assetFileNames: "assets/[name]-[hash][extname]"
        }
      }
    }
  }
});
export {
  app_config_default as default
};
