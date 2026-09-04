import { PHASES } from '../core/state-machine.js';

const PHASE_TOOLS = Object.freeze({
  [PHASES.EMPTY]: ['describe_supported_formats', 'inspect_workspace'],
  [PHASES.SOURCE_READY]: ['define_target_schema', 'inspect_mission', 'inspect_source_sample', 'inspect_source_schema', 'inspect_workspace', 'run_autopilot'],
  [PHASES.TARGET_READY]: ['inspect_mission', 'inspect_schema_diff', 'inspect_workspace', 'set_mapping'],
  [PHASES.MAPPING_DRAFT]: ['inspect_mission', 'inspect_schema_diff', 'inspect_workspace', 'set_mapping', 'validate_mapping'],
  [PHASES.MAPPING_VALID]: ['inspect_mission', 'inspect_workspace', 'preview_migration', 'revise_mapping', 'start_migration'],
  [PHASES.RUNNING]: ['inspect_mission', 'get_run_state', 'inspect_violations', 'pause_run'],
  [PHASES.PAUSED]: ['inspect_mission', 'abort_run', 'get_run_state', 'inspect_violations', 'resume_run', 'revise_mapping'],
  [PHASES.PAUSED_RECOVERED]: ['inspect_mission', 'abort_run', 'get_run_state', 'inspect_violations', 'resume_run', 'revise_mapping'],
  [PHASES.REPLAYING]: ['inspect_mission', 'abort_run', 'get_run_state', 'inspect_violations'],
  [PHASES.COMPLETE]: ['inspect_mission', 'export_csv', 'export_json', 'inspect_quality_report', 'inspect_result', 'start_new_migration'],
  [PHASES.FAILED]: ['inspect_mission', 'get_run_state', 'inspect_violations', 'start_new_migration'],
  [PHASES.ABORTED]: ['inspect_mission', 'get_run_state', 'start_new_migration']
});

const FIELD_SCHEMA = {
  type: 'object',
  required: ['name', 'type'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$', maxLength: 128 },
    type: { type: 'string', enum: ['string', 'integer', 'number', 'boolean', 'date'] },
    nullable: { type: 'boolean' }
  }
};

const MAPPING_ENTRY_SCHEMA = {
  type: 'object',
  required: ['target', 'expr'],
  additionalProperties: false,
  properties: {
    target: { type: 'string', minLength: 1, maxLength: 128 },
    expr: { type: 'object' }
  }
};

const DEFINITIONS = Object.freeze({
  inspect_mission: { description: 'Inspect bounded Autopilot mission state, inference evidence, ambiguities, progress and quality without dumping the dataset.', properties: {}, readOnly: true },
  run_autopilot: { description: 'Profile the loaded source, infer a target contract and deterministic mapping, dry-run it, and start execution automatically when no destructive ambiguity remains.', properties: { outcome: { type: 'string', enum: ['database_ready', 'clean_standardize', 'preserve_contract'], default: 'database_ready' } } },
  inspect_workspace: { description: 'Inspect workflow metadata only: phase, revisions, counts, fingerprints and valid next actions. Never dumps source or output rows.', properties: {}, readOnly: true },
  describe_supported_formats: { description: 'Describe accepted source/export formats, hard safety limits and local-only privacy behavior.', properties: {}, readOnly: true },
  inspect_source_schema: { description: 'Inspect inferred source fields, types and nullability without returning the full dataset.', properties: {}, readOnly: true, untrusted: true },
  inspect_source_sample: { description: 'Inspect a bounded source-row sample. User-provided cell content is untrusted.', properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 5 } }, readOnly: true, untrusted: true },
  define_target_schema: { description: 'Define the typed target contract. Every completed output row is validated against it.', properties: { fields: { type: 'array', minItems: 1, maxItems: 500, items: FIELD_SCHEMA } }, required: ['fields'] },
  inspect_schema_diff: { description: 'Compare source and target field sets before authoring transformations.', properties: {}, readOnly: true },
  set_mapping: { description: 'Set a draft deterministic transformation IR. Arbitrary JavaScript execution is not supported.', properties: { mapping: { type: 'array', minItems: 1, maxItems: 500, items: MAPPING_ENTRY_SCHEMA } }, required: ['mapping'] },
  validate_mapping: { description: 'Compile and safety-check the current mapping, then lock a new mapping revision.', properties: {} },
  preview_migration: { description: 'Run a bounded dry-run through the real transform and target-validation engine.', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 } }, readOnly: true, untrusted: true },
  revise_mapping: { description: 'Create a validated mapping revision. If a run is paused, continuation requires replay from row zero.', properties: { mapping: { type: 'array', minItems: 1, maxItems: 500, items: MAPPING_ENTRY_SCHEMA } }, required: ['mapping'] },
  start_migration: { description: 'Start the validated local migration worker at revision-consistent row zero.', properties: {} },
  get_run_state: { description: 'Get durable progress, checkpoint, mapping revision, replay status and last runtime error.', properties: {}, readOnly: true },
  pause_run: { description: 'Pause the active worker and persist an acknowledged durable checkpoint.', properties: {} },
  resume_run: { description: 'Resume a paused checkpoint, or replay from row zero when the mapping revision changed.', properties: {} },
  abort_run: { description: 'Abort the current paused/recovered/replaying migration and terminate its worker.', properties: {} },
  inspect_violations: { description: 'Inspect grouped violation classes with bounded row samples instead of dumping raw error volume.', properties: { code: { type: 'string', maxLength: 80 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } }, readOnly: true, untrusted: true },
  inspect_result: { description: 'Inspect a bounded sample of completed valid rows from one mapping revision.', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }, readOnly: true, untrusted: true },
  inspect_quality_report: { description: 'Inspect processed/valid/invalid counts, revision and violation class totals.', properties: {}, readOnly: true },
  export_csv: { description: 'Return the completed output as spreadsheet-injection-neutralized CSV.', properties: {}, readOnly: true },
  export_json: { description: 'Return the completed output as JSON.', properties: {}, readOnly: true },
  start_new_migration: { description: 'Reset terminal workflow state and begin a new local migration workspace.', properties: {} }
});

export function toolDefinitionForName(name) {
  const definition = DEFINITIONS[name] ?? { description: `Execute ${name}.`, properties: {} };
  const annotations = { readOnlyHint: Boolean(definition.readOnly) };
  if (definition.untrusted) annotations.untrustedContentHint = true;
  return {
    name,
    title: name.replaceAll('_', ' '),
    description: definition.description,
    inputSchema: {
      type: 'object',
      properties: definition.properties ?? {},
      required: definition.required ?? [],
      additionalProperties: false
    },
    annotations
  };
}

export function toolNamesForPhase(phase) {
  return [...(PHASE_TOOLS[phase] ?? [])].sort();
}

function makeTool(name, kernel) {
  return { ...toolDefinitionForName(name), execute: args => kernel.invoke(name, args ?? {}) };
}

export class TemporalRegistry {
  constructor({ modelContext, kernel, onChange = () => {} }) {
    this.modelContext = modelContext;
    this.kernel = kernel;
    this.onChange = onChange;
    this.controllers = new Map();
    this.phase = null;
  }

  async sync(phase) {
    const desired = new Set(toolNamesForPhase(phase));
    for (const [name, controller] of this.controllers) {
      if (!desired.has(name)) {
        controller.abort(new DOMException(`Tool ${name} is no longer valid in phase ${phase}`, 'AbortError'));
        this.controllers.delete(name);
      }
    }
    for (const name of desired) {
      if (this.controllers.has(name)) continue;
      const controller = new AbortController();
      await this.modelContext.registerTool(makeTool(name, this.kernel), { signal: controller.signal });
      this.controllers.set(name, controller);
    }
    this.phase = phase;
    this.onChange({ phase, tools: [...desired].sort() });
    return [...desired].sort();
  }

  dispose() {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }
}
