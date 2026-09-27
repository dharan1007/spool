// Metadata bootstrap is a per-PostgreSQL-connection/target cache hint.
// A target table name by itself does NOT identify a server or tenant.
// Never include resolved passwords in the key.
export function postgresMetadataCacheKey(targetRef) {
  if (!targetRef || typeof targetRef !== 'object' || Array.isArray(targetRef)) {
    throw new TypeError('PostgreSQL metadata cache requires a targetRef');
  }
  const identity = [
    targetRef.endpoint, targetRef.database, targetRef.identity?.user,
    targetRef.secretRef?.provider, targetRef.secretRef?.key,
    targetRef.schema, targetRef.table
  ];
  if (identity.some(value => typeof value !== 'string' || value.length === 0 || value.includes('\0'))) {
    throw new TypeError('Incomplete PostgreSQL metadata cache identity');
  }
  // JSON encoding avoids delimiter collisions between maliciously chosen
  // database, username, schema, table or secret-reference names.
  return JSON.stringify(identity);
}
