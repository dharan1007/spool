import { randomUUID } from 'node:crypto';
import { fail } from '../core/errors.js';

// Durably staged migration scheduler.
//
// The scheduler NEVER approves and NEVER executes work. Human approval is a
// mandatory production gate: the service layer enforces authorization for
// approve/execute, and execution is triggered only by authenticated callers
// (API v2, WebMCP, Console or leased workers). The scheduler only stages
// migration records on an interval while holding lease ownership so that no
// duplicate staging happens across concurrent schedulers.
export class MigrationScheduler {
  constructor({ service, leaseStore = null, auditLog = null } = {}) {
    if (!service || typeof service.createMigration !== 'function') {
      fail('SCHEDULER_CONFIG_INVALID', 'A migration service with createMigration is required');
    }
    this.service = service;
    this.leaseStore = leaseStore;
    this.auditLog = auditLog;
    this.tasks = new Map();
    this.stopped = false;
  }

  #assertAuthorizer(requiredRole) {
    if (!requiredRole) return;
    if (typeof this.service.authorizeRole !== 'function') {
      fail('SCHEDULER_CONFIG_INVALID', 'requiredRole demands a service authorizeRole implementation');
    }
  }

  /**
   * Stages a migration created by `migrationFactory` every `intervalMs`.
   * The transition is lease-gated: when an active lease exists the tick is
   * skipped so another already-active scheduler/worker owns the staging slot.
   * No approval and no execution are ever triggered by this scheduler.
   */
  scheduleWithLease({ id = `sched_${randomUUID()}`, intervalMs, migrationFactory, requiredRole = null } = {}) {
    if (this.stopped) fail('SCHEDULER_STOPPED', 'The scheduler is stopped');
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 10) {
      fail('SCHEDULER_CONFIG_INVALID', 'intervalMs must be a non-negative-safe integer >= 10ms');
    }
    if (typeof migrationFactory !== 'function') {
      fail('SCHEDULER_CONFIG_INVALID', 'migrationFactory is required');
    }
    if (requiredRole != null && typeof requiredRole !== 'string') {
      fail('SCHEDULER_CONFIG_INVALID', 'requiredRole must be a string when provided');
    }
    this.#assertAuthorizer(requiredRole);
    if (this.tasks.has(id)) {
      this.cancel(id);
    }

    const timer = setInterval(() => {
      void this.#tick(id, migrationFactory, requiredRole);
    }, intervalMs);

    this.tasks.set(id, { id, timer, intervalMs });
    return id;
  }

  async #tick(id, migrationFactory, requiredRole) {
    try {
      let activeLease = null;
      if (typeof this.leaseStore?.getActiveLease === 'function') {
        activeLease = this.leaseStore.getActiveLease();
      } else if (typeof this.leaseStore?.current === 'function') {
        const c = this.leaseStore.current('scheduler:staging');
        if (c && Number(c.expiresAtMs) > Date.now()) {
          activeLease = c;
        }
      }
      if (activeLease) {
        this.#audit('scheduled.migration.lease_skipped', id, 'LEASE_EXISTS', {
          leaseResource: activeLease.resource ?? null
        });
        return;
      }
      if (requiredRole && this.service.authorizeRole(requiredRole, 'migration.create') !== true) {
        this.#audit('scheduled.migration.rejected', id, 'NO_AUTHORIZATION', { requiredRole });
        return;
      }
      const input = await migrationFactory();
      const migration = await this.service.createMigration(input);
      this.#audit(
        'scheduled.migration.staged',
        migration?.migrationId ?? id,
        'STAGED',
        { scheduleId: id }
      );
    } catch (error) {
      this.#audit('scheduled.migration.failed', id, 'FAILED', { error: String(error?.message ?? error) });
    }
  }

  #audit(action, resource, outcome, detail) {
    if (!this.auditLog) return;
    try {
      this.auditLog.record({
        principal: 'scheduler',
        action,
        resource,
        outcome,
        detail: detail ?? {}
      });
    } catch {
      // Audit failures never stop scheduler liveness; the service audit trail
      // remains the durable authority.
    }
  }

  cancel(id) {
    const task = this.tasks.get(id);
    if (!task) return false;
    clearInterval(task.timer);
    this.tasks.delete(id);
    return true;
  }

  stopAll() {
    this.stopped = true;
    for (const id of [...this.tasks.keys()]) this.cancel(id);
  }
}
