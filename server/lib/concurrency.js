/**
 * In-memory concurrency manager for workflow execution.
 *
 * Tracks:
 * - Global count of running workflows across all users
 * - Per-user count of running workflows
 *
 * State resets on server restart. The scheduler handles crash recovery by
 * moving stale processing/ files back to queue/ on startup, so counters
 * naturally start at zero after a restart.
 */
export class ConcurrencyManager {
  constructor() {
    this._activeGlobal = 0;
    this._activeByUser = new Map();
  }

  /**
   * Check if a new workflow can start for the given user.
   * @param {string} userId
   * @param {number} maxGlobal - from server config
   * @param {number} maxForUser - effective limit for this user
   * @returns {boolean}
   */
  canRun(userId, maxGlobal, maxForUser) {
    if (this._activeGlobal >= maxGlobal) return false;
    const userCount = this._activeByUser.get(userId) || 0;
    if (userCount >= maxForUser) return false;
    return true;
  }

  /**
   * Acquire a concurrency slot for the given user.
   * Call this before starting a workflow.
   * @param {string} userId
   */
  acquire(userId) {
    this._activeGlobal++;
    this._activeByUser.set(userId, (this._activeByUser.get(userId) || 0) + 1);
  }

  /**
   * Release a concurrency slot for the given user.
   * Call this after a workflow completes (success or failure).
   * @param {string} userId
   */
  release(userId) {
    this._activeGlobal = Math.max(0, this._activeGlobal - 1);
    const current = this._activeByUser.get(userId) || 0;
    const next = Math.max(0, current - 1);
    if (next === 0) {
      this._activeByUser.delete(userId);
    } else {
      this._activeByUser.set(userId, next);
    }
  }

  /**
   * @returns {number} total active workflows across all users
   */
  getActiveGlobal() {
    return this._activeGlobal;
  }

  /**
   * @param {string} userId
   * @returns {number} active workflows for the given user
   */
  getActiveForUser(userId) {
    return this._activeByUser.get(userId) || 0;
  }
}

/** Singleton instance shared across the application. */
export const concurrencyManager = new ConcurrencyManager();
