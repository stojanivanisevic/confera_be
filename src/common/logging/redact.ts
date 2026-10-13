import { Secret } from '../../config/secret';

/**
 * Redaction for everything that is logged (ADR-19, finding SEC-A-28, NFR-PRIV-04).
 *
 * Two rules, applied to every log entry before it is written:
 * 1. A property whose NAME is on the list below is replaced as a whole, whatever it holds.
 * 2. Inside any text, the credentials of a connection address are cut out.
 *
 * The list is by name on purpose: a new field called `password` or `token` is covered
 * the day it appears. Request bodies are never logged; `body` is on the list so that a
 * careless `logger.log({ body })` stays empty too.
 */

export const REDACTED = '[redacted]';

/**
 * Names that are always redacted. Matching ignores case and the separators `-` and `_`,
 * and looks for the word anywhere in the name (`newPassword`, `x-csrf-token`, `setCookie`).
 */
export const REDACTED_NAME_PARTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'authorisation',
  'cookie',
  'csrf',
  'credential',
  'apikey',
  'privatekey',
  'datakey',
  'hash',
  'signature',
  'databaseurl',
  'connectionstring',
] as const;

/** Names that are redacted only as an exact match. */
export const REDACTED_EXACT_NAMES = ['body', 'rawbody', 'dsn', 'pass', 'pwd', 'key'] as const;

const MAX_DEPTH = 8;
const MAX_TEXT = 4000;

function normalise(name: string): string {
  return name.toLowerCase().replace(/[-_\s]/g, '');
}

export function isRedactedName(name: string): boolean {
  const normalised = normalise(name);
  return (
    REDACTED_EXACT_NAMES.some((exact) => exact === normalised) ||
    REDACTED_NAME_PARTS.some((part) => normalised.includes(part))
  );
}

// scheme://user:password@host  ->  scheme://[redacted]@host
const CREDENTIALS_IN_ADDRESS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]*:[^\s/@]*@/gi;
// password=... or password: ... inside a text, for example in a driver's message
const INLINE_SECRET =
  /\b(pass(?:word|wd)?|pwd|secret|token)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;&]+)/gi;

/** Cuts credentials out of a text and caps its length. */
export function scrubText(text: string): string {
  const scrubbed = text
    .replace(CREDENTIALS_IN_ADDRESS, `$1${REDACTED}@`)
    .replace(INLINE_SECRET, `$1=${REDACTED}`);
  return scrubbed.length > MAX_TEXT ? `${scrubbed.slice(0, MAX_TEXT)}...[cut]` : scrubbed;
}

function redactError(error: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: error.name,
    message: scrubText(error.message),
  };
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') {
    out.code = code;
  }
  if (typeof error.stack === 'string') {
    out.stack = scrubText(error.stack);
  }
  if (error.cause !== undefined) {
    out.cause = redactValue(error.cause, depth + 1, seen);
  }
  return out;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return scrubText(value);
  }
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? value.toString() : value;
  }
  if (value instanceof Secret) {
    return REDACTED;
  }
  if (value instanceof Date) {
    return value;
  }
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    return '[binary]';
  }
  if (seen.has(value)) {
    return '[circular]';
  }
  if (depth >= MAX_DEPTH) {
    return '[too deep]';
  }
  seen.add(value);
  if (value instanceof Error) {
    return redactError(value, depth, seen);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }
  if (value instanceof Map) {
    return redactValue(Object.fromEntries(value), depth, seen);
  }
  if (value instanceof Set) {
    return redactValue([...value], depth, seen);
  }
  const out: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value)) {
    out[name] = isRedactedName(name) ? REDACTED : redactValue(item, depth + 1, seen);
  }
  return out;
}

/** Returns a copy of `value` that is safe to log. Never changes its argument. */
export function redact(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet());
}
