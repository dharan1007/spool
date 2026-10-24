# Mapping guide

## What a mapping entry is

```json
{ "target": "monthly_fee", "expr": {
  "op": "cast_number",
  "value": { "op": "field", "name": "monthly_fee" } } }
```

- `target` must be a column of the chosen target schema (existing ordinary
  SQLite columns projected into the wizard).
- `expr` is an expression tree over the engine's allow-listed operators.
- Compilation happens **inside the engine** (`compileMapping`); the Console
  only pre-validates for UX (duplicate/unknown targets, coverage), never to
  loosen engine rules.

## Operator allow-list highlights

| Operator | Use for | Notes |
| --- | --- | --- |
| `field` | copy a source column verbatim | |
| `trim` | strip surrounding whitespace | default for string targets |
| `cast_number` | numeric targets (integer/number affinity) | deterministic parse; violations are explicit |
| `cast_boolean` | boolean targets | source must represent booleans |
| `parse_date` | DATE targets | `options.outputFormat` seconds format; ambiguous day/month orders are NOT guessed |
| `enum_map` | exact value translation | e.g. `"true"/"false"` → `1/0` for INTEGER targets; unmapped keys raise `UNMAPPED_ENUM` |

Prohibited by the engine everywhere: dynamic evaluation, shell-outs, regex
modifiers beyond bounded patterns, expressions that touch anything other than
the current row.

## Common pattern: boolean CSV columns into INTEGER targets

SQLite `INTEGER NOT NULL` suggests target type `integer`. `cast_number`
cannot read `true/false`; the correct allow-listed shape is:

```json
{ "target": "is_active", "expr": {
  "op": "cast_number",
  "value": {
    "op": "enum_map",
    "value": { "op": "trim", "value": { "op": "field", "name": "is_active" } },
    "map": { "true": 1, "false": 0 } } } }
```

The full journey test covers exactly this shape (`tests/full-journey.test.js`).

## Validation UX vs truth

`mapping.validate` returns problems (`DUPLICATE_TARGET`, `UNKNOWN_TARGET`,
`UNMAPPED_TARGET`, `UNKNOWN_SOURCE`) using the engine compile plus schema
cross-check. `MAPPING_INCOMPLETE` means the plan cannot be created: the engine
would reject it, so the Console refuses earlier with a clearer envelope.

## Recipes and drafts

- A **draft** is an unsaved wizard design (state JSON, versioned by id).
- A **recipe** is a reusable mapping description pinned to a schema signature
  (`spool-console-recipe-schema-v1`) and the operator version. Applying a
  recipe whose signature mismatches the live target schema is flagged
  `INCOMPATIBLE` and never silently coerced.
- Imported recipes are marked `REVIEW_REQUIRED`: they do not skip preflight,
  dry-run or approval. A recipe never authorizes anything by itself.
