import { createFileRoute } from '@tanstack/react-router'
import { GoogleSignInButton } from '../components/GoogleSignInButton'

export const Route = createFileRoute('/login')({
  component: LoginComponent,
})

function LoginComponent() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="w-full max-w-md bg-white rounded-lg shadow-xl p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-2 text-center">
          Sign in to wePaintAI
        </h1>
        <p className="text-sm text-gray-500 text-center mb-6">
          New here? Signing in with Google creates your account automatically.
        </p>
        <GoogleSignInButton callbackURL="/" />
      </div>
    </div>
  )
}
