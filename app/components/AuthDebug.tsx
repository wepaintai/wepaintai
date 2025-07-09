import React from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { authClient, debugAuthState } from '../lib/auth-client'

console.log('[AuthDebug Component] Loading...');

export function AuthDebug() {
  console.log('[AuthDebug Component] Rendering...');
  const { data: session, isPending: sessionPending } = authClient.useSession()
  const currentUser = useQuery(api.auth.getCurrentUser)
  
  // Test direct session fetch
  React.useEffect(() => {
    console.log('[AuthDebug] Testing direct session fetch...');
    fetch('https://actions.wepaint.ai/api/auth/session', {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      }
    })
    .then(res => {
      console.log('[AuthDebug] Session response status:', res.status);
      return res.json();
    })
    .then(data => {
      console.log('[AuthDebug] Session response data:', data);
    })
    .catch(err => {
      console.error('[AuthDebug] Session fetch error:', err);
    });
  }, [])
  
  // Monitor network requests
  React.useEffect(() => {
    const originalFetch = window.fetch
    window.fetch = async (...args) => {
      const [url, options] = args
      
      // Log Convex requests
      if (typeof url === 'string' && url.includes('convex')) {
        console.log('[Network Debug] Convex Request:', {
          url,
          method: options?.method || 'GET',
          headers: options?.headers,
          hasBody: !!options?.body
        })
      }
      
      const response = await originalFetch(...args)
      
      // Log response status
      if (typeof url === 'string' && url.includes('convex')) {
        console.log('[Network Debug] Convex Response:', {
          url,
          status: response.status,
          ok: response.ok
        })
      }
      
      return response
    }
    
    return () => {
      window.fetch = originalFetch
    }
  }, [])
  
  return (
    <div style={{
      position: 'fixed',
      top: 10,
      right: 10,
      background: 'rgba(0, 0, 0, 0.9)',
      color: 'white',
      padding: '15px',
      borderRadius: '8px',
      fontSize: '12px',
      maxWidth: '400px',
      zIndex: 9999,
      fontFamily: 'monospace'
    }}>
      <h3 style={{ margin: '0 0 10px 0', fontSize: '14px' }}>🔍 Auth Debug Panel</h3>
      
      <div style={{ marginBottom: '10px' }}>
        <strong>Window Origin:</strong>
        <pre style={{ margin: '5px 0', whiteSpace: 'pre-wrap' }}>
          {typeof window !== 'undefined' ? window.location.origin : 'N/A'}
        </pre>
      </div>
      
      <div style={{ marginBottom: '10px' }}>
        <strong>Client Session:</strong>
        <pre style={{ margin: '5px 0', whiteSpace: 'pre-wrap' }}>
          {sessionPending ? 'Loading...' : JSON.stringify(session, null, 2)}
        </pre>
      </div>
      
      <div style={{ marginBottom: '10px' }}>
        <strong>Convex User Query:</strong>
        <pre style={{ margin: '5px 0', whiteSpace: 'pre-wrap' }}>
          {currentUser === undefined ? 'Loading...' : JSON.stringify(currentUser, null, 2)}
        </pre>
      </div>
      
      <div style={{ marginBottom: '10px' }}>
        <strong>LocalStorage Tokens:</strong>
        <pre style={{ margin: '5px 0', whiteSpace: 'pre-wrap', fontSize: '10px' }}>
          {Object.keys(localStorage)
            .filter(k => k.includes('convex'))
            .map(k => `${k}: ${localStorage.getItem(k)?.substring(0, 30)}...`)
            .join('\n')}
        </pre>
      </div>
      
      <button
        onClick={() => {
          console.log('=== Full Auth State Debug ===')
          console.log('Window Origin:', window.location.origin)
          console.log('Session:', session)
          console.log('Convex User:', currentUser)
          console.log('LocalStorage:', Object.keys(localStorage).filter(k => k.includes('convex')))
          debugAuthState()
        }}
        style={{
          background: '#4CAF50',
          color: 'white',
          border: 'none',
          padding: '5px 10px',
          borderRadius: '4px',
          cursor: 'pointer',
          fontSize: '12px'
        }}
      >
        Log Full Debug Info
      </button>
    </div>
  )
}
