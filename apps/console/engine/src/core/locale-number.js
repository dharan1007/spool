import { fail } from './errors.js';

const CURRENCY_SYMBOL = '[$€£₹¥]';
const CURRENCY_CODE = '[A-Za-z]{3}';
const PREFIX = new RegExp(`^(?:${CURRENCY_SYMBOL}|${CURRENCY_CODE})\\s*`);
const SUFFIX = new RegExp(`\\s*(?:${CURRENCY_SYMBOL}|${CURRENCY_CODE})$`);
const CANONICAL_NUMBER = /^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;
const SINGLE_THREE_DIGIT_DOT = /^[+-]?\d{1,3}\.\d{3}$/;
const SINGLE_THREE_DIGIT_COMMA = /^[+-]?\d{1,3},\d{3}$/;
const US_GROUPED_WITH_DECIMAL = /^[+-]?\d{1,3}(?:,\d{3})+\.\d+$/;
const EU_GROUPED_WITH_DECIMAL = /^[+-]?\d{1,3}(?:\.\d{3})+,\d+$/;
const US_MULTI_GROUPED_INTEGER = /^[+-]?\d{1,3}(?:,\d{3}){2,}$/;
const EU_MULTI_GROUPED_INTEGER = /^[+-]?\d{1,3}(?:\.\d{3}){2,}$/;
const EU_DECIMAL = /^[+-]?\d+,\d+$/;

function stripCurrencyAffix(text) {
  let stripped = text.trim();
  stripped = stripped.replace(PREFIX, '').replace(SUFFIX, '').trim();
  return stripped;
}

function finite(value, original) {
  if (!Number.isFinite(value)) fail('INVALID_NUMBER', `Cannot convert ${original} to a finite number`);
  return value;
}

export function parseDeterministicNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  if (typeof value === 'number') return finite(value, value);

  const original = String(value);
  const text = stripCurrencyAffix(original);
  if (!text) fail('INVALID_NUMBER', `Cannot convert ${original} to number`);

  const hasComma = text.includes(',');
  const dotCount = (text.match(/\./g) ?? []).length;
  const commaCount = (text.match(/,/g) ?? []).length;

  if (hasComma && dotCount > 0) {
    if (US_GROUPED_WITH_DECIMAL.test(text)) return finite(Number(text.replaceAll(',', '')), original);
    if (EU_GROUPED_WITH_DECIMAL.test(text)) return finite(Number(text.replaceAll('.', '').replace(',', '.')), original);
    fail('AMBIGUOUS_NUMBER_FORMAT', `Number format is ambiguous: ${original}`);
  }

  if (SINGLE_THREE_DIGIT_COMMA.test(text) || SINGLE_THREE_DIGIT_DOT.test(text)) {
    fail('AMBIGUOUS_NUMBER_FORMAT', `Number format is ambiguous: ${original}`);
  }

  if (commaCount > 0) {
    if (US_MULTI_GROUPED_INTEGER.test(text)) return finite(Number(text.replaceAll(',', '')), original);
    if (commaCount === 1 && EU_DECIMAL.test(text)) return finite(Number(text.replace(',', '.')), original);
    fail('AMBIGUOUS_NUMBER_FORMAT', `Number format is ambiguous: ${original}`);
  }

  if (dotCount > 1) {
    if (EU_MULTI_GROUPED_INTEGER.test(text)) return finite(Number(text.replaceAll('.', '')), original);
    fail('AMBIGUOUS_NUMBER_FORMAT', `Number format is ambiguous: ${original}`);
  }

  if (!CANONICAL_NUMBER.test(text)) fail('INVALID_NUMBER', `Cannot convert ${original} to number`);
  return finite(Number(text), original);
}
