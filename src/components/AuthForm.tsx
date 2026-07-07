import React from 'react'
import { Loader2 } from 'lucide-react'
import { authClient } from '../lib/auth-client'

interface AuthFormProps {
  mode: 'sign-in' | 'sign-up'
  onModeChange: (mode: 'sign-in' | 'sign-up') => void
  /** Called after a successful sign in/up. Defaults to a full page reload. */
  onSuccess?: () => void
  /** 'dark' matches the in-canvas modal, 'light' the standalone routes. */
  variant?: 'dark' | 'light'
}

export function AuthForm({ mode, onModeChange, onSuccess, variant = 'dark' }: AuthFormProps) {
  const [name, setName] = React.useState('')
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  const isDark = variant === 'dark'
  const labelClass = isDark ? 'text-white/80' : 'text-gray-700'
  const inputClass = isDark
    ? 'w-full px-3 py-2 rounded bg-white/10 border border-white/20 text-white placeholder-white/40 focus:outline-none focus:border-blue-400'
    : 'w-full px-3 py-2 rounded bg-white border border-gray-300 text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500'

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const result =
        mode === 'sign-in'
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({
              email,
              password,
              name: name.trim() || email.split('@')[0],
            })

      if (result.error) {
        setError(result.error.message || 'Something went wrong. Please try again.')
        return
      }

      if (onSuccess) {
        onSuccess()
      } else {
        // Full reload so server-fetched auth state is consistent
        window.location.href = '/'
      }
    } catch (err) {
      console.error('[AuthForm] Error:', err)
      setError('Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {mode === 'sign-up' && (
        <div>
          <label htmlFor="auth-name" className={`block text-sm mb-1 ${labelClass}`}>
            Name
          </label>
          <input
            id="auth-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            autoComplete="name"
            className={inputClass}
          />
        </div>
      )}

      <div>
        <label htmlFor="auth-email" className={`block text-sm mb-1 ${labelClass}`}>
          Email
        </label>
        <input
          id="auth-email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="auth-password" className={`block text-sm mb-1 ${labelClass}`}>
          Password
        </label>
        <input
          id="auth-password"
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={mode === 'sign-up' ? 'At least 8 characters' : 'Your password'}
          autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
          className={inputClass}
        />
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="w-full bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
        {mode === 'sign-in' ? 'Sign In' : 'Sign Up'}
      </button>

      <div className="text-center">
        <button
          type="button"
          onClick={() => onModeChange(mode === 'sign-in' ? 'sign-up' : 'sign-in')}
          className="text-blue-400 hover:text-blue-300 text-sm transition-colors"
        >
          {mode === 'sign-in'
            ? "Don't have an account? Sign up"
            : 'Already have an account? Sign in'}
        </button>
      </div>
    </form>
  )
}
