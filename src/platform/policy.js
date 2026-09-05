import { fail } from '../core/errors.js';

const APPROVAL = /^[a-z][a-z0-9_:-]{0,127}$/;

function normalizeApprovalList(value, code, label) {
  if (!Array.isArray(value)) fail(code, `${label} must be an array`);
  const out = [];
  for (const approval of value) {
    if (typeof approval !== 'string' || !APPROVAL.test(approval)) fail(code, `${label} contains an invalid approval identifier`);
    if (!out.includes(approval)) out.push(approval);
  }
  return out.sort();
}

export function evaluatePlanPolicy(plan, policy = { allow: [] }) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('INVALID_POLICY_INPUT', 'Plan must be an object');
  if (!plan.risk || typeof plan.risk !== 'object' || Array.isArray(plan.risk)) fail('INVALID_POLICY_INPUT', 'Plan risk policy is required');
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) fail('INVALID_POLICY', 'Policy must be an object');
  const unknownPolicyKeys = Object.keys(policy).filter(key => key !== 'allow');
  if (unknownPolicyKeys.length) fail('INVALID_POLICY', `Unsupported policy field ${unknownPolicyKeys[0]}`);

  const requiredApprovals = normalizeApprovalList(plan.risk.approvals, 'INVALID_POLICY_INPUT', 'plan.risk.approvals');
  const allowedApprovals = normalizeApprovalList(policy.allow, 'INVALID_POLICY', 'policy.allow');
  const allowed = new Set(allowedApprovals);
  const missingApprovals = requiredApprovals.filter(approval => !allowed.has(approval));
  return Object.freeze({
    allowed: missingApprovals.length === 0,
    requiredApprovals: Object.freeze(requiredApprovals),
    missingApprovals: Object.freeze(missingApprovals)
  });
}
