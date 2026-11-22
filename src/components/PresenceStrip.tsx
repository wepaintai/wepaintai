import React from 'react'
import { Id } from '../../convex/_generated/dataModel'
import type { UserPresence } from '../hooks/usePaintingSession'
import type { ConnectionStatus } from '../hooks/useConnectionStatus'

interface PresenceStripProps {
  presence: UserPresence[]
  currentUser: {
    id: Id<'users'> | null
    name: string
    color: string
  }
  /** Stable client id identifying this browser when the user is a guest */
  presenceGuestId?: string
  connectionStatus: ConnectionStatus
}

// Presence records older than this are treated as gone (the server already
// filters at 5 minutes; this keeps the strip snappier).
const ACTIVE_WINDOW_MS = 2 * 60 * 1000

function initialOf(name: string): string {
  const trimmed = name.trim()
  return trimmed ? trimmed[0].toUpperCase() : '?'
}

/**
 * Presence rows for everyone but the current user, deduped by identity
 * (userId, guestId, or record id as fallback) and limited to recently-active
 * records. Shared so every online count in the UI agrees with the strip.
 */
export function activeCollaborators(
  presence: UserPresence[],
  currentUserId: Id<'users'> | null,
  presenceGuestId?: string
): UserPresence[] {
  const now = Date.now()
  const isSelf = (p: UserPresence) =>
    currentUserId ? p.userId === currentUserId : !!presenceGuestId && p.guestId === presenceGuestId
  const seen = new Set<string>()
  return presence.filter((p) => {
    if (isSelf(p)) return false
    if (now - p.lastSeen > ACTIVE_WINDOW_MS) return false
    const key = p.userId?.toString() || p.guestId || p._id.toString()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function PresenceStrip({ presence, currentUser, presenceGuestId, connectionStatus }: PresenceStripProps) {
  const collaborators = activeCollaborators(presence, currentUser.id, presenceGuestId)

  const onlineCount = collaborators.length + 1
  const maxDots = 5
  const shownCollaborators = collaborators.slice(0, maxDots)
  const overflow = collaborators.length - shownCollaborators.length

  const connectionLabel =
    connectionStatus === 'connected' ? 'Connected' : connectionStatus === 'reconnecting' ? 'Reconnecting…' : 'Offline'

  return (
    <div
      className="absolute top-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-white/90 backdrop-blur-sm rounded-full shadow px-2.5 py-1.5 text-xs text-gray-700 select-none"
      role="status"
      aria-label={`${onlineCount} ${onlineCount === 1 ? 'person' : 'people'} online. ${connectionLabel}`}
    >
      {/* Connection indicator */}
      {connectionStatus === 'connected' ? (
        <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" title="Connected" aria-hidden="true" />
      ) : (
        <span
          className={`flex items-center gap-1 shrink-0 font-medium ${
            connectionStatus === 'reconnecting' ? 'text-amber-600' : 'text-red-600'
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              connectionStatus === 'reconnecting' ? 'bg-amber-500 animate-pulse' : 'bg-red-500'
            }`}
            aria-hidden="true"
          />
          {connectionLabel}
        </span>
      )}

      {/* Collaborator dots (self first) */}
      <div className="flex items-center -space-x-1.5" aria-hidden="true">
        <span
          className="w-5 h-5 rounded-full ring-2 ring-white flex items-center justify-center text-[9px] font-bold text-white"
          style={{ backgroundColor: currentUser.color }}
          title={`${currentUser.name} (you)`}
        >
          {initialOf(currentUser.name)}
        </span>
        {shownCollaborators.map((p) => (
          <span
            key={p._id}
            className="w-5 h-5 rounded-full ring-2 ring-white flex items-center justify-center text-[9px] font-bold text-white"
            style={{ backgroundColor: p.userColor }}
            title={p.userName}
          >
            {initialOf(p.userName)}
          </span>
        ))}
        {overflow > 0 && (
          <span className="w-5 h-5 rounded-full ring-2 ring-white bg-gray-400 flex items-center justify-center text-[9px] font-bold text-white">
            +{overflow}
          </span>
        )}
      </div>

      <span className="text-gray-600 whitespace-nowrap">
        {onlineCount} online
      </span>
    </div>
  )
}
