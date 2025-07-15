import React, { useState } from 'react'
import { Copy, Users, Share2 } from 'lucide-react'
import { Id } from '../../convex/_generated/dataModel'

interface SessionInfoProps {
  sessionId: Id<"paintingSessions"> | null
  userCount: number
  currentUser: {
    name: string
    color: string
  }
}

export function SessionInfo({ sessionId, userCount, currentUser }: SessionInfoProps) {
  const [copied, setCopied] = useState(false)

  const handleCopySessionId = async () => {
    if (!sessionId) return
    
    const url = `${window.location.origin}?session=${sessionId}`
    await navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!sessionId) return null

  return (
    <div className="absolute top-4 left-4 bg-white rounded-lg shadow-lg p-4 max-w-sm">
      <div className="flex items-center gap-2 mb-3">
        <div 
          className="w-4 h-4 rounded-full" 
          style={{ backgroundColor: currentUser.color }}
        />
        <span className="font-medium text-sm">{currentUser.name}</span>
      </div>
      
      <div className="flex items-center gap-2 mb-2">
        <Users className="w-4 h-4 text-gray-500" />
        <span className="text-sm text-gray-600">
          {userCount} user{userCount !== 1 ? 's' : ''} online
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Share2 className="w-4 h-4 text-gray-500" />
        <button
          onClick={handleCopySessionId}
          className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700 transition-colors"
        >
          <Copy className="w-3 h-3" />
          {copied ? 'Copied!' : 'Share session'}
        </button>
      </div>

      <div className="mt-2 text-xs text-gray-500 font-mono bg-gray-50 p-2 rounded">
        Session: {sessionId.slice(-8)}
      </div>
    </div>
  )
}
