import { createFileRoute, useNavigate } from '@tanstack/react-router'
import React from 'react'
import { AuthForm } from '../components/AuthForm'

export const Route = createFileRoute('/login')({
  component: LoginComponent,
})

function LoginComponent() {
  const navigate = useNavigate()
  const [mode, setMode] = React.useState<'sign-in' | 'sign-up'>('sign-in')

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="w-full max-w-md bg-white rounded-lg shadow-xl p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6 text-center">
          {mode === 'sign-in' ? 'Sign in to wePaintAI' : 'Create your account'}
        </h1>
        <AuthForm
          mode={mode}
          onModeChange={(m) => {
            setMode(m)
            navigate({ to: m === 'sign-in' ? '/login' : '/sign-up' })
          }}
          variant="light"
        />
      </div>
    </div>
  )
}
