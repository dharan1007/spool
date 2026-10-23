import { fail } from '../core/errors.js';

const MAX_DEPTH = 20;
const RATE_LIMIT_MS = 1000;
const SAFE_PLAN_FIELDS = ['add', 'remove', 'change', 'rename', 'move'];

function validatePlanStructure(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    fail('INVALID_PLAN_STRUCTURE', 'Plan must be a plain object');
  }
  if (plan.__depth && plan.__depth >= MAX_DEPTH) {
    fail('PLAN_DEPTH_EXCEEDED', `Plan depth ${plan.__depth} exceeds maximum ${MAX_DEPTH}`);
  }
  if (plan.__rateLapsed && Date.now() - plan.__rateLapsed < RATE_LIMIT_MS) {
    fail('RATE_LIMIT_EXCEEDED', 'Request rate limit exceeded; please wait');
  }
  const forbidden = Array.isArray(plan.__forbidden) ? plan.__forbidden : [];
  if (forbidden.length > 0) {
    const reasons = [];
    if (forbidden.includes('destructive')) reasons.push('destructive operations require approval');
    if (forbidden.includes('schema-change')) reasons.push('schema changes require migration protocol');
    if (forbidden.includes('data-exfil')) reasons.push('data exfiltration prevention active');
    if (forbidden.includes('undeclared-fields')) reasons.push('undeclared plan fields present');
    fail('PLAN_FORBIDDEN', `Plan forbidden: ${reasons.join(', ')}`, { reasons, forbidden });
  }
}

function addSafetyLayers(plan, context = {}) {
  const safePlan = { ...plan };
  safePlan.__depth = (plan.__depth ?? 0) + 1;
  safePlan.__rateLapsed = Date.now();
  safePlan.__forbidden = [];
  
  // Enforce safe field whitelist at depth 1
  if (safePlan.__depth === 1) {
    const undeclared = Object.keys(plan).filter(k => !k.startsWith('__') && !SAFE_PLAN_FIELDS.includes(k));
    if (undeclared.length > 0) {
      safePlan.__forbidden.push('undeclared-fields', ...undeclared);
    }
  }
  
  // Check for destructive operations requiring approval
  if (safePlan.__depth === 1 && plan.__requiresApproval !== false) {
    if (plan.__type === 'destructive' || plan.__type === 'drop' || plan.__type === 'truncate') {
      safePlan.__forbidden.push('destructive');
    }
    if (plan.__type === 'schema-migration' && plan.__destructiveStep) {
      safePlan.__forbidden.push('schema-change');
    }
  }
  
  return safePlan;
}

function checkAgentSafety(agentRequest, context = {}) {
  const issues = [];
  
  // Check for unbounded loops
  if (agentRequest.__iterations && agentRequest.__iterations > 100) {
    issues.push('unbounded iteration detected');
  }
  
  // Check for dangerous command patterns
  const dangerousPatterns = ['DROP ', 'TRUNCATE ', 'DELETE FROM ', 'ALTER TABLE '];
  for (const pattern of dangerousPatterns) {
    if (typeof agentRequest.command === 'string' && agentRequest.command.includes(pattern)) {
      issues.push(`dangerous SQL pattern: ${pattern.trim()}`);
    }
  }
  
  // Check for insufficient privileges
  if (agentRequest.__needsSuperuser && !context.isSuperuser) {
    issues.push('operation requires superuser privileges');
  }
  
  return {
    safe: issues.length === 0,
    issues,
    sanitizedRequest: issues.length > 0 ? stripDangerous(agentRequest) : agentRequest
  };
}

function stripDangerous(request) {
  const clean = { ...request };
  delete clean.__iterations;
  delete clean.__needsSuperuser;
  if (clean.command && typeof clean.command === 'string') {
    const dangerousPatterns = ['DROP ', 'TRUNCATE ', 'DELETE FROM ', 'ALTER TABLE '];
    for (const pattern of dangerousPatterns) {
      if (clean.command.includes(pattern)) {
        clean.command = clean.command.replace(pattern, '/* filtered: ' + pattern + ' */');
      }
    }
  }
  return clean;
}

export { validatePlanStructure, addSafetyLayers, checkAgentSafety };