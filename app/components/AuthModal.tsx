import React from 'react'
import { X, User } from 'lucide-react'
import { SignIn, SignUp, UserButton, useUser, useClerk } from '@clerk/clerk-react'

interface AuthModalProps {
  isOpen: boolean
  onClose: () => void
}

export function AuthModal({ isOpen, onClose }: AuthModalProps) {
  const [isLogin, setIsLogin] = React.useState(true)
  const { isSignedIn, user } = useUser()
  const { signOut } = useClerk()

  const handleSignOut = async () => {
    await signOut()
    onClose()
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
            {isSignedIn ? 'Account' : isLogin ? 'Sign In' : 'Sign Up'}
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
                  <UserButton 
                    appearance={{
                      elements: {
                        rootBox: "w-16 h-16",
                        avatarBox: "w-16 h-16"
                      }
                    }}
                  />
                </div>
                <h3 className="text-white font-medium">{user?.fullName || user?.username || 'User'}</h3>
                <p className="text-white/60 text-sm">{user?.primaryEmailAddress?.emailAddress}</p>
              </div>
              
              <button
                onClick={handleSignOut}
                className="w-full bg-red-500 hover:bg-red-600 text-white py-2 px-4 rounded transition-colors"
              >
                Sign Out
              </button>
            </div>
          ) : (
            // Sign in/up form
            <div className="clerk-auth-container">
              {isLogin ? (
                <SignIn 
                  appearance={{
                    elements: {
                      rootBox: "mx-auto",
                      card: "bg-transparent shadow-none",
                      formButtonPrimary: "bg-blue-500 hover:bg-blue-600",
                      footerActionLink: "text-blue-400 hover:text-blue-300"
                    }
                  }}
                  routing="virtual"
                  afterSignInUrl={window.location.href}
                />
              ) : (
                <SignUp
                  appearance={{
                    elements: {
                      rootBox: "mx-auto",
                      card: "bg-transparent shadow-none",
                      formButtonPrimary: "bg-blue-500 hover:bg-blue-600",
                      footerActionLink: "text-blue-400 hover:text-blue-300"
                    }
                  }}
                  routing="virtual"
                  afterSignUpUrl={window.location.href}
                />
              )}
              
              <div className="text-center mt-4">
                <button
                  type="button"
                  onClick={() => setIsLogin(!isLogin)}
                  className="text-blue-400 hover:text-blue-300 text-sm transition-colors"
                >
                  {isLogin ? "Don't have an account? Sign up" : "Already have an account? Sign in"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}