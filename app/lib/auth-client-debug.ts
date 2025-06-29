/**
 * Debug utilities for Better Auth client session issues
 */

import { authClient } from './auth-client';

export async function debugGetSession() {
  console.log('=== Better Auth getSession Debug ===');
  
  // 1. Check if getSession method exists
  console.log('1. authClient.getSession exists?', typeof authClient.getSession === 'function');
  
  try {
    // 2. Call getSession directly
    console.log('2. Calling authClient.getSession()...');
    const sessionResult = await authClient.getSession();
    console.log('   Session result:', sessionResult);
    
    // 3. Check the internal fetch configuration
    console.log('3. Checking authClient.$fetch configuration:');
    console.log('   Base URL:', authClient.$fetch.config?.baseURL);
    console.log('   Credentials:', authClient.$fetch.config?.credentials);
    
    // 4. Try manual session fetch to compare
    console.log('4. Trying manual session fetch...');
    const manualResponse = await authClient.$fetch('/api/auth/get-session', {
      method: 'GET',
    });
    console.log('   Manual fetch response:', manualResponse);
    
    // 5. Check cookies
    console.log('5. Document cookies (non-httpOnly only):', document.cookie);
    
    // 6. Check if session hook exists
    console.log('6. Checking session hook...');
    if (authClient.useSession) {
      console.log('   useSession hook exists (React hook - cannot call outside component)');
    }
    
    // 7. Check Better Auth internal store
    console.log('7. Checking Better Auth store...');
    if (authClient.$store) {
      console.log('   Store exists');
      console.log('   Atoms:', Object.keys(authClient.$store.atoms));
      
      // Try to find session atom
      const sessionAtom = authClient.$store.atoms['session'] || authClient.$store.atoms['$sessionSignal'];
      if (sessionAtom) {
        console.log('   Session atom found');
        try {
          // Some atoms might have a get method, others might not
          if (typeof sessionAtom.get === 'function') {
            console.log('   Session atom value:', sessionAtom.get());
          } else {
            console.log('   Session atom exists but no get method');
          }
        } catch (e) {
          console.log('   Could not read session atom:', e.message);
        }
      }
    }
    
    return sessionResult;
  } catch (error) {
    console.error('Error during getSession debug:', error);
    throw error;
  }
}

// Function to manually check session endpoint
export async function checkSessionEndpoint() {
  const baseURL = import.meta.env.VITE_CONVEX_SITE_URL || 'https://actions.wepaint.ai';
  const endpoints = [
    '/api/auth/get-session',
    '/api/auth/session',
    '/api/auth/me',
  ];
  
  console.log('=== Checking Session Endpoints ===');
  console.log('Base URL:', baseURL);
  
  for (const endpoint of endpoints) {
    try {
      console.log(`\nTrying ${endpoint}...`);
      const response = await fetch(`${baseURL}${endpoint}`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      
      console.log(`  Status: ${response.status}`);
      console.log(`  Headers:`, Object.fromEntries(response.headers.entries()));
      
      if (response.ok) {
        const data = await response.json();
        console.log(`  Data:`, data);
      } else {
        const text = await response.text();
        console.log(`  Error:`, text);
      }
    } catch (error) {
      console.error(`  Failed:`, error);
    }
  }
}