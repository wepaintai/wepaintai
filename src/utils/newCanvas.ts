import { clearCurrentGuestSession } from './guestKey'

// Leave the current session behind: drop any stored guest session and do a
// full navigation without the session param so a fresh painting is created.
export function startNewCanvas() {
  clearCurrentGuestSession()
  const url = new URL(window.location.href)
  url.searchParams.delete('session')
  window.location.href = url.toString()
}
