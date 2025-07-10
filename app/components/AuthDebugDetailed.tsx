import React, { useEffect, useState } from 'react'
import { useConvexAuth } from 'convex/react'
import { authClient } from '../lib/auth-client'

export function AuthDebugDetailed() {
  const { isAuthenticated: convexAuth, isLoading: convexLoading } = useConvexAuth()
  const [debugInfo, setDebugInfo] = useState<any>({})
  const [isDebugging, setIsDebugging] = useState(false)

  const runDebug = async () => {
    setIsDebugging(true)
    const info: any = {}

    try {
      // 1. Check Better Auth session
      console.log('=== AUTH DEBUG DETAILED ===')
      console.log('1. Checking Better Auth session...')
      const session = await authClient.getSession()
      info.betterAuthSession = session
      console.log('Better Auth session:', session)

      // 2. Check localStorage for Convex tokens
      console.log('2. Checking localStorage...')
      const convexUrl = import.meta.env.VITE_CONVEX_URL
      const storageKey = `convex-auth:${convexUrl}`
      const storedToken = localStorage.getItem(storageKey)
      info.localStorage = {
        convexUrl,
        storageKey,
        hasToken: !!storedToken,
        token: storedToken ? JSON.parse(storedToken) : null
      }
      console.log('LocalStorage info:', info.localStorage)

      // 3. Check all auth-related localStorage keys
      const allAuthKeys = Object.keys(localStorage).filter(k => 
        k.includes('convex') || k.includes('auth') || k.includes('better')
      )
      info.allAuthKeys = allAuthKeys.map(k => ({
        key: k,
        value: localStorage.getItem(k)?.substring(0, 50) + '...'
      }))
      console.log('All auth keys:', info.allAuthKeys)

      // 4. Try to fetch Convex token manually
      console.log('3. Attempting to fetch Convex token...')
      try {
        const tokenResponse = await fetch('https://actions.wepaint.ai/api/auth/convex/token', {
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          }
        })
        
        info.tokenFetch = {
          status: tokenResponse.status,
          statusText: tokenResponse.statusText,
          headers: Object.fromEntries(tokenResponse.headers.entries())
        }
        
        const responseText = await tokenResponse.text()
        try {
          info.tokenFetch.data = JSON.parse(responseText)
        } catch {
          info.tokenFetch.data = responseText
        }
        
        console.log('Token fetch result:', info.tokenFetch)
      } catch (e) {
        info.tokenFetch = { error: e.message }
        console.error('Token fetch error:', e)
      }

      // 5. Check environment variables
      info.environment = {
        VITE_CONVEX_URL: import.meta.env.VITE_CONVEX_URL,
        VITE_CONVEX_SITE_URL: import.meta.env.VITE_CONVEX_SITE_URL,
        VITE_AUTH_DISABLED: import.meta.env.VITE_AUTH_DISABLED,
        origin: window.location.origin
      }
      console.log('Environment:', info.environment)

      // 6. Check Convex auth state
      info.convexState = {
        isAuthenticated: convexAuth,
        isLoading: convexLoading
      }
      console.log('Convex state:', info.convexState)

    } catch (error) {
      info.error = error.message
      console.error('Debug error:', error)
    }

    setDebugInfo(info)
    setIsDebugging(false)
  }

  // Run debug on mount
  useEffect(() => {
    runDebug()
  }, [])

  return (
    <div style={{
      position: 'fixed',
      bottom: 10,
      right: 10,
      background: 'rgba(0, 0, 0, 0.95)',
      color: '#0f0',
      padding: '20px',
      borderRadius: '8px',
      fontSize: '11px',
      maxWidth: '600px',
      maxHeight: '80vh',
      overflow: 'auto',
      zIndex: 9999,
      fontFamily: 'monospace',
      border: '1px solid #0f0'
    }}>
      <h3 style={{ margin: '0 0 10px 0', fontSize: '14px', color: '#0f0' }}>
        🔍 Auth Debug Detailed
      </h3>
      
      <button
        onClick={runDebug}
        disabled={isDebugging}
        style={{
          background: '#0f0',
          color: '#000',
          border: 'none',
          padding: '5px 10px',
          borderRadius: '4px',
          cursor: 'pointer',
          fontSize: '11px',
          marginBottom: '10px'
        }}
      >
        {isDebugging ? 'Debugging...' : 'Refresh Debug Info'}
      </button>

      <pre style={{ 
        margin: 0, 
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        color: '#0f0'
      }}>
        {JSON.stringify(debugInfo, null, 2)}
      </pre>
    </div>
  )
}