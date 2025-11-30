// ============================================
// CONNECTION MANAGER CLASS (ESM)
// (updated: uses addConnecting instead of setConnecting)
// ============================================

class ConnectionManager {
  constructor() {
    this.connections = new Map();       // { sessionId: connection_object }
    this.connectingState = new Set();   // sessionIds currently connecting
  }

  // Get all connected sessions
  getAllConnections() {
    const allConnections = [];
    for (const [sessionId, connection] of this.connections.entries()) {
      allConnections.push({ file_path: sessionId, connection, healthy: !!connection });
    }
    return allConnections;
  }

  // Check if already connected
  isConnected(sessionId) {
    return this.connections.has(sessionId);
  }

  // Check if currently connecting
  isConnecting(sessionId) {
    return this.connectingState.has(sessionId);
  }

  // NEW: Add a session to connecting state
  addConnecting(sessionId) {
    this.connectingState.add(sessionId);
  }

  // Remove from connecting state
  removeConnecting(sessionId) {
    this.connectingState.delete(sessionId);
  }

  // Add successful connection
  addConnection(sessionId, connection) {
    this.connections.set(sessionId, connection);
    this.removeConnecting(sessionId);  // auto-remove from connecting
  }

  // Get specific connection
  getConnection(sessionId) {
    return this.connections.get(sessionId);
  }

  // Remove connection
  removeConnection(sessionId) {
    this.connections.delete(sessionId);
    this.removeConnecting(sessionId);
  }

  // Count active connections
  countConnections() {
    return this.connections.size;
  }

  // Clear everything (restart)
  clearAll() {
    this.connections.clear();
    this.connectingState.clear();
  }
}

const manager = new ConnectionManager();
export default manager;
