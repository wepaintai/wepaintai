import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { authClient } from '../lib/auth-client'
import { clearCurrentGuestSession } from '../utils/guestKey'

export function UserProfile() {
  const user = useQuery(api.auth.getCurrentUser)

  const handleLogout = async () => {
    await authClient.signOut()
    // Land on a fresh canvas with all auth-dependent state cleared; the
    // current session may be private and inaccessible once signed out
    clearCurrentGuestSession()
    window.location.href = '/'
  }

  if (!user) return null

  return (
    <div className="absolute top-4 right-4 bg-white rounded-lg shadow-md p-4 z-50">
      <div className="flex items-center gap-3">
        <div>
          <p className="font-medium text-gray-900">{user.name}</p>
          <p className="text-sm text-gray-500">{user.email}</p>
        </div>
        <button
          onClick={handleLogout}
          className="px-3 py-1 text-sm bg-gray-200 hover:bg-gray-300 rounded-md transition-colors"
        >
          Logout
        </button>
      </div>
    </div>
  )
}