import React from 'react'
import { X, Plus, Search, Trash2, Edit2, Image as ImageIcon, Loader2 } from 'lucide-react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { Id } from '../../convex/_generated/dataModel'
import { useNavigate } from '@tanstack/react-router'

interface LibraryModalProps {
  isOpen: boolean
  onClose: () => void
  onCreateNew: () => void
}

interface SessionWithThumbnail {
  _id: Id<"paintingSessions">
  _creationTime: number
  name?: string
  thumbnailUrl?: string
  lastModified?: number
  strokeCounter: number
}

export function LibraryModal({ isOpen, onClose, onCreateNew }: LibraryModalProps) {
  const navigate = useNavigate()
  const [searchQuery, setSearchQuery] = React.useState('')
  const [editingSessionId, setEditingSessionId] = React.useState<Id<"paintingSessions"> | null>(null)
  const [editingName, setEditingName] = React.useState('')
  const [deletingSessionId, setDeletingSessionId] = React.useState<Id<"paintingSessions"> | null>(null)

  const sessions = useQuery(api.paintingSessions.getUserSessions) ?? []
  const updateSessionName = useMutation(api.paintingSessions.updateSessionName)
  const deleteSession = useMutation(api.paintingSessions.deleteSession)
  
  // Debug info - Hidden
  // const debugInfo = useQuery(api.debug.debugUserSessions)
  // const claimOrphaned = useMutation(api.debug.claimOrphanedSessions)
  const createTestSession = useMutation(api.paintingSessions.createSession)

  const filteredSessions = sessions.filter((session: SessionWithThumbnail) => {
    const name = session.name || 'Untitled'
    return name.toLowerCase().includes(searchQuery.toLowerCase())
  })

  const handleOpenSession = (sessionId: Id<"paintingSessions">) => {
    // Use window.location to force a full page navigation
    window.location.href = `/?session=${sessionId}`
    onClose()
  }

  const handleStartEdit = (session: SessionWithThumbnail) => {
    setEditingSessionId(session._id)
    setEditingName(session.name || 'Untitled')
  }

  const handleSaveEdit = async () => {
    if (editingSessionId && editingName.trim()) {
      await updateSessionName({
        sessionId: editingSessionId,
        name: editingName.trim()
      })
      setEditingSessionId(null)
      setEditingName('')
    }
  }

  const handleCancelEdit = () => {
    setEditingSessionId(null)
    setEditingName('')
  }

  const handleDelete = async (sessionId: Id<"paintingSessions">) => {
    if (deletingSessionId === sessionId) {
      // Confirm delete
      await deleteSession({ sessionId })
      setDeletingSessionId(null)
    } else {
      // First click - set as pending delete
      setDeletingSessionId(sessionId)
      // Reset after 3 seconds
      setTimeout(() => setDeletingSessionId(null), 3000)
    }
  }

  const handleCreateNew = async () => {
    try {
      console.log('[LibraryModal] Creating new session...')
      const newSessionId = await createTestSession({
        name: 'New Canvas',
        canvasWidth: 800,
        canvasHeight: 600,
        isPublic: false
      })
      console.log('[LibraryModal] Created session:', newSessionId)
      
      // Navigate to the new session
      window.location.href = `/?session=${newSessionId}`
    } catch (error) {
      console.error('[LibraryModal] Error creating session:', error)
      // Fallback to the original behavior
      onCreateNew()
      onClose()
    }
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
      <div className="relative bg-black/90 backdrop-blur-md border border-white/20 rounded-lg shadow-xl w-full max-w-4xl max-h-[80vh] mx-4 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-white/20">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <ImageIcon className="w-5 h-5" />
            My Library
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-white/20 rounded transition-colors"
            aria-label="Close modal"
          >
            <X className="w-5 h-5 text-white/60" />
          </button>
        </div>

        {/* Search Bar */}
        <div className="p-4 border-b border-white/10">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-white/40" />
            <input
              type="text"
              placeholder="Search paintings..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 focus:outline-none focus:border-white/40 transition-colors"
            />
          </div>
          
          {/* Debug Info (temporary) - Hidden */}
          {/* {debugInfo && (
            <div className="mt-2 p-2 bg-yellow-900/20 border border-yellow-600/20 rounded text-xs text-yellow-200">
              <div className="flex items-center gap-1 mb-1">
                <Bug className="w-3 h-3" />
                <span className="font-semibold">Debug Info:</span>
              </div>
              <div>User: {debugInfo.user?.email || 'Not found'}</div>
              <div>User ID: {debugInfo.user?._id || 'N/A'}</div>
              <div>Your sessions: {debugInfo.userSessionCount || 0}</div>
              <div>Recent sessions in DB: {debugInfo.allSessionsInfo?.length || 0}</div>
              {debugInfo.allSessionsInfo && debugInfo.allSessionsInfo.length > 0 && (
                <div className="mt-1">
                  <div className="font-semibold">First session owner: {debugInfo.allSessionsInfo[0].createdBy || 'null'}</div>
                </div>
              )}
            </div>
          )} */}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {/* Create New Button */}
          <button
            onClick={handleCreateNew}
            className="w-full mb-4 p-8 bg-white/5 hover:bg-white/10 border-2 border-dashed border-white/20 hover:border-white/40 rounded-lg transition-all flex flex-col items-center justify-center gap-2 group"
          >
            <Plus className="w-8 h-8 text-white/40 group-hover:text-white/60 transition-colors" />
            <span className="text-white/60 group-hover:text-white/80 transition-colors">Create New Canvas</span>
          </button>

          {/* Sessions Grid */}
          {filteredSessions.length === 0 ? (
            <div className="text-center py-8 text-white/40">
              {searchQuery ? 'No paintings found matching your search.' : 'No paintings yet. Create your first one!'}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
              {filteredSessions.map((session) => (
                <div
                  key={session._id}
                  className="group relative bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 rounded-lg overflow-hidden transition-all"
                >
                  {/* Thumbnail */}
                  <div
                    onClick={() => handleOpenSession(session._id)}
                    className="aspect-video bg-white/5 cursor-pointer relative overflow-hidden"
                  >
                    {session.thumbnailUrl ? (
                      <img
                        src={session.thumbnailUrl}
                        alt={session.name || 'Untitled'}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <ImageIcon className="w-12 h-12 text-white/20" />
                      </div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="p-3">
                    {editingSessionId === session._id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveEdit()
                            if (e.key === 'Escape') handleCancelEdit()
                          }}
                          className="flex-1 px-2 py-1 bg-white/10 border border-white/20 rounded text-sm text-white focus:outline-none focus:border-white/40"
                          autoFocus
                        />
                        <button
                          onClick={handleSaveEdit}
                          className="p-1 hover:bg-white/20 rounded text-green-400"
                        >
                          ✓
                        </button>
                        <button
                          onClick={handleCancelEdit}
                          className="p-1 hover:bg-white/20 rounded text-red-400"
                        >
                          ✗
                        </button>
                      </div>
                    ) : (
                      <>
                        <h3 className="font-medium text-white/80 truncate mb-1">
                          {session.name || 'Untitled'}
                        </h3>
                        <p className="text-xs text-white/40">
                          {new Date(session._creationTime).toLocaleDateString()}
                        </p>
                      </>
                    )}
                  </div>

                  {/* Actions */}
                  {editingSessionId !== session._id && (
                    <div className="absolute top-2 left-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleStartEdit(session)
                        }}
                        className="p-1.5 bg-black/60 backdrop-blur-sm hover:bg-black/80 rounded transition-colors"
                        title="Rename"
                      >
                        <Edit2 className="w-3.5 h-3.5 text-white/60" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDelete(session._id)
                        }}
                        className={`p-1.5 backdrop-blur-sm rounded transition-colors ${
                          deletingSessionId === session._id
                            ? 'bg-red-600/80 hover:bg-red-600'
                            : 'bg-black/60 hover:bg-black/80'
                        }`}
                        title={deletingSessionId === session._id ? 'Click again to confirm' : 'Delete'}
                      >
                        <Trash2 className="w-3.5 h-3.5 text-white/60" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
