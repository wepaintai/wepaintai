import React from 'react'
import { authClient } from '../lib/auth-client'

export function ConvexTokenTest() {
  const [tokenResult, setTokenResult] = React.useState<any>(null)
  const [loading, setLoading] = React.useState(false)
  
  const fetchConvexToken = async () => {
    setLoading(true)
    console.log('[ConvexTokenTest] Fetching Convex token...')
    try {
      const result = await authClient.convex.token()
      console.log('[ConvexTokenTest] Token result:', result)
      setTokenResult(result)
    } catch (error) {
      console.error('[ConvexTokenTest] Token fetch error:', error)
      setTokenResult({ error: error.toString() })
    } finally {
      setLoading(false)
    }
  }
  
  return (
    <div style={{
      position: 'fixed',
      bottom: 10,
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
      <h3 style={{ margin: '0 0 10px 0', fontSize: '14px' }}>🔐 Convex Token Test</h3>
      
      <button
        onClick={fetchConvexToken}
        disabled={loading}
        style={{
          background: '#2196F3',
          color: 'white',
          border: 'none',
          padding: '5px 10px',
          borderRadius: '4px',
          cursor: loading ? 'wait' : 'pointer',
          fontSize: '12px',
          marginBottom: '10px'
        }}
      >
        {loading ? 'Fetching...' : 'Fetch Convex Token'}
      </button>
      
      {tokenResult && (
        <div>
          <strong>Token Result:</strong>
          <pre style={{ margin: '5px 0', whiteSpace: 'pre-wrap', fontSize: '10px' }}>
            {JSON.stringify(tokenResult, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}