declare global {
  interface Window {
    posthog?: typeof import('posthog-js').default;
  }

  interface ImportMetaEnv {
    readonly VITE_CONVEX_URL: string;
    readonly VITE_AUTH_DISABLED?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export {};
