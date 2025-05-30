/**
 * Environment utility functions for controlling feature visibility
 */

/**
 * Checks if admin features should be hidden based on environment variables and build mode
 * @returns true if admin features should be hidden, false if they should be shown
 */
export function shouldHideAdminFeatures(): boolean {
  // Check for explicit environment variable first
  const hideAdminEnv = import.meta.env.VITE_INTERNAL_HIDE_ADMIN_PANEL
  if (hideAdminEnv !== undefined) {
    return hideAdminEnv === 'true' || hideAdminEnv === true
  }
  
  // Fall back to production mode detection
  // In production builds, hide admin features by default
  return import.meta.env.PROD
}

/**
 * Checks if admin features should be shown (inverse of shouldHideAdminFeatures)
 * @returns true if admin features should be shown, false if they should be hidden
 */
export function shouldShowAdminFeatures(): boolean {
  return !shouldHideAdminFeatures()
}

/**
 * Gets the current environment mode for debugging
 * @returns object with environment information
 */
export function getEnvironmentInfo() {
  return {
    hideAdminEnv: import.meta.env.VITE_INTERNAL_HIDE_ADMIN_PANEL,
    isProd: import.meta.env.PROD,
    isDev: import.meta.env.DEV,
    shouldHideAdmin: shouldHideAdminFeatures(),
    shouldShowAdmin: shouldShowAdminFeatures()
  }
}
