/// <reference types="vite/client" />
import { hydrateRoot } from 'react-dom/client'
import { StartClient } from '@tanstack/react-start'
import { createRouter } from './router'
import posthog from 'posthog-js'

// Initialize PostHog
posthog.init('phc_8N6NYge8Eb6D0k8xJ1HRvNFSGGgbgUBONvnDGO3PIMQ', {
  api_host: 'https://us.i.posthog.com',
  person_profiles: 'identified_only' // or 'always' to create profiles for anonymous users as well
})

const router = createRouter()

hydrateRoot(document, <StartClient router={router} />)

