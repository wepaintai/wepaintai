import React, { useRef, useState } from 'react'
import { X, Copy, Check, Globe, Lock } from 'lucide-react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { Id } from '../../convex/_generated/dataModel'
import { getGuestKey } from '../utils/guestKey'
import { GoogleSignInButton } from './GoogleSignInButton'

interface ShareModalProps {
  isOpen: boolean
  onClose: () => void
  sessionId: Id<'paintingSessions'>
}

export function ShareModal({ isOpen, onClose, sessionId }: ShareModalProps) {
  const localGuestKey = getGuestKey(sessionId)
  const sessionResult = useQuery(api.paintingSessions.getSession, { sessionId, guestKey: localGuestKey || undefined })
  const session = sessionResult?.status === 'ok' ? sessionResult.session : null
  const setVisibility = useMutation(api.paintingSessions.setSessionVisibility)
  const currentUser = useQuery(api.auth.getCurrentUser)
  const [copied, setCopied] = useState(false)
  const linkInputRef = useRef<HTMLInputElement>(null)

  if (!isOpen) return null

  const isOwner = (session && currentUser && session.createdBy === currentUser._id) || !!localGuestKey
  const shareUrl = `${window.location.origin}?session=${sessionId}`
  const isPublic = !!session?.isPublic

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy link', err)
      // Clipboard unavailable — select the text so the user can copy manually
      linkInputRef.current?.focus()
      linkInputRef.current?.select()
    }
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-black/90 border border-white/20 rounded-lg shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between p-3 border-b border-white/20">
          <h3 className="text-white text-sm font-semibold flex items-center gap-2">
            {session?.isPublic ? <Globe className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
            Share
          </h3>
          <button onClick={onClose} className="p-1 hover:bg-white/20 rounded">
            <X className="w-4 h-4 text-white/70" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <label className="text-xs text-white/60">Session link</label>
            <div className="mt-1 flex items-center gap-2">
              <input
                ref={linkInputRef}
                readOnly
                value={shareUrl}
                onFocus={(e) => e.target.select()}
                className="flex-1 bg-white/10 border border-white/20 rounded px-2 py-1 text-sm text-white"
              />
              <button
                className="px-2 py-1 bg-white/10 hover:bg-white/20 border border-white/20 rounded text-sm text-white flex items-center gap-1"
                onClick={handleCopy}
              >
                {copied ? (
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
            {copied && !isPublic && (
              <div className="mt-2 text-xs text-yellow-300/80">
                This session is private — recipients won't be able to open the link until you turn on Public access.
              </div>
            )}
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-white/80">Public access</div>
              <div className="text-xs text-white/50">Allow anyone with the link to view and collaborate</div>
            </div>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <span className={`text-xs ${isPublic ? 'text-green-400' : 'text-white/60'}`}>
                {isPublic ? 'Public' : 'Private'}
              </span>
              <input
                type="checkbox"
                className="sr-only peer"
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
          {!isOwner && (
            <div className="text-xs text-yellow-300/80">Only the session owner can change sharing.</div>
          )}
          {currentUser === null && !!localGuestKey && (
            <div className="border-t border-white/10 pt-4">
              <div className="text-sm text-white/80">Keep this painting</div>
              <div className="text-xs text-white/50 mt-1 mb-3">
                Right now it's only saved on this device. Sign in to keep it on
                all your devices.
              </div>
              <GoogleSignInButton
                callbackURL={typeof window !== 'undefined' ? window.location.href : '/'}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
