/**
 * P2P Debug Logger
 * 
 * Use this to verify that Convex is not being used for live strokes.
 * Import and call initP2PLogger() in your app to enable logging.
 */

interface LogEntry {
  timestamp: number;
  type: 'p2p' | 'convex';
  action: string;
  details?: any;
}

class P2PLogger {
  private logs: LogEntry[] = [];
  private enabled = false;

  enable() {
    this.enabled = true;
    console.log('%c🔍 P2P Logger Enabled', 'color: blue; font-weight: bold');
    console.log('Monitoring P2P vs Convex activity...');
    
    // Create global accessor
    (window as any).__p2pLogger = this;
  }

  disable() {
    this.enabled = false;
  }

  logP2P(action: string, details?: any) {
    if (!this.enabled) return;
    
    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'p2p',
      action,
      details
    };
    
    this.logs.push(entry);
    console.log(`%c[P2P] ${action}`, 'color: green', details || '');
  }

  logConvex(action: string, details?: any) {
    if (!this.enabled) return;
    
    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'convex',
      action,
      details
    };
    
    this.logs.push(entry);
    
    // Warn if this is a live stroke update
    if (action.includes('updateLiveStroke')) {
      console.warn(`%c⚠️ [CONVEX] ${action} - P2P should handle this!`, 'color: red', details || '');
    } else {
      console.log(`%c[CONVEX] ${action}`, 'color: orange', details || '');
    }
  }

  getStats() {
    const p2pCount = this.logs.filter(l => l.type === 'p2p').length;
    const convexCount = this.logs.filter(l => l.type === 'convex').length;
    const liveStrokeCount = this.logs.filter(l => 
      l.type === 'convex' && l.action.includes('updateLiveStroke')
    ).length;
    
    console.log('%c📊 P2P vs Convex Stats', 'color: blue; font-weight: bold');
    console.log(`P2P Messages: ${p2pCount}`);
    console.log(`Convex Calls: ${convexCount}`);
    console.log(`Live Stroke via Convex: ${liveStrokeCount} ${liveStrokeCount > 0 ? '❌ (should be 0)' : '✅'}`);
    
    return { p2pCount, convexCount, liveStrokeCount };
  }

  clear() {
    this.logs = [];
    console.log('Logger cleared');
  }

  getLogs() {
    return this.logs;
  }
}

export const p2pLogger = new P2PLogger();

export function initP2PLogger() {
  p2pLogger.enable();
  
  // Add console helpers
  console.log('%c🎨 P2P Logger Commands:', 'color: blue; font-weight: bold');
  console.log('  __p2pLogger.getStats()  - Show P2P vs Convex stats');
  console.log('  __p2pLogger.getLogs()   - Get all logs');
  console.log('  __p2pLogger.clear()     - Clear logs');
  console.log('  __p2pLogger.disable()   - Stop logging');
}