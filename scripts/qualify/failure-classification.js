// Expected refusals are a narrow, explicit proof class. A missing field or
// one-sided label is an unexpected failure, not grounds for a green gate.
export function isExpectedRefusal(failure) {
  return failure !== null
    && typeof failure === 'object'
    && !Array.isArray(failure)
    && failure.expected === true
    && failure.classification === 'EXPECTED_REFUSAL'
    && typeof failure.code === 'string'
    && failure.code.length > 0;
}

export function isUnexpectedFailure(failure) {
  return !isExpectedRefusal(failure);
}

export function foldScenarioFailures(returnedFailures) {
  const list = Array.isArray(returnedFailures) ? [...returnedFailures] : [];
  const unexpected = list.filter(isUnexpectedFailure);
  return Object.freeze({
    failures: Object.freeze(list),
    unexpected: Object.freeze([...unexpected]),
    status: unexpected.length ? 'FAIL' : 'PASS'
  });
}

// wal_level=replica can support physical replication but not the logical
// decoding required by SPOOL's PostgreSQL CDC qualification.
export function isLogicalWalLevel(value) {
  return value === 'logical';
}
