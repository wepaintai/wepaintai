import React from 'react'
import { X, Clock, Trash2 } from 'lucide-react'
import {
  getRecentGuestSessions,
  removeRecentGuestSession,
  RecentGuestSession,
} from '../utils/guestKey'

interface GuestRecentModalProps {
  isOpen: boolean
  onClose: () => void
}

/**
 * Lightweight "Recent" list for guests, who have no server-side Library.
 * Reads the localStorage list of sessions this browser opened as a guest
 * so yesterday's painting is reachable after starting a new canvas.
 */
export function GuestRecentModal({ isOpen, onClose }: GuestRecentModalProps) {
  const [sessions, setSessions] = React.useState<RecentGuestSession[]>([])

  React.useEffect(() => {
    if (isOpen) setSessions(getRecentGuestSessions())
  }, [isOpen])

  if (!isOpen) return null

  const handleOpen = (sessionId: string) => {
    window.location.href = `/?session=${sessionId}`
    onClose()
  }

  const handleRemove = (sessionId: string) => {
    removeRecentGuestSession(sessionId)
    setSessions(getRecentGuestSessions())
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-black/90 backdrop-blur-md border border-white/20 rounded-lg shadow-xl w-full max-w-md max-h-[70vh] mx-4 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-white/20">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Clock className="w-5 h-5" />
            Recent Paintings
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-white/20 rounded transition-colors"
            aria-label="Close modal"
          >
            <X className="w-5 h-5 text-white/60" />
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-2">
          {sessions.length === 0 ? (
            <div className="text-center py-8 text-white/70 text-sm px-4">
              No recent paintings on this device yet. Paintings you open as a
              guest will show up here.
            </div>
          ) : (
            <ul>
              {sessions.map((entry) => (
                <li key={entry.sessionId} className="group flex items-center gap-2">
                  <button
                    onClick={() => handleOpen(entry.sessionId)}
                    className="flex-1 min-w-0 text-left px-3 py-2 hover:bg-white/10 rounded transition-colors"
                  >
                    <div className="text-sm text-white/80 truncate">
                      {entry.name || 'Untitled'}
                    </div>
                    <div className="text-xs text-white/70">
                      {new Date(entry.lastOpened).toLocaleString()}
                    </div>
                  </button>
                  <button
                    onClick={() => handleRemove(entry.sessionId)}
                    className="p-3.5 mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 hover:bg-white/20 rounded transition-all"
                    title="Remove from list"
                    aria-label={`Remove ${entry.name || 'Untitled'} from list`}
                  >
                    <Trash2 className="w-3.5 h-3.5 text-white/70" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer note */}
        <div className="p-3 border-t border-white/10 text-xs text-white/70">
          Saved on this device only. Sign in to keep your paintings in a
          library that follows you everywhere.
        </div>
      </div>
    </div>
  )
}
