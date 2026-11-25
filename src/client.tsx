import { startTransition } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { StartClient } from '@tanstack/react-start/client'
import posthog from 'posthog-js'
import { consumeEditKeyFromWindowUrl } from './utils/guestKey'
import { scrubAnalyticsEvent } from './lib/analyticsPrivacy'

// Move any collaboration edit token (#edit=<token>) out of the address bar
// into sessionStorage BEFORE analytics start: PostHog reads window.location at
// init for $current_url / $session_entry_url / $initial_person_info.
consumeEditKeyFromWindowUrl()

// Initialize PostHog
posthog.init('phc_8N6NYge8Eb6D0k8xJ1HRvNFSGGgbgUBONvnDGO3PIMQ', {
  api_host: 'https://us.i.posthog.com',
  person_profiles: 'identified_only', // or 'always' to create profiles for anonymous users as well
  // Defense in depth: never record URL fragments, and strip any fragment or
  // edit= parameter from every URL-shaped event/person property.
  disable_capture_url_hashes: true,
  before_send: scrubAnalyticsEvent,
})

startTransition(() => {
  hydrateRoot(document, <StartClient />)
})
