import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { authClient } from '../lib/auth-client'
import { useEffect } from 'react'
import { debugGetSession, checkSessionEndpoint } from '../lib/auth-client-debug'

export function AuthTest() {
  const user = useQuery(api.auth.getCurrentUser)
  const { data: session } = authClient.useSession()
  
  // Test the convex token method
  useEffect(() => {
    console.log('[AuthTest] authClient.convex exists?', !!authClient.convex)
    console.log('[AuthTest] authClient methods:', Object.keys(authClient))
    
    if (session && authClient.convex) {
      console.log('[AuthTest] Testing authClient.convex.token()...')
      authClient.convex.token().then(result => {
        console.log('[AuthTest] Token result:', result)
      }).catch(error => {
        console.error('[AuthTest] Token error:', error)
      })
    } else if (session) {
      console.log('[AuthTest] Session exists but authClient.convex is not available')
    }
    
    // Run debug utilities
    console.log('[AuthTest] Running debug utilities...')
    debugGetSession().catch(console.error)
    checkSessionEndpoint().catch(console.error)
  }, [session])
  
  useEffect(() => {
    console.log('[AuthTest] Current user from Convex:', user)
    console.log('[AuthTest] Session from Better Auth:', session)
    
    // Check localStorage for tokens
    const keys = Object.keys(localStorage).filter(k => 
      k.includes('convex') || k.includes('auth') || k.includes('JWT')
    )
    console.log('[AuthTest] Auth-related localStorage keys:', keys)
    keys.forEach(key => {
      const value = localStorage.getItem(key)
      if (value && value.length > 100) {
        console.log(`[AuthTest] ${key}: [token of length ${value.length}]`)
      } else {
        console.log(`[AuthTest] ${key}:`, value)
      }
    })
  }, [user, session])
  
  return (
    <div className="fixed bottom-4 left-4 bg-white p-4 rounded shadow-lg z-50 text-sm">
      <h3 className="font-bold mb-2">Auth Debug</h3>
      <div>Better Auth Session: {session ? '✓' : '✗'}</div>
      <div>Convex User: {user ? '✓' : '✗'}</div>
      {session && (
        <div className="mt-2 text-xs">
          <div>User: {session.user.email}</div>
          <div>Session ID: {session.session.id.substring(0, 10)}...</div>
        </div>
      )}
      {user && (
        <div className="mt-2 text-xs">
          <div>Convex ID: {user.id?.substring(0, 10)}...</div>
        </div>
      )}
      <div className="mt-3 space-y-2">
        <button
          onClick={async () => {
            console.log('Manual getSession test...');
            const result = await authClient.getSession();
            console.log('Manual getSession result:', result);
          }}
          className="bg-blue-500 text-white px-2 py-1 rounded text-xs"
        >
          Test getSession
        </button>
        <button
          onClick={() => window.location.reload()}
          className="bg-gray-500 text-white px-2 py-1 rounded text-xs ml-2"
        >
          Reload
        </button>
      </div>
    </div>
  )
}