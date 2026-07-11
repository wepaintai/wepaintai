import React, { useState, useEffect } from 'react'
import { useLocation } from '@tanstack/react-router'
import { Lock, AlertCircle } from 'lucide-react'

interface PasswordProtectionProps {
  children: React.ReactNode
}

// NOTE: This gate is friction-gating for early access, NOT security — the
// password ships in the client bundle and anyone can read it from the source.
const CORRECT_PASSWORD = 'renderatl'
const AUTH_STORAGE_KEY = 'wepaintai-auth'

// Auth-related paths must stay reachable without the gate: /login is where
// sign-in starts and /api/auth/* handles the OAuth callback round-trip.
const GATE_EXEMPT_PREFIXES = ['/login', '/sign-up', '/api/auth']

export function PasswordProtection({ children }: PasswordProtectionProps) {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const pathname = useLocation({ select: (location) => location.pathname })

  // Check if password protection is enabled via environment variable
  const isPasswordProtectionEnabled = import.meta.env.VITE_PASSWORD_PROTECTION_ENABLED === 'true'

  const isExemptPath = GATE_EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix))

  useEffect(() => {
    // If password protection is disabled, authenticate immediately
    if (!isPasswordProtectionEnabled) {
      setIsAuthenticated(true)
      setIsLoading(false)
      return
    }

    // Check if user is already authenticated (localStorage so the gate is
    // passed once per browser, not once per tab)
    const authStatus = localStorage.getItem(AUTH_STORAGE_KEY)
    if (authStatus === 'authenticated') {
      setIsAuthenticated(true)
    }
    setIsLoading(false)
  }, [isPasswordProtectionEnabled])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    if (password === CORRECT_PASSWORD) {
      localStorage.setItem(AUTH_STORAGE_KEY, 'authenticated')
      setIsAuthenticated(true)
      setError('')
    } else {
      setError('Incorrect password. Please try again.')
      setPassword('')
    }
  }

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value)
    if (error) {
      setError('')
    }
  }

  // Auth flow pages bypass the gate entirely
  if (isExemptPath) {
    return <>{children}</>
  }

  // Don't render anything while checking auth status
  if (isLoading) {
    return null
  }

  // If authenticated, render children
  if (isAuthenticated) {
    return <>{children}</>
  }

  // Otherwise, show password protection modal
  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50" />
      
      {/* Modal */}
      <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-8 relative">
          {/* Lock Icon */}
          <div className="flex justify-center mb-6">
            <div className="bg-blue-100 p-4 rounded-full">
              <Lock className="h-8 w-8 text-blue-600" />
            </div>
          </div>

          {/* Title */}
          <h1 className="text-2xl font-bold text-center text-gray-900 mb-2">
            Password Required
          </h1>
          <p className="text-gray-600 text-center mb-8">
            Please enter the password to access wePaintAI
          </p>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <input
                type="password"
                value={password}
                onChange={handlePasswordChange}
                placeholder="Enter password"
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                autoFocus
              />
            </div>

            {/* Error Message */}
            {error && (
              <div className="flex items-center gap-2 text-red-600 text-sm">
                <AlertCircle className="h-4 w-4" />
                <span>{error}</span>
              </div>
            )}

            {/* Submit Button */}
            <button
              type="submit"
              className="w-full bg-blue-600 text-white py-3 px-4 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-all font-medium"
            >
              Access App
            </button>
          </form>

          {/* Decorative Elements */}
          <div className="absolute -top-1 -left-1 w-20 h-20 bg-blue-100 rounded-full opacity-50 blur-xl" />
          <div className="absolute -bottom-1 -right-1 w-32 h-32 bg-purple-100 rounded-full opacity-50 blur-xl" />
        </div>
      </div>
    </>
  )
}