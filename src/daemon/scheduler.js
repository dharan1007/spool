import { randomUUID } from 'node:crypto';

export class MigrationScheduler {
  constructor({ service, auditLog = null } = {}) {
    this.service = service;
    this.auditLog = auditLog;
    this.tasks = new Map();
  }

  scheduleInterval({ id = `sched_${randomUUID()}`, intervalMs, migrationFactory }) {
    if (this.tasks.has(id)) {
      this.cancel(id);
    }

    const timer = setInterval(async () => {
      try {
        const input = await migrationFactory();
        const migration = await this.service.createMigration(input);
        await this.service.plan(migration.migrationId);
        await this.service.dryRun(migration.migrationId);
        await this.service.approve(migration.migrationId);
        const result = await this.service.execute(migration.migrationId);
        if (this.auditLog) {
          this.auditLog.record({
            principal: 'scheduler',
            action: 'scheduled.migration.complete',
            resource: migration.migrationId,
            outcome: result.status,
            detail: { scheduleId: id }
          });
        }
      } catch (error) {
        if (this.auditLog) {
          this.auditLog.record({
            principal: 'scheduler',
            action: 'scheduled.migration.failed',
            resource: id,
            outcome: 'FAILED',
            detail: { error: String(error?.message ?? error) }
          });
        }
      }
    }, intervalMs);

    this.tasks.set(id, { id, timer, intervalMs });
    return id;
  }

  cancel(id) {
    const task = this.tasks.get(id);
    if (task) {
      clearInterval(task.timer);
      this.tasks.delete(id);
      return true;
    }
    return false;
  }

  stopAll() {
    for (const id of this.tasks.keys()) {
      this.cancel(id);
    }
  }
}
