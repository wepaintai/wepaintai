import React from 'react'
import { X, User } from 'lucide-react'
import { GoogleSignInButton } from './GoogleSignInButton'
import { authClient, useAuthState } from '../lib/auth-client'
import { clearCurrentGuestSession } from '../utils/guestKey'

interface AuthModalProps {
  isOpen: boolean
  onClose: () => void
}

export function AuthModal({ isOpen, onClose }: AuthModalProps) {
  const { isSignedIn, user } = useAuthState()

  const handleSignOut = async () => {
    await authClient.signOut()
    onClose()
    // Land on a fresh canvas: the current session may be private and
    // inaccessible once signed out, so drop any reference to it and do a
    // full navigation so all auth-dependent state is cleared
    clearCurrentGuestSession()
    const url = new URL(window.location.href)
    url.searchParams.delete('session')
    window.location.href = url.toString()
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-black/90 backdrop-blur-md border border-white/20 rounded-lg shadow-xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-white/20">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <User className="w-5 h-5" />
            {isSignedIn ? 'Account' : 'Sign In'}
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-white/20 rounded transition-colors"
            aria-label="Close modal"
          >
            <X className="w-5 h-5 text-white/60" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4">
          {isSignedIn ? (
            // Signed in state
            <div className="space-y-4">
              <div className="text-center">
                <div className="flex justify-center mb-3">
                  <div className="w-16 h-16 rounded-full bg-blue-500 flex items-center justify-center text-white text-2xl font-semibold">
                    {(user?.name || user?.email || 'U').charAt(0).toUpperCase()}
                  </div>
                </div>
                <h3 className="text-white font-medium">{user?.name || 'User'}</h3>
                <p className="text-white/60 text-sm">{user?.email}</p>
              </div>

              <button
                onClick={handleSignOut}
                className="w-full bg-red-500 hover:bg-red-600 text-white py-2 px-4 rounded transition-colors"
              >
                Sign Out
              </button>
            </div>
          ) : (
            <div className="py-2">
              <p className="text-white/60 text-sm text-center mb-4">
                Sign in with your Google account to save your work and use AI
                features.
              </p>
              <GoogleSignInButton callbackURL={typeof window !== 'undefined' ? window.location.href : '/'} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
