import React, { useRef, useState, useSyncExternalStore } from 'react'
import { X, Copy, Check, Globe, Lock, Link2, RefreshCw, ShieldOff, Eye, Pencil } from 'lucide-react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { Id } from '../../convex/_generated/dataModel'
import { getGuestKey, getEditKey, subscribeEditKeys } from '../utils/guestKey'
import { GoogleSignInButton } from './GoogleSignInButton'

interface ShareModalProps {
  isOpen: boolean
  onClose: () => void
  sessionId: Id<'paintingSessions'>
}

export function ShareModal({ isOpen, onClose, sessionId }: ShareModalProps) {
  const localGuestKey = getGuestKey(sessionId)
  const localEditKey = useSyncExternalStore(
    subscribeEditKeys,
    () => getEditKey(sessionId),
    () => null,
  )
  const sessionResult = useQuery(api.paintingSessions.getSession, {
    sessionId,
    guestKey: localGuestKey || undefined,
    editKey: localEditKey || undefined,
  })
  const session = sessionResult?.status === 'ok' ? sessionResult.session : null
  const isOwner = sessionResult?.status === 'ok' ? sessionResult.isOwner : false
  const canEdit = sessionResult?.status === 'ok' ? sessionResult.canEdit : false

  const ownerEditKey = useQuery(
    api.paintingSessions.getSessionEditKey,
    isOpen && isOwner ? { sessionId, guestKey: localGuestKey || undefined } : 'skip',
  )

  const setVisibility = useMutation(api.paintingSessions.setSessionVisibility)
  const enableEditLink = useMutation(api.paintingSessions.enableEditLink)
  const rotateEditLink = useMutation(api.paintingSessions.rotateEditLink)
  const revokeEditLink = useMutation(api.paintingSessions.revokeEditLink)
  const currentUser = useQuery(api.auth.getCurrentUser)

  const [copiedView, setCopiedView] = useState(false)
  const [copiedEdit, setCopiedEdit] = useState(false)
  const [editLinkBusy, setEditLinkBusy] = useState<'enable' | 'rotate' | 'revoke' | null>(null)
  const [editLinkNotice, setEditLinkNotice] = useState<string | null>(null)
  const [editLinkError, setEditLinkError] = useState<string | null>(null)
  const viewLinkInputRef = useRef<HTMLInputElement>(null)
  const editLinkInputRef = useRef<HTMLInputElement>(null)

  if (!isOpen) return null

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const viewUrl = `${origin}?session=${sessionId}`
  const editUrl = ownerEditKey ? `${origin}?session=${sessionId}#edit=${ownerEditKey}` : null
  const isPublic = !!session?.isPublic

  const copyText = async (
    text: string,
    setFlag: (val: boolean) => void,
    inputRef: React.RefObject<HTMLInputElement | null>,
  ) => {
    try {
      await navigator.clipboard.writeText(text)
      setFlag(true)
      setTimeout(() => setFlag(false), 2000)
    } catch (err) {
      console.error('Failed to copy link', err)
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }

  const handleEnableEditLink = async () => {
    setEditLinkBusy('enable')
    setEditLinkError(null)
    setEditLinkNotice(null)
    try {
      await enableEditLink({ sessionId, guestKey: localGuestKey || undefined })
      setEditLinkNotice('Collaborate link created.')
    } catch (err) {
      console.error('Failed to enable edit link', err)
      setEditLinkError('Could not create collaborate link.')
    } finally {
      setEditLinkBusy(null)
    }
  }

  const handleRotateEditLink = async () => {
    setEditLinkBusy('rotate')
    setEditLinkError(null)
    setEditLinkNotice(null)
    try {
      await rotateEditLink({ sessionId, guestKey: localGuestKey || undefined })
      setCopiedEdit(false)
      setEditLinkNotice('New link generated — the previous link no longer works.')
    } catch (err) {
      console.error('Failed to rotate edit link', err)
      setEditLinkError('Could not rotate collaborate link.')
    } finally {
      setEditLinkBusy(null)
    }
  }

  const handleRevokeEditLink = async () => {
    setEditLinkBusy('revoke')
    setEditLinkError(null)
    setEditLinkNotice(null)
    try {
      await revokeEditLink({ sessionId, guestKey: localGuestKey || undefined })
      setCopiedEdit(false)
      setEditLinkNotice('Collaborate link revoked.')
    } catch (err) {
      console.error('Failed to revoke edit link', err)
      setEditLinkError('Could not revoke collaborate link.')
    } finally {
      setEditLinkBusy(null)
    }
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-black/90 border border-white/20 rounded-lg shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between p-3 border-b border-white/20">
          <h3 className="text-white text-sm font-semibold flex items-center gap-2">
            {isPublic ? <Globe className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
            Share
            {!isOwner && session && (
              <span className="inline-flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-[11px] font-normal text-white/80">
                {canEdit ? <Pencil className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                {canEdit ? 'Can edit' : 'View only'}
              </span>
            )}
          </h3>
          <button onClick={onClose} className="p-3 -m-2 hover:bg-white/20 rounded" aria-label="Close share dialog">
            <X className="w-4 h-4 text-white/70" />
          </button>
        </div>

        <div className="p-4 space-y-5">
          {/* Section 1: Public view-only access */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-white/90 flex items-center gap-1.5">
                  <Eye className="w-3.5 h-3.5 text-white/70" aria-hidden="true" />
                  Public view-only access
                </div>
                <div className="text-xs text-white/60">
                  Anyone with the view link can watch this painting, without editing it
                </div>
              </div>
              <label className="inline-flex items-center gap-2 cursor-pointer min-h-10 shrink-0">
                <span className={`text-xs flex items-center gap-1 ${isPublic ? 'text-green-400' : 'text-white/70'}`}>
                  {isPublic ? <Globe className="w-3 h-3" aria-hidden="true" /> : <Lock className="w-3 h-3" aria-hidden="true" />}
                  {isPublic ? 'Public' : 'Private'}
                </span>
                <input
                  type="checkbox"
                  className="sr-only peer"
                  aria-label="Public view-only access"
                  checked={isPublic}
                  disabled={!isOwner}
                  onChange={async (e) => {
                    try {
                      await setVisibility({ sessionId, isPublic: e.target.checked, guestKey: localGuestKey || undefined })
                    } catch (err) {
                      console.error('Failed to update visibility', err)
                    }
                  }}
                />
                <span className={`w-10 h-5 rounded-full transition-colors ${isPublic ? 'bg-green-500' : 'bg-white/30'} ${!isOwner ? 'opacity-50' : ''}`}></span>
              </label>
            </div>

            <div>
              <label className="text-xs text-white/70">View-only link</label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  ref={viewLinkInputRef}
                  readOnly
                  value={viewUrl}
                  onFocus={(e) => e.target.select()}
                  className="flex-1 bg-white/10 border border-white/20 rounded px-2 py-1 text-sm text-white"
                  aria-label="View-only link"
                />
                <button
                  className="px-2 py-1 bg-white/10 hover:bg-white/20 border border-white/20 rounded text-sm text-white flex items-center gap-1"
                  onClick={() => copyText(viewUrl, setCopiedView, viewLinkInputRef)}
                >
                  {copiedView ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-green-400" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" /> Copy
                    </>
                  )}
                </button>
              </div>
              {copiedView && !isPublic && (
                <div className="mt-2 text-xs text-yellow-300/80">
                  This painting is private — recipients won't be able to view it until you turn on Public view-only access.
                </div>
              )}
            </div>
          </div>

          {/* Section 2: Collaborate (edit) link — owner only */}
          <div className="border-t border-white/10 pt-4 space-y-3">
            <div>
              <div className="text-sm font-medium text-white/90 flex items-center gap-1.5">
                <Link2 className="w-3.5 h-3.5 text-blue-400" aria-hidden="true" />
                Collaborate (edit) link
              </div>
              <div className="text-xs text-white/60 mt-0.5">
                {isOwner
                  ? 'Share a secret link so collaborators can draw and edit layers. Owner controls stay private.'
                  : 'Only the session owner can change sharing or manage collaborate links.'}
              </div>
            </div>

            {isOwner && (
              <>
                {ownerEditKey === undefined ? (
                  <div className="text-xs text-white/60">Loading collaborate link…</div>
                ) : editUrl ? (
                  <div className="space-y-2.5">
                    <div className="flex items-center gap-2">
                      <input
                        ref={editLinkInputRef}
                        readOnly
                        value={editUrl}
                        onFocus={(e) => e.target.select()}
                        className="flex-1 bg-white/10 border border-blue-400/30 rounded px-2 py-1 text-sm text-white font-mono"
                        aria-label="Collaborate edit link"
                      />
                      <button
                        className="px-2 py-1 bg-blue-500/20 hover:bg-blue-500/30 border border-blue-400/40 rounded text-sm text-white flex items-center gap-1"
                        onClick={() => copyText(editUrl, setCopiedEdit, editLinkInputRef)}
                      >
                        {copiedEdit ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-green-400" /> Copied
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" /> Copy
                          </>
                        )}
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={editLinkBusy !== null}
                        onClick={handleRotateEditLink}
                        className="px-2.5 py-1.5 bg-white/10 hover:bg-white/20 disabled:opacity-50 border border-white/20 rounded text-xs text-white flex items-center gap-1.5"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${editLinkBusy === 'rotate' ? 'animate-spin' : ''}`} />
                        {editLinkBusy === 'rotate' ? 'Rotating…' : 'Rotate link'}
                      </button>
                      <button
                        type="button"
                        disabled={editLinkBusy !== null}
                        onClick={handleRevokeEditLink}
                        className="px-2.5 py-1.5 bg-red-500/10 hover:bg-red-500/20 disabled:opacity-50 border border-red-400/30 rounded text-xs text-red-300 flex items-center gap-1.5"
                      >
                        <ShieldOff className="w-3.5 h-3.5" />
                        {editLinkBusy === 'revoke' ? 'Revoking…' : 'Revoke access'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={editLinkBusy !== null}
                    onClick={handleEnableEditLink}
                    className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium text-white flex items-center justify-center gap-2"
                  >
                    <Link2 className="w-4 h-4" />
                    {editLinkBusy === 'enable' ? 'Creating collaborate link…' : 'Create collaborate link'}
                  </button>
                )}

                {editLinkNotice && (
                  <div className="text-xs text-green-400/90" role="status">
                    {editLinkNotice}
                  </div>
                )}
                {editLinkError && (
                  <div className="text-xs text-red-400" role="alert">
                    {editLinkError}
                  </div>
                )}
              </>
            )}
          </div>

          {currentUser === null && !!localGuestKey && isOwner && (
            <div className="border-t border-white/10 pt-4">
              <div className="text-sm text-white/80">Keep this painting</div>
              <div className="text-xs text-white/70 mt-1 mb-3">
                Right now it's only saved on this device. Sign in to keep it on
                all your devices.
              </div>
              <GoogleSignInButton
                callbackURL={typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}${window.location.search}` : '/'}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
