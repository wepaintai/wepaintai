declare global {
  interface Window {
    posthog?: typeof import('posthog-js').default
  }
}

export {}