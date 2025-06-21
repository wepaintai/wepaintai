import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { authClient } from '../lib/auth-client'
import { useRouter } from '@tanstack/react-router'

export function UserProfile() {
  const user = useQuery(api.auth.getCurrentUser)
  const router = useRouter()

  const handleLogout = async () => {
    await authClient.signOut()
    // Force a full page reload to ensure auth state is cleared
    window.location.href = '/login'
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