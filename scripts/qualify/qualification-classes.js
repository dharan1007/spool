// Qualification classes describe certification obligations, NOT the scale
// of a particular benchmark. A workload profile cannot grant a class.
export const QUALIFICATION_CLASSES = Object.freeze([
  'NOT_QUALIFIED', 'CI_CORRECTNESS', 'PILOT', 'SMALL_PRODUCTION',
  'MEDIUM_PRODUCTION', 'LARGE_PRODUCTION', 'INDUSTRIAL'
]);

const COMMON = Object.freeze([
  'exact_source_and_target_state', 'trusted_source_and_target_contract',
  'independent_content_verification', 'zero_unexplained_loss_or_duplicates',
  'verified_provenance', 'executable_mandatory_ci', 'verified_security_gate'
]);

export const QUALIFICATION_REQUIREMENTS = Object.freeze({
  CI_CORRECTNESS: Object.freeze({ minRows: 100_000, minCdcSeconds: 30,
    gates: Object.freeze([...COMMON, 'real_postgres_conformance', 'ddl_and_exact_cardinality']) }),
  PILOT: Object.freeze({ minRows: 1_000_000, minCdcSeconds: 3600,
    gates: Object.freeze([...COMMON, 'real_postgres_conformance', 'ddl_and_exact_cardinality',
      'natural_lease_takeover_sigkill', 'source_snapshot_to_cdc_handoff', 'audit_and_identity']) }),
  SMALL_PRODUCTION: Object.freeze({ minRows: 10_000_000, minCdcSeconds: 24 * 3600,
    gates: Object.freeze([...COMMON, 'real_postgres_conformance', 'ddl_and_exact_cardinality',
      'natural_lease_takeover_sigkill', 'source_snapshot_to_cdc_handoff', 'audit_and_identity',
      'toast_and_1gb_spill', 'ambiguous_commit', 'wal_slot_and_restart', 'repair_cutover_crash']) }),
  MEDIUM_PRODUCTION: Object.freeze({ minRows: 100_000_000, minCdcSeconds: 72 * 3600,
    gates: Object.freeze([...COMMON, 'real_postgres_conformance', 'ddl_and_exact_cardinality',
      'natural_lease_takeover_sigkill', 'source_snapshot_to_cdc_handoff', 'audit_and_identity',
      'toast_and_1gb_spill', 'ambiguous_commit', 'wal_slot_and_restart', 'repair_cutover_crash',
      'ha_promotion', 'network_tls_dns_rotation', 'disk_fsync_faults', 'upgrade_rollback']) }),
  LARGE_PRODUCTION: Object.freeze({ minRows: 1_000_000_000, minCdcSeconds: 7 * 24 * 3600,
    gates: Object.freeze([...COMMON, 'real_postgres_conformance', 'ddl_and_exact_cardinality',
      'natural_lease_takeover_sigkill', 'source_snapshot_to_cdc_handoff', 'audit_and_identity',
      'toast_and_1gb_spill', 'ambiguous_commit', 'wal_slot_and_restart', 'repair_cutover_crash',
      'ha_promotion', 'network_tls_dns_rotation', 'disk_fsync_faults', 'upgrade_rollback',
      'multiworker_fencing', 'seven_day_soak', 'measured_slo_rpo_rto']) }),
  INDUSTRIAL: Object.freeze({ minRows: 1_000_000_000, minCdcSeconds: 7 * 24 * 3600,
    gates: Object.freeze([...COMMON, 'real_postgres_conformance', 'ddl_and_exact_cardinality',
      'natural_lease_takeover_sigkill', 'source_snapshot_to_cdc_handoff', 'audit_and_identity',
      'toast_and_1gb_spill', 'ambiguous_commit', 'wal_slot_and_restart', 'repair_cutover_crash',
      'ha_promotion', 'network_tls_dns_rotation', 'disk_fsync_faults', 'upgrade_rollback',
      'multiworker_fencing', 'seven_day_soak', 'measured_slo_rpo_rto',
      'externally_verified_enterprise_identity_and_sod', 'independent_certification',
      'kms_hsm_key_rotation', 'otel_siem', 'signed_sbom_provenance',
      'published_platform_matrix', 'operator_drills_sla']) })
});

const REQUIRED_DENIAL_REASONS = Object.freeze([
  'MANDATORY_CI_NOT_ATTESTED', 'INDEPENDENT_FAILURE_MATRIX_NOT_ATTESTED',
  'SECURITY_AND_ENTERPRISE_GATES_NOT_ATTESTED'
]);

export function developmentQualification({ runId, commitSha, profile }) {
  if (typeof runId !== 'string' || !runId.trim()
      || typeof commitSha !== 'string' || !commitSha.trim()
      || typeof profile !== 'string' || !profile.trim()) {
    throw new Error('Development qualification requires exact run, commit and workload identities');
  }
  return Object.freeze({
    schemaVersion: 1,
    class: 'NOT_QUALIFIED',
    evidenceType: 'DEVELOPMENT_HARNESS_ONLY',
    runId, commitSha, profile,
    reasonCodes: REQUIRED_DENIAL_REASONS
  });
}

// This verifier does NOT accept a producer-supplied attestation of higher
// standing. Positive classes require a separate trusted attestation verifier,
// which is intentionally not implemented by the development harness.
export function assertDevelopmentQualification(record, { runId, commitSha, profile } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Qualification record is required');
  if (record.schemaVersion !== 1 || record.class !== 'NOT_QUALIFIED'
      || record.evidenceType !== 'DEVELOPMENT_HARNESS_ONLY') {
    throw new Error('Development evidence cannot assert an earned production qualification class');
  }
  if (record.runId !== runId || record.commitSha !== commitSha || record.profile !== profile) {
    throw new Error('Qualification record is not bound to the evidence run, commit and workload');
  }
  if (!Array.isArray(record.reasonCodes)
      || record.reasonCodes.length !== REQUIRED_DENIAL_REASONS.length
      || record.reasonCodes.some((reason, i) => reason !== REQUIRED_DENIAL_REASONS[i])) {
    throw new Error('Qualification denial reasons must be complete and canonical');
  }
  return true;
}
