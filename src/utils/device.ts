/**
 * Utility functions for device detection
 */

/**
 * Detects if the current device is running iOS (iPhone, iPad, iPod)
 */
export function isIOS(): boolean {
  if (typeof window === 'undefined' || !window.navigator) {
    return false
  }
  
  const ua = window.navigator.userAgent
  
  // Check for iOS devices
  const isIOSDevice = /iPad|iPhone|iPod/.test(ua) && !(window as any).MSStream
  
  // Also check for iPadOS 13+ which reports as Mac
  const isIPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
  
  return isIOSDevice || isIPadOS
}

/**
 * Detects if the current browser is Safari on iOS
 */
export function isIOSSafari(): boolean {
  if (!isIOS()) {
    return false
  }
  
  const ua = window.navigator.userAgent
  
  // Check if it's Safari (not Chrome or other browsers on iOS)
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|OPiOS|mercury/.test(ua)
  
  return isSafari
}

/**
 * Detects if the device is a mobile device (any mobile, not just iOS)
 */
export function isMobile(): boolean {
  if (typeof window === 'undefined' || !window.navigator) {
    return false
  }
  
  const ua = window.navigator.userAgent
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)
}