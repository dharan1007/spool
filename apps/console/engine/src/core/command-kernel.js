import { parseCsvAsync, toCsv } from './csv.js';
import { yieldBrowserTurn } from '../runtime/cooperative-yield.js';
import { inferSchema, fingerprintText, validateOutputRow, validateTargetSchema } from './schema.js';
import { compileMapping, evaluateExpr } from './transforms.js';
import { MigrationEngine } from './migration.js';
import { createJob, transition, assertJobInvariants, PHASES } from './state-machine.js';
import { SpoolError, fail } from './errors.js';
import { toolNamesForPhase } from '../webmcp/registry.js';
import { planAutopilot, AUTOPILOT_OUTCOMES } from './autopilot.js';

function freshWorkspace() {
  return {
    version: 1,
    job: createJob(),
    source: null,
    targetSchema: [],
    targetSchemaRevision: 0,
    mapping: [],
    mappingRevision: 0,
    needsReplay: false,
    output: [],
    outputRevision: 0,
    violations: [],
    mission: null,
    lastError: null,
    updatedAt: new Date().toISOString()
  };
}

function clone(value) { return structuredClone(value); }

const AUTOPILOT_DRY_RUN_SIZE = 100;
const AUTOPILOT_MIN_ACCEPTANCE = 0.95;

function representativeRows(rows, limit = AUTOPILOT_DRY_RUN_SIZE) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  if (rows.length <= limit) return rows;
  if (limit <= 1) return [rows[0]];
  const sampled = [];
  for (let i = 0; i < limit; i += 1) {
    const index = Math.floor((i * (rows.length - 1)) / (limit - 1));
    sampled.push(rows[index]);
  }
  return sampled;
}

function summarizeDryRunViolations(violations, plan) {
  const targetFields = new Map(plan.targetSchema.map(field => [field.name, field]));
  return violations.map(group => {
    const sourceFields = new Set();
    const examples = (group.samples ?? []).slice(0, 3).map(sample => {
      const fields = [];
      for (const entry of plan.mapping) {
        try {
          const value = evaluateExpr(entry.expr, sample.row);
          validateOutputRow({ [entry.target]: value }, [targetFields.get(entry.target)]);
        } catch (error) {
          if (error?.code !== group.code) continue;
          const name = entry.expr?.value?.name ?? entry.expr?.name ?? entry.target;
          sourceFields.add(name);
          if (fields.length < 5) {
            fields.push({ field: name, value: String(sample.row?.[name] ?? '').slice(0, 120) });
          }
        }
      }
      return { record: sample.rowIndex + 1, fields };
    });
    return {
      code: group.code,
      count: group.count,
      message: String(group.message ?? '').slice(0, 180),
      sourceFields: [...sourceFields].slice(0, 12),
      examples
    };
  });
}

function mergeViolations(existing, incoming, sampleLimit = 10) {
  const map = new Map(existing.map(group => [group.code, clone(group)]));
  for (const group of incoming ?? []) {
    const current = map.get(group.code) ?? { code: group.code, message: group.message, count: 0, samples: [] };
    current.count += group.count;
    current.samples.push(...(group.samples ?? []));
    current.samples = current.samples.slice(0, sampleLimit);
    map.set(group.code, current);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

function ensureTargetsMatch(targetSchema, mapping) {
  const expected = targetSchema.map(f => f.name).sort();
  const actual = mapping.map(m => m.target).sort();
  if (expected.length !== actual.length || expected.some((name, i) => name !== actual[i])) {
    fail('MAPPING_TARGET_MISMATCH', 'Mapping targets must exactly match target schema', { expected, actual });
  }
}

export class CommandKernel {
  constructor({ store, runtime, onStateChange = () => {}, snapshotMode = 'full' }) {
    this.store = store;
    this.runtime = runtime;
    this.onStateChange = onStateChange;
    this.snapshotMode = snapshotMode;
    this.workspace = freshWorkspace();
    this.engine = new MigrationEngine({ sampleLimit: 10 });
    this.runEpoch = 0;
    this.runtimeEventChain = Promise.resolve();
    this.persistenceInFlight = 0;
    this.publishedWorkspace = { ...this.workspace };
    this.publishedOutputLength = 0;
  }

  async initialize() {
    const saved = await this.store.load();
    if (saved) this.workspace = saved;
    if ([PHASES.RUNNING, PHASES.REPLAYING].includes(this.workspace.job.phase)) {
      this.workspace.job = { ...this.workspace.job, phase: PHASES.PAUSED_RECOVERED, updatedAt: new Date().toISOString() };
      const automatic = this.workspace.mission?.mode === 'autopilot';
      this.workspace.lastError = {
        code: 'RECOVERED_AFTER_REFRESH',
        message: automatic
          ? 'Autopilot recovered the interrupted tab and is resuming from the durable checkpoint.'
          : 'The tab ended while a worker was active. Resume explicitly from the last durable checkpoint.'
      };
      if (automatic) this.workspace.mission = { ...this.workspace.mission, status: 'RECOVERING', updatedAt: new Date().toISOString() };
      await this.persist();
      if (automatic) {
        this.workspace.job = transition(this.workspace.job, PHASES.RUNNING);
        this.workspace.mission = { ...this.workspace.mission, status: 'RUNNING', updatedAt: new Date().toISOString() };
        await this.persist();
        try { await this.startRuntime({ startIndex: this.workspace.job.checkpoint, replaying: false }); }
        catch (error) { await this.failCurrentRun(error); }
      }
    } else this.emit();
    return this.snapshotMode === 'ui' ? this.viewSnapshot() : this.snapshot();
  }

  readableWorkspace() {
    if (!this.persistenceInFlight) return this.workspace;
    return { ...this.publishedWorkspace, output: this.publishedWorkspace.output.slice(0, this.publishedOutputLength) };
  }

  snapshot() { return clone(this.readableWorkspace()); }

  studioSnapshot() {
    const workspace = this.readableWorkspace();
    const source = workspace.source;
    return clone({ ...workspace, source: source ? { ...source, rowCount: source.rows.length,
      rows: source.rows.slice(0, 1000) } : null, output: workspace.output.slice(0, 12) });
  }

  previewSourcePlan(outcome) {
    const source = this.readableWorkspace().source;
    if (!source) fail('EMPTY_SOURCE', 'Load a source before planning');
    this.studioPlanCache ??= new WeakMap();
    let plans = this.studioPlanCache.get(source);
    if (!plans) { plans = new Map(); this.studioPlanCache.set(source, plans); }
    if (!plans.has(outcome)) plans.set(outcome, planAutopilot({ sourceSchema: source.schema, rows: source.rows, outcome }));
    return clone({ fingerprint: source.fingerprint, plan: plans.get(outcome) });
  }

  // Rendering never needs the whole source or completed output. Keep the
  // canonical full snapshot for tests/clients and emit a bounded UI view.
  viewSnapshot() {
    const workspace = this.readableWorkspace();
    const source = workspace.source;
    const sourceView = source ? {
      fileName: source.fileName,
      fingerprint: source.fingerprint,
      headers: { length: source.headers.length },
      bytes: source.bytes,
      rows: { length: source.rows.length }
    } : null;
    return clone({
      ...workspace,
      source: sourceView,
      output: workspace.output.slice(0, 12).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
        typeof value === 'string' && value.length > 200 ? `${value.slice(0, 200)}… [truncated preview]` : value
      ]))),
      violations: workspace.violations.map(group => ({
        ...group,
        samples: (group.samples ?? []).slice(0, 2).map(sample => ({ rowIndex: sample.rowIndex }))
      }))
    });
  }

  emit() {
    this.publishedWorkspace = { ...this.workspace, job: { ...this.workspace.job }, mission: this.workspace.mission ? clone(this.workspace.mission) : null };
    this.publishedOutputLength = this.workspace.output.length;
    this.onStateChange(this.snapshotMode === 'ui' ? this.viewSnapshot() : this.snapshot());
  }

  async persist() {
    this.workspace.updatedAt = new Date().toISOString();
    this.persistenceInFlight += 1;
    try { await this.store.save(this.workspace); }
    finally { this.persistenceInFlight -= 1; }
    this.emit();
  }

  allowed(name) { return toolNamesForPhase(this.workspace.job.phase).includes(name); }

  envelope(result = null) {
    return {
      ok: true,
      state: {
        phase: this.workspace.job.phase,
        jobId: this.workspace.job.jobId,
        revision: this.workspace.mappingRevision,
        processedRows: this.workspace.job.processedRows,
        totalRows: this.workspace.job.totalRows
      },
      result,
      nextValidActions: toolNamesForPhase(this.workspace.job.phase)
    };
  }

  errorEnvelope(error) {
    const normalized = error instanceof SpoolError ? error : new SpoolError('INTERNAL_ERROR', error?.message || String(error));
    const visible = this.readableWorkspace();
    return {
      ok: false,
      error: { code: normalized.code, message: normalized.message.replace(`${normalized.code}: `, ''), details: normalized.details },
      state: { phase: visible.job.phase, jobId: visible.job.jobId, revision: visible.mappingRevision },
      nextValidActions: this.persistenceInFlight ? [] : toolNamesForPhase(visible.job.phase)
    };
  }

  async loadSourceText(text, fileName = 'source.csv') {
    if (this.persistenceInFlight) fail('WORKSPACE_WRITE_PENDING', 'Wait for the current durable write before replacing the source.');
    const epoch = this.sourceLoadEpoch = (this.sourceLoadEpoch ?? 0) + 1;
    const { headers, rows } = await parseCsvAsync(text);
    if (epoch !== this.sourceLoadEpoch) fail('SOURCE_LOAD_SUPERSEDED', 'A newer file selection replaced this pending source load.');
    if (!headers.length) fail('EMPTY_SOURCE', 'Source CSV has no headers');
    if (!rows.length) fail('EMPTY_SOURCE_ROWS', 'Source CSV must contain at least one data row');
    await yieldBrowserTurn();
    const fingerprint = await fingerprintText(text);
    if (epoch !== this.sourceLoadEpoch) fail('SOURCE_LOAD_SUPERSEDED', 'A newer file selection replaced this pending source load.');
    await this.runtime.abort();
    this.runEpoch += 1;
    await this.whenRuntimeIdle();
    if (epoch !== this.sourceLoadEpoch) fail('SOURCE_LOAD_SUPERSEDED', 'A newer file selection replaced this pending source load.');
    await yieldBrowserTurn();
    const previous = this.workspace;
    const job = transition(createJob(), PHASES.SOURCE_READY, { sourceFingerprint: fingerprint, totalRows: rows.length });
    const schema = inferSchema(rows);
    const sourceBytes = new Blob([text]).size;
    this.workspace = {
      ...freshWorkspace(),
      job,
      source: { fileName, fingerprint, headers, rows, schema, bytes: sourceBytes }
    };
    await yieldBrowserTurn();
    try { await this.persist(); }
    catch (error) {
      this.workspace = previous;
      if ([PHASES.RUNNING, PHASES.REPLAYING].includes(previous.job.phase)) {
        previous.job = { ...previous.job, phase: PHASES.PAUSED_RECOVERED };
      }
      this.emit();
      throw error;
    }
    return this.envelope({ fileName, rows: rows.length, fields: headers.length, fingerprint });
  }

  async invoke(name, args = {}) {
    try {
      if (this.persistenceInFlight) fail('WORKSPACE_WRITE_PENDING', 'Wait for the current durable workspace write before issuing another command');
      if (!this.allowed(name)) fail('INVALID_PHASE', `${name} is unavailable while workspace is ${this.workspace.job.phase}`);
      const fn = this[`cmd_${name}`];
      if (typeof fn !== 'function') fail('UNKNOWN_COMMAND', `No command implementation for ${name}`);
      return await fn.call(this, args ?? {});
    } catch (error) {
      return this.errorEnvelope(error);
    }
  }

  async cmd_describe_supported_formats() {
    return this.envelope({ input: ['CSV', 'XLSX'], output: ['CSV', 'JSON'], notes: { XLSX: 'Browser Studio imports the first visible worksheet locally and never executes workbook formulas.' }, limits: { maxRows: 1_000_000, maxColumns: 1000, maxCellLength: 1_048_576 }, privacy: 'All dataset processing is local to this browser.' });
  }
  async cmd_inspect_workspace() {
    const source = this.workspace.source ? {
      fileName: this.workspace.source.fileName,
      fingerprint: this.workspace.source.fingerprint,
      rows: this.workspace.source.rows.length,
      fields: this.workspace.source.headers.length,
      bytes: this.workspace.source.bytes
    } : null;
    return this.envelope({
      version: this.workspace.version,
      job: this.workspace.job,
      source,
      targetFields: this.workspace.targetSchema.length,
      targetSchemaRevision: this.workspace.targetSchemaRevision,
      mappingTargets: this.workspace.mapping.map(m => m.target),
      mappingRevision: this.workspace.mappingRevision,
      needsReplay: this.workspace.needsReplay,
      outputRows: this.workspace.output.length,
      outputRevision: this.workspace.outputRevision,
      violationGroups: this.workspace.violations.map(v => ({ code: v.code, count: v.count })),
      mission: this.workspace.mission ? {
        missionId: this.workspace.mission.missionId,
        mode: this.workspace.mission.mode,
        status: this.workspace.mission.status,
        outcome: this.workspace.mission.outcome,
        confidence: this.workspace.mission.confidence,
        interventions: this.workspace.mission.interventions,
        ambiguityCount: this.workspace.mission.ambiguities?.length ?? 0
      } : null,
      lastError: this.workspace.lastError,
      updatedAt: this.workspace.updatedAt
    });
  }
  async cmd_inspect_source_schema() { return this.envelope({ schema: this.workspace.source.schema, rows: this.workspace.source.rows.length }); }
  async cmd_inspect_source_sample({ limit = 5 }) { return this.envelope({ rows: this.workspace.source.rows.slice(0, Math.min(50, Math.max(1, limit))) }); }

  async cmd_run_autopilot({ outcome = AUTOPILOT_OUTCOMES.DATABASE_READY } = {}) {
    const allowedOutcomes = new Set(Object.values(AUTOPILOT_OUTCOMES));
    if (!allowedOutcomes.has(outcome)) fail('INVALID_AUTOPILOT_OUTCOME', `Unsupported Autopilot outcome ${outcome}`);
    const plan = planAutopilot({
      sourceSchema: this.workspace.source.schema,
      rows: this.workspace.source.rows,
      outcome
    });
    const now = new Date().toISOString();
    this.workspace.mission = {
      missionId: `mission_${this.workspace.job.jobId}`,
      mode: 'autopilot',
      status: plan.needsAttention ? 'NEEDS_ATTENTION' : 'PLANNING',
      outcome,
      confidence: plan.confidence,
      evidence: clone(plan.evidence),
      ambiguities: clone(plan.ambiguities),
      interventions: plan.ambiguities.length,
      dryRun: null,
      createdAt: now,
      updatedAt: now
    };
    if (plan.needsAttention) {
      await this.persist();
      return this.envelope({
        status: 'NEEDS_ATTENTION',
        ambiguityCount: plan.ambiguities.length,
        ambiguities: clone(plan.ambiguities),
        confidence: plan.confidence
      });
    }

    // Preserve-contract is browser CSV-to-CSV: source header spellings may
    // contain spaces/punctuation. They were already vetted by parseCsv.
    // SQL/typed target authoring continues to require validateTargetSchema.
    if (outcome !== AUTOPILOT_OUTCOMES.PRESERVE_CONTRACT) validateTargetSchema(plan.targetSchema);
    const compiled = compileMapping(plan.mapping);
    ensureTargetsMatch(plan.targetSchema, compiled.entries);
    const previewRevision = this.workspace.mappingRevision + 1;
    const previewRows = representativeRows(this.workspace.source.rows);
    const previewIndexes = previewRows.map((_, index) => previewRows.length === this.workspace.source.rows.length
      ? index
      : Math.floor((index * (this.workspace.source.rows.length - 1)) / (previewRows.length - 1)));
    const preview = this.engine.run(
      previewRows,
      plan.mapping,
      previewRevision,
      plan.targetSchema,
      previewIndexes
    );
    const acceptanceRate = preview.processedRows > 0 ? preview.validRows / preview.processedRows : 1;
    const assessment = preview.validRows === 0 || acceptanceRate < AUTOPILOT_MIN_ACCEPTANCE
      ? 'BLOCK'
      : preview.invalidRows > 0
        ? 'WARNING'
        : 'PASS';
    this.workspace.mission.dryRun = {
      processedRows: preview.processedRows,
      validRows: preview.validRows,
      invalidRows: preview.invalidRows,
      acceptanceRate: Number(acceptanceRate.toFixed(4)),
      minimumAcceptance: AUTOPILOT_MIN_ACCEPTANCE,
      assessment,
      sampling: previewRows.length === this.workspace.source.rows.length ? 'full_source' : 'evenly_spaced_full_source',
      violationGroups: summarizeDryRunViolations(preview.violations, plan)
    };
    if (assessment === 'BLOCK') {
      const zeroAcceptance = preview.validRows === 0;
      const decision = {
        code: zeroAcceptance ? 'DRY_RUN_ZERO_ACCEPTANCE' : 'DRY_RUN_ACCEPTANCE_BELOW_THRESHOLD',
        message: zeroAcceptance
          ? 'Autopilot dry run accepted zero rows. Execution was not started; revise the outcome or target interpretation.'
          : `Autopilot dry run accepted ${preview.validRows}/${preview.processedRows} representative rows, below the ${(AUTOPILOT_MIN_ACCEPTANCE * 100).toFixed(0)}% safety floor. Execution was not started.`,
        sourceFields: this.workspace.mission.dryRun.violationGroups.flatMap(group => group.sourceFields).slice(0, 12)
      };
      this.workspace.mission.status = 'NEEDS_ATTENTION';
      this.workspace.mission.ambiguities = [...(this.workspace.mission.ambiguities ?? []), decision];
      this.workspace.mission.interventions += 1;
      this.workspace.mission.updatedAt = new Date().toISOString();
      await this.persist();
      return this.envelope({
        status: 'NEEDS_ATTENTION',
        reason: decision.code,
        ambiguityCount: this.workspace.mission.ambiguities.length,
        ambiguities: clone(this.workspace.mission.ambiguities),
        dryRun: clone(this.workspace.mission.dryRun),
        confidence: plan.confidence
      });
    }

    this.workspace.targetSchema = clone(plan.targetSchema);
    this.workspace.targetSchemaRevision += 1;
    this.workspace.job = transition(this.workspace.job, PHASES.TARGET_READY, { targetSchemaRevision: this.workspace.targetSchemaRevision });
    this.workspace.mapping = clone(plan.mapping);
    this.workspace.job = transition(this.workspace.job, PHASES.MAPPING_DRAFT);
    this.workspace.mappingRevision = previewRevision;
    this.workspace.job = transition(this.workspace.job, PHASES.MAPPING_VALID, { mappingRevision: this.workspace.mappingRevision });
    this.workspace.mission.status = 'RUNNING';
    this.workspace.mission.updatedAt = new Date().toISOString();
    return this.cmd_start_migration();
  }

  async cmd_inspect_mission() {
    const mission = this.workspace.mission;
    if (!mission) return this.envelope({ status: 'NOT_STARTED', outcome: null, confidence: null, ambiguities: [], evidence: [] });
    return this.envelope({
      missionId: mission.missionId,
      mode: mission.mode,
      status: mission.status,
      outcome: mission.outcome,
      confidence: mission.confidence,
      interventions: mission.interventions,
      evidence: clone(mission.evidence ?? []),
      ambiguities: clone(mission.ambiguities ?? []),
      dryRun: clone(mission.dryRun),
      progress: {
        processedRows: this.workspace.job.processedRows,
        totalRows: this.workspace.job.totalRows,
        validRows: this.workspace.job.validRows,
        invalidRows: this.workspace.job.invalidRows,
        checkpoint: this.workspace.job.checkpoint
      },
      violationGroups: this.workspace.violations.map(group => ({ code: group.code, count: group.count })),
      updatedAt: mission.updatedAt
    });
  }

  async cmd_define_target_schema({ fields }) {
    validateTargetSchema(fields);
    this.workspace.targetSchema = clone(fields);
    this.workspace.targetSchemaRevision += 1;
    this.workspace.job = transition(this.workspace.job, PHASES.TARGET_READY, { targetSchemaRevision: this.workspace.targetSchemaRevision });
    await this.persist();
    return this.envelope({ fields: this.workspace.targetSchema });
  }

  async cmd_inspect_schema_diff() {
    const source = new Map(this.workspace.source.schema.map(f => [f.name, f]));
    const target = new Map(this.workspace.targetSchema.map(f => [f.name, f]));
    return this.envelope({
      added: [...target.keys()].filter(k => !source.has(k)),
      removed: [...source.keys()].filter(k => !target.has(k)),
      shared: [...target.keys()].filter(k => source.has(k))
    });
  }

  async cmd_set_mapping({ mapping }) {
    if (!Array.isArray(mapping)) fail('INVALID_MAPPING', 'mapping must be an array');
    this.workspace.mapping = clone(mapping);
    if (this.workspace.job.phase === PHASES.TARGET_READY) this.workspace.job = transition(this.workspace.job, PHASES.MAPPING_DRAFT);
    await this.persist();
    return this.envelope({ targets: mapping.map(m => m.target) });
  }

  async cmd_validate_mapping() {
    const compiled = compileMapping(this.workspace.mapping);
    ensureTargetsMatch(this.workspace.targetSchema, compiled.entries);
    this.workspace.mappingRevision += 1;
    this.workspace.job = transition(this.workspace.job, PHASES.MAPPING_VALID, { mappingRevision: this.workspace.mappingRevision });
    await this.persist();
    return this.envelope({ valid: true, revision: this.workspace.mappingRevision, targets: compiled.targets });
  }

  async cmd_preview_migration({ limit = 10 }) {
    const result = this.engine.run(this.workspace.source.rows.slice(0, Math.min(100, Math.max(1, limit))), this.workspace.mapping, this.workspace.mappingRevision, this.workspace.targetSchema);
    return this.envelope(result);
  }

  async cmd_revise_mapping({ mapping }) {
    const compiled = compileMapping(mapping);
    ensureTargetsMatch(this.workspace.targetSchema, compiled.entries);
    this.workspace.mapping = clone(mapping);
    this.workspace.mappingRevision += 1;
    if ([PHASES.PAUSED, PHASES.PAUSED_RECOVERED].includes(this.workspace.job.phase)) {
      this.workspace.needsReplay = true;
    }
    this.workspace.job = { ...this.workspace.job, mappingRevision: this.workspace.mappingRevision, updatedAt: new Date().toISOString() };
    await this.persist();
    return this.envelope({ revision: this.workspace.mappingRevision, replayRequired: this.workspace.needsReplay });
  }

  async cmd_start_migration() {
    this.workspace.output = [];
    this.workspace.outputRevision = this.workspace.mappingRevision;
    this.workspace.violations = [];
    this.workspace.needsReplay = false;
    this.workspace.job = transition(this.workspace.job, PHASES.RUNNING, { processedRows: 0, validRows: 0, invalidRows: 0, checkpoint: 0, mappingRevision: this.workspace.mappingRevision });
    try {
      await this.persist();
      await this.startRuntime({ startIndex: 0, replaying: false });
    } catch (error) {
      await this.failCurrentRun(error);
      throw error;
    }
    return this.envelope({ started: true });
  }

  async failCurrentRun(error) {
    try { await this.runtime.abort(); } catch { /* Surface original failure. */ }
    this.runEpoch += 1; // Stale Worker callbacks must never revive a stopped run.
    const code = error?.code || (error?.name === 'QuotaExceededError' ? 'STORAGE_WRITE_FAILED' : 'WORKER_OR_STORAGE_FAILED');
    this.workspace.lastError = { code, message: String(error?.message || error || 'Local execution failed').slice(0, 300) };
    if ([PHASES.RUNNING, PHASES.REPLAYING, PHASES.PAUSED, PHASES.PAUSED_RECOVERED].includes(this.workspace.job.phase)) {
      this.workspace.job = transition(this.workspace.job, PHASES.FAILED);
    }
    if (this.workspace.mission?.mode === 'autopilot') {
      this.workspace.mission = { ...this.workspace.mission, status: 'FAILED', updatedAt: new Date().toISOString() };
    }
    try { await this.persist(); } catch { this.emit(); } // Never claim durable completion after a failed checkpoint.
  }

  async startRuntime({ startIndex, replaying }) {
    const epoch = ++this.runEpoch;
    const payload = {
      jobId: this.workspace.job.jobId,
      rows: this.workspace.source.rows,
      mapping: this.workspace.mapping,
      revision: this.workspace.mappingRevision,
      targetSchema: this.workspace.targetSchema,
      startIndex,
      chunkSize: 500
    };
    const enqueue = action => {
      this.runtimeEventChain = this.runtimeEventChain.then(action).catch(async error => {
        if (epoch !== this.runEpoch) return;
        await this.failCurrentRun(error);
      });
    };
    const handlers = {
      onProgress: progress => enqueue(() => this.applyProgress(progress, epoch)),
      onComplete: summary => enqueue(() => this.applyComplete(summary, epoch)),
      onError: error => enqueue(() => this.applyRuntimeError(error, epoch))
    };
    await this.runtime.start(payload, handlers);
    if (replaying) this.workspace.needsReplay = false;
  }

  async whenRuntimeIdle() { await this.runtimeEventChain; }

  async applyProgress(progress, epoch) {
    if (epoch !== this.runEpoch || ![PHASES.RUNNING, PHASES.REPLAYING].includes(this.workspace.job.phase)) return;
    const processedRows = this.workspace.job.processedRows + progress.processedRows;
    const validRows = this.workspace.job.validRows + progress.validRows;
    const invalidRows = this.workspace.job.invalidRows + progress.invalidRows;
    this.workspace.output.push(...(progress.outputChunk ?? []));
    this.workspace.violations = mergeViolations(this.workspace.violations, progress.violations);
    this.workspace.job = assertJobInvariants({ ...this.workspace.job, processedRows, validRows, invalidRows, checkpoint: processedRows, updatedAt: new Date().toISOString() });
    await this.persist();
  }

  async applyComplete(_summary, epoch) {
    if (epoch !== this.runEpoch || ![PHASES.RUNNING, PHASES.REPLAYING].includes(this.workspace.job.phase)) return;
    const remaining = this.workspace.job.totalRows - this.workspace.job.processedRows;
    if (remaining !== 0) fail('INCOMPLETE_RUNTIME', `Runtime completed with ${remaining} rows unprocessed`);
    this.workspace.outputRevision = this.workspace.mappingRevision;
    this.workspace.job = transition(this.workspace.job, PHASES.COMPLETE);
    if (this.workspace.mission?.mode === 'autopilot') {
      const completionStatus = this.workspace.job.validRows === 0 && this.workspace.job.totalRows > 0
        ? 'NEEDS_ATTENTION'
        : this.workspace.job.invalidRows > 0
          ? 'COMPLETE_WITH_REJECTIONS'
          : 'COMPLETE_VERIFIED';
      this.workspace.mission = {
        ...this.workspace.mission,
        status: completionStatus,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        quality: {
          processedRows: this.workspace.job.processedRows,
          validRows: this.workspace.job.validRows,
          invalidRows: this.workspace.job.invalidRows
        }
      };
    }
    await this.persist();
  }

  async applyRuntimeError(error, epoch) {
    if (epoch !== this.runEpoch) return;
    this.workspace.lastError = { code: error?.code || 'WORKER_ERROR', message: error?.message || String(error) };
    if ([PHASES.RUNNING, PHASES.REPLAYING].includes(this.workspace.job.phase)) this.workspace.job = transition(this.workspace.job, PHASES.FAILED);
    if (this.workspace.mission?.mode === 'autopilot') this.workspace.mission = { ...this.workspace.mission, status: 'FAILED', updatedAt: new Date().toISOString() };
    await this.persist();
  }

  async cmd_get_run_state() { return this.envelope({ job: this.workspace.job, replayRequired: this.workspace.needsReplay, lastError: this.workspace.lastError }); }

  async cmd_pause_run() {
    await this.runtime.pause();
    await this.whenRuntimeIdle();
    this.workspace.job = transition(this.workspace.job, PHASES.PAUSED);
    await this.persist();
    return this.envelope({ checkpoint: this.workspace.job.checkpoint });
  }

  async cmd_resume_run() {
    const replay = this.workspace.needsReplay;
    try {
      if (replay) {
        await this.runtime.abort();
        this.runEpoch += 1;
        this.workspace.output = [];
        this.workspace.violations = [];
        this.workspace.outputRevision = this.workspace.mappingRevision;
        this.workspace.job = transition(this.workspace.job, PHASES.REPLAYING, { processedRows: 0, validRows: 0, invalidRows: 0, checkpoint: 0, mappingRevision: this.workspace.mappingRevision });
        await this.persist();
        await this.startRuntime({ startIndex: 0, replaying: true });
      } else {
        this.workspace.job = transition(this.workspace.job, PHASES.RUNNING);
        await this.persist();
        await this.startRuntime({ startIndex: this.workspace.job.checkpoint, replaying: false });
      }
    } catch (error) {
      await this.failCurrentRun(error);
      throw error;
    }
    return this.envelope({ replaying: replay, checkpoint: this.workspace.job.checkpoint });
  }

  async cmd_abort_run() {
    await this.runtime.abort();
    this.runEpoch += 1;
    this.workspace.job = transition(this.workspace.job, PHASES.ABORTED);
    if (this.workspace.mission?.mode === 'autopilot') this.workspace.mission = { ...this.workspace.mission, status: 'ABORTED', updatedAt: new Date().toISOString() };
    await this.persist();
    return this.envelope({ aborted: true });
  }

  async cmd_inspect_violations({ code, limit = 10 }) {
    let groups = this.workspace.violations;
    if (code) groups = groups.filter(group => group.code === code);
    return this.envelope({ groups: groups.map(group => ({ ...group, samples: group.samples.slice(0, Math.min(50, Math.max(1, limit))) })) });
  }

  async cmd_inspect_result({ limit = 20 }) { return this.envelope({ revision: this.workspace.outputRevision, rows: this.workspace.output.slice(0, Math.min(100, Math.max(1, limit))) }); }
  async cmd_inspect_quality_report() { return this.envelope({ ...this.workspace.job, outputRevision: this.workspace.outputRevision, violationGroups: this.workspace.violations.map(v => ({ code: v.code, count: v.count })) }); }
  async cmd_export_csv() { return this.envelope({ mime: 'text/csv', fileName: 'spool-result.csv', content: toCsv(this.workspace.output, this.workspace.targetSchema.map(f => f.name)) }); }
  async cmd_export_json() { return this.envelope({ mime: 'application/json', fileName: 'spool-result.json', content: JSON.stringify(this.workspace.output, null, 2) }); }

  async cmd_start_new_migration() {
    // Invalidate any asynchronous CSV parse/hash already in progress before
    // clearing the workspace. Otherwise its later continuation can publish an
    // older file into a freshly reset migration.
    this.sourceLoadEpoch = (this.sourceLoadEpoch ?? 0) + 1;
    await this.runtime.abort();
    this.runEpoch += 1;
    this.workspace = freshWorkspace();
    await this.persist();
    return this.envelope({ reset: true });
  }
}
