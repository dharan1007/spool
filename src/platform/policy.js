import { fail } from '../core/errors.js';

function stringSet(values, code, label) {
  if (!Array.isArray(values)) fail(code, `${label} must be an array`);
  const out = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) fail(code, `${label} entries must be non-empty strings`);
    out.add(value);
  }
  return out;
}

export function evaluatePlanPolicy(plan, policy = { allow: [] }) {
  if (!plan?.risk || typeof plan.risk !== 'object') fail('INVALID_PLAN_POLICY', 'Plan risk metadata is required');
  const required = stringSet(plan.risk.approvals ?? [], 'INVALID_PLAN_POLICY', 'risk.approvals');
  const allowed = stringSet(policy?.allow ?? [], 'INVALID_POLICY', 'policy.allow');
  const requiredApprovals = [...required].sort();
  const missingApprovals = requiredApprovals.filter(approval => !allowed.has(approval));
  return {
    allowed: missingApprovals.length === 0,
    requiredApprovals,
    missingApprovals
  };
}
