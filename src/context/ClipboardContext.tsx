import React, { createContext, useContext, useState, ReactNode } from 'react';

type ClipboardContextValue = {
  isMouseOverCanvas: boolean;
  setIsMouseOverCanvas: (value: boolean) => void;
  isMouseOverToolbox: boolean;
  setIsMouseOverToolbox: (value: boolean) => void;
  isAIModalOpen: boolean;
};

const ClipboardContext = createContext<ClipboardContextValue | null>(null);

export function useClipboardContext(): ClipboardContextValue {
  const ctx = useContext(ClipboardContext);
  if (!ctx) {
    throw new Error('useClipboardContext must be used within a ClipboardProvider');
  }
  return ctx;
}

export function ClipboardProvider({
  children,
  isAIModalOpen,
}: {
  children: ReactNode;
  isAIModalOpen: boolean;
}) {
  const [isMouseOverCanvas, setIsMouseOverCanvas] = useState(false);
  const [isMouseOverToolbox, setIsMouseOverToolbox] = useState(false);

  return (
    <ClipboardContext.Provider
      value={{
        isMouseOverCanvas,
        setIsMouseOverCanvas,
        isMouseOverToolbox,
        setIsMouseOverToolbox,
        isAIModalOpen,
      }}
    >
      {children}
    </ClipboardContext.Provider>
  );
}

export { ClipboardContext };
