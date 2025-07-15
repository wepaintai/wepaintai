import { useState } from 'react'

export function useLibrary() {
  const [isLibraryModalOpen, setIsLibraryModalOpen] = useState(false)

  const openLibrary = () => setIsLibraryModalOpen(true)
  const closeLibrary = () => setIsLibraryModalOpen(false)

  return {
    isLibraryModalOpen,
    openLibrary,
    closeLibrary,
  }
}