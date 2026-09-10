import { fail } from './errors.js';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;
const CANONICAL_LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/;
const AMBIGUOUS_NUMERIC_DATE = /^\d{1,4}[/.]\d{1,2}[/.]\d{1,4}$/;
const TEXT_DAY_MONTH = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/;
const TEXT_MONTH_DAY = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/;

const MONTHS = new Map([
  ['jan', 1], ['january', 1],
  ['feb', 2], ['february', 2],
  ['mar', 3], ['march', 3],
  ['apr', 4], ['april', 4],
  ['may', 5],
  ['jun', 6], ['june', 6],
  ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8],
  ['sep', 9], ['sept', 9], ['september', 9],
  ['oct', 10], ['october', 10],
  ['nov', 11], ['november', 11],
  ['dec', 12], ['december', 12]
]);

function utcDate(year, month, day, original) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) fail('INVALID_DATE', `Invalid date ${original}`);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    fail('INVALID_DATE', `Invalid date ${original}`);
  }
  return date.toISOString();
}

function validateLocalDateTimeMatch(match, original) {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
      || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    fail('INVALID_LOCAL_DATETIME', `Invalid local datetime ${original}`);
  }
  const fraction = match[7] ? `.${match[7]}` : '';
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${String(second).padStart(2, '0')}${fraction}`;
}

export function parseDeterministicLocalDateTime(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const original = String(value);
  const text = original.trim();
  const match = LOCAL_DATETIME.exec(text);
  if (!match) fail('INVALID_LOCAL_DATETIME', `Unsupported local datetime format: ${original}`);
  return validateLocalDateTimeMatch(match, original);
}

export function isDeterministicLocalDateTime(value) {
  try {
    return parseDeterministicLocalDateTime(value) !== null;
  } catch {
    return false;
  }
}

export function isCanonicalLocalDateTime(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  const match = CANONICAL_LOCAL_DATETIME.exec(text);
  if (!match) return false;
  try {
    return validateLocalDateTimeMatch(match, value) === text;
  } catch {
    return false;
  }
}

function textualMatch(text, original) {
  let match = TEXT_DAY_MONTH.exec(text);
  if (match) {
    const month = MONTHS.get(match[2].toLowerCase());
    if (!month) fail('INVALID_DATE', `Unknown month in ${original}`);
    return utcDate(Number(match[3]), month, Number(match[1]), original);
  }
  match = TEXT_MONTH_DAY.exec(text);
  if (match) {
    const month = MONTHS.get(match[1].toLowerCase());
    if (!month) fail('INVALID_DATE', `Unknown month in ${original}`);
    return utcDate(Number(match[3]), month, Number(match[2]), original);
  }
  return null;
}

export function parseDeterministicDate(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const original = String(value);
  const text = original.trim();

  const isoDate = ISO_DATE.exec(text);
  if (isoDate) return utcDate(Number(isoDate[1]), Number(isoDate[2]), Number(isoDate[3]), original);

  if (ISO_INSTANT.test(text)) {
    const timestamp = Date.parse(text);
    if (Number.isNaN(timestamp)) fail('INVALID_DATE', `Invalid date ${original}`);
    return new Date(timestamp).toISOString();
  }

  if (AMBIGUOUS_NUMERIC_DATE.test(text) || /^\d{1,2}-\d{1,2}-\d{4}$/.test(text)) {
    fail('AMBIGUOUS_DATE_FORMAT', `Date format is ambiguous: ${original}`);
  }

  const textual = textualMatch(text, original);
  if (textual) return textual;
  fail('INVALID_DATE', `Unsupported deterministic date format: ${original}`);
}

export function isDeterministicDate(value) {
  try {
    return parseDeterministicDate(value) !== null;
  } catch {
    return false;
  }
}

export function isCanonicalDate(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!ISO_DATE.test(text) && !ISO_INSTANT.test(text)) return false;
  try {
    return parseDeterministicDate(text) !== null;
  } catch {
    return false;
  }
}
