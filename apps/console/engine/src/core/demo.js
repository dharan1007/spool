export function createDemoCsv(count = 25000) {
  const countries = ['India', 'United States', 'United Kingdom', 'Germany', 'France'];
  const plans = ['starter', 'growth', 'scale'];
  const lines = ['cust_id,full_name,phone,country,joined,plan_name,monthly_fee,is_active'];
  for (let i = 0; i < count; i++) {
    const id = ` CUST-${String(i + 1).padStart(6, '0')} `;
    const name = `Customer ${i + 1}`;
    const phone = `+91${String(7000000000 + (i % 2000000000))}`;
    const country = countries[i % countries.length];
    const joined = i > 0 && i % 1231 === 0 ? 'bad-date' : new Date(Date.UTC(2024 + (i % 3), i % 12, (i % 27) + 1)).toISOString().slice(0, 10);
    const plan = plans[i % plans.length];
    const fee = i > 0 && i % 997 === 0 ? 'unknown' : (19 + (i % 5) * 10 + 0.99).toFixed(2);
    const active = i % 7 === 0 ? 'false' : 'true';
    lines.push([id, name, phone, country, joined, plan, fee, active].join(','));
  }
  return lines.join('\r\n');
}

export function demoTargetSchema() {
  return [
    { name: 'customer_id', type: 'string', nullable: false },
    { name: 'full_name', type: 'string', nullable: false },
    { name: 'phone_e164', type: 'string', nullable: false },
    { name: 'country_iso2', type: 'string', nullable: false },
    { name: 'joined_at', type: 'date', nullable: false },
    { name: 'subscription_tier', type: 'string', nullable: false },
    { name: 'monthly_fee_cents', type: 'number', nullable: false },
    { name: 'status', type: 'string', nullable: false }
  ];
}

export function demoMapping() {
  return [
    { target: 'customer_id', expr: { op: 'trim', value: { op: 'field', name: 'cust_id' } } },
    { target: 'full_name', expr: { op: 'trim', value: { op: 'field', name: 'full_name' } } },
    { target: 'phone_e164', expr: { op: 'trim', value: { op: 'field', name: 'phone' } } },
    { target: 'country_iso2', expr: { op: 'enum_map', value: { op: 'field', name: 'country' }, map: { India: 'IN', 'United States': 'US', 'United Kingdom': 'GB', Germany: 'DE', France: 'FR' } } },
    { target: 'joined_at', expr: { op: 'parse_date', value: { op: 'field', name: 'joined' } } },
    { target: 'subscription_tier', expr: { op: 'uppercase', value: { op: 'field', name: 'plan_name' } } },
    { target: 'monthly_fee_cents', expr: { op: 'round', value: { op: 'multiply', left: { op: 'cast_number', value: { op: 'field', name: 'monthly_fee' } }, right: { op: 'literal', value: 100 } } } },
    { target: 'status', expr: { op: 'enum_map', value: { op: 'field', name: 'is_active' }, map: { true: 'active', false: 'inactive' } } }
  ];
}


function expressionForTargetType(fieldName, targetType) {
  const source = { op: 'field', name: fieldName };
  if (targetType === 'integer' || targetType === 'number') return { op: 'cast_number', value: source };
  if (targetType === 'boolean') return { op: 'cast_boolean', value: source };
  if (targetType === 'date') return { op: 'parse_date', value: source };
  return { op: 'trim', value: source };
}

export function starterMappingForTarget(targetSchema, sourceSchema) {
  const sourceNames = new Set(sourceSchema.map(field => field.name));
  return targetSchema.map(target => ({
    target: target.name,
    expr: sourceNames.has(target.name)
      ? expressionForTargetType(target.name, target.type)
      : { op: 'literal', value: null }
  }));
}

export function mirrorPlanFromSourceSchema(sourceSchema) {
  const targetSchema = sourceSchema.map(field => ({ name: field.name, type: field.type, nullable: field.nullable }));
  const mapping = sourceSchema.map(field => {
    const source = { op: 'field', name: field.name };
    let expr = source;
    if (field.type === 'integer' || field.type === 'number') expr = { op: 'cast_number', value: source };
    else if (field.type === 'boolean') expr = { op: 'cast_boolean', value: source };
    else if (field.type === 'date') expr = { op: 'parse_date', value: source };
    else expr = { op: 'trim', value: source };
    return { target: field.name, expr };
  });
  return { targetSchema, mapping };
}
