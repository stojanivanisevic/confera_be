import { isMailAddress } from '../../common/validation/mail-address';
import { ABSOLUTE_LIMITS, PATTERNS } from './catalogue';
import type { FieldDefinition, FormDefinition, SectionDefinition } from './definition';
import { codePoints } from './safe-text';

/**
 * The rule interpreter (ADR-09, M3-BE-02): the answers of a submission against the
 * definition of its form version. The web application runs its own copy in the browser;
 * both must pass contracts/form-rule-vectors.json, which is the contract between them.
 *
 * - Answers are read into a key-checked structure: a key that the definition does not have
 *   is refused (`unknownField`), `__proto__` and `constructor` included.
 * - No code is evaluated: patterns come from the catalogue in code, by name.
 * - A field that is not shown (its condition is not met, or its section is hidden) is not
 *   checked and not kept: a value the browser still holds for it is dropped.
 * - Errors come back as the path of the field and a code: `title`, `authors[2].email`.
 *   The index of a block starts at 0; the message says "author 3".
 */
export type AnswerValue = string | boolean;

/** The answers of a submission as they are kept: a value per shown field, the authors as a list of blocks. */
export type Answers = Record<string, AnswerValue | Record<string, AnswerValue>[]>;

export interface RuleError {
  readonly path: string;
  readonly code: RuleCode;
}

export const RULE_CODES = [
  /** Empty, and the field is required (for a consent: not given). */
  'required',
  /** A value of the wrong JSON type (a number where a text belongs, a list where a block belongs). */
  'wrongType',
  /** A key the definition does not have. */
  'unknownField',
  /** More characters than the field takes. */
  'tooLong',
  /** More words than the field takes. */
  'tooManyWords',
  /** The text does not have the field's pattern. */
  'pattern',
  /** An address, `www.` or a mail address where none may be. */
  'noUrl',
  /** Not one plain email address (the address rule). */
  'notAnEmail',
  /** Not one of the field's options. */
  'notAnOption',
  /** A control or an invisible direction character. */
  'invalidCharacters',
  /** Fewer blocks than the section needs, or more than it takes. */
  'tooFewItems',
  'tooManyItems',
] as const;
export type RuleCode = (typeof RULE_CODES)[number];

/** Words as both interpreters count them: runs of characters between white space. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/u).length;
}

/**
 * The URL rule of names, titles and institutions (ADR-08, item 5): a text that holds an
 * address is refused, because the title travels in the confirmation email and mail
 * programs make links of addresses. Refused: a scheme with `//` (`https://`, `ftp://`),
 * `www.`, `mailto:`, a mail address, and a host name followed by a path (`example.org/x`).
 * A dotted word alone (`ASP.NET`, `Node.js`) is a word.
 */
export function hasUrl(text: string): boolean {
  return (
    /[a-z][a-z0-9+.-]*:\/\//iu.test(text) ||
    /(^|[^\p{L}\p{N}])www\./iu.test(text) ||
    /mailto:/iu.test(text) ||
    /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+/u.test(text) ||
    /(^|[^\p{L}\p{N}@])[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,}\/[^\s]/iu.test(text)
  );
}

/** Control characters (a line break and a tab only in a long text) and the invisible direction characters. */
function hasForbiddenCharacters(text: string, multiline: boolean): boolean {
  const controls = multiline
    ? // eslint-disable-next-line no-control-regex
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u
    : // eslint-disable-next-line no-control-regex
      /[\u0000-\u001F\u007F]/u;
  return controls.test(text) || /[\u202A-\u202E\u2066-\u2069\u200E\u200F\uFEFF]/u.test(text);
}

/** Does a condition hold for the top-level answers given? */
function holds(
  condition: { field: string; in: readonly string[] } | null,
  top: Readonly<Record<string, unknown>>,
): boolean {
  if (condition === null) {
    return true;
  }
  const value = Object.hasOwn(top, condition.field) ? top[condition.field] : undefined;
  return typeof value === 'string' && condition.in.includes(value.normalize('NFC').trim());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One value against its field. Returns the kept value, nothing when empty, or the error code. */
function checkValue(
  field: FieldDefinition,
  raw: unknown,
): { value?: AnswerValue } | { code: RuleCode } {
  const empty = raw === undefined || raw === null || raw === '' || raw === false;
  if (field.kind === 'consent') {
    if (raw !== undefined && raw !== null && typeof raw !== 'boolean') {
      return { code: 'wrongType' };
    }
    if (raw !== true) {
      return field.required ? { code: 'required' } : {};
    }
    return { value: true };
  }
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    return { code: 'wrongType' };
  }
  const text = typeof raw === 'string' ? raw.normalize('NFC').trim() : '';
  if (empty || text === '') {
    return field.required ? { code: 'required' } : {};
  }
  if (
    codePoints(text) >
    Math.min(field.rules.maxLength ?? ABSOLUTE_LIMITS.maxLength, ABSOLUTE_LIMITS.maxLength)
  ) {
    return { code: 'tooLong' };
  }
  switch (field.kind) {
    case 'choice':
    case 'yesNo':
      return (field.options ?? []).some((option) => option.value === text)
        ? { value: text }
        : { code: 'notAnOption' };
    case 'file':
      return UUID.test(text) ? { value: text } : { code: 'wrongType' };
    case 'email': {
      if (hasForbiddenCharacters(text, false) || !isMailAddress(text)) {
        return { code: 'notAnEmail' };
      }
      const at = text.lastIndexOf('@');
      return { value: `${text.slice(0, at)}@${text.slice(at + 1).toLowerCase()}` };
    }
    default:
      break;
  }
  if (hasForbiddenCharacters(text, field.kind === 'longText')) {
    return { code: 'invalidCharacters' };
  }
  if (field.rules.maxWords !== null && countWords(text) > field.rules.maxWords) {
    return { code: 'tooManyWords' };
  }
  if (field.rules.pattern !== null && !new RegExp(PATTERNS[field.rules.pattern], 'u').test(text)) {
    return { code: 'pattern' };
  }
  if (field.rules.noUrl && hasUrl(text)) {
    return { code: 'noUrl' };
  }
  return { value: text };
}

function checkFields(
  fields: readonly FieldDefinition[],
  given: Readonly<Record<string, unknown>>,
  top: Readonly<Record<string, unknown>>,
  prefix: string,
  index: number | null,
  errors: RuleError[],
): Record<string, AnswerValue> {
  const kept: Record<string, AnswerValue> = {};
  for (const field of fields) {
    const shown =
      holds(field.visibleWhen, top) && !(field.onlyFirstInRepeat && index !== null && index > 0);
    if (!shown) {
      continue;
    }
    const raw = Object.hasOwn(given, field.key) ? given[field.key] : undefined;
    const result = checkValue(field, raw);
    if ('code' in result) {
      errors.push({ path: `${prefix}${field.key}`, code: result.code });
    } else if (result.value !== undefined) {
      kept[field.key] = result.value;
    }
  }
  return kept;
}

/**
 * Checks answers against a definition. `ok` with the answers as they are kept (trimmed,
 * NFC, only the shown fields, the authors in order), or the errors in the order of the form.
 */
export function checkAnswers(
  definition: FormDefinition,
  input: unknown,
): { ok: true; answers: Answers } | { ok: false; errors: RuleError[] } {
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: '', code: 'wrongType' }] };
  }
  const errors: RuleError[] = [];
  const known = new Map<string, SectionDefinition>();
  for (const section of definition.sections) {
    if (section.repeat !== null) {
      known.set(section.key, section);
    } else {
      for (const field of section.fields) {
        known.set(field.key, section);
      }
    }
  }
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      errors.push({ path: key, code: 'unknownField' });
    }
  }

  const answers: Answers = {};
  for (const section of definition.sections) {
    const shown = holds(section.visibleWhen, input);
    if (section.repeat === null) {
      if (shown) {
        Object.assign(answers, checkFields(section.fields, input, input, '', null, errors));
      }
      continue;
    }
    if (!shown) {
      continue;
    }
    const raw = Object.hasOwn(input, section.key) ? input[section.key] : undefined;
    if (raw !== undefined && !Array.isArray(raw)) {
      errors.push({ path: section.key, code: 'wrongType' });
      continue;
    }
    const blocks = raw ?? [];
    if (blocks.length < section.repeat.min) {
      errors.push({ path: section.key, code: 'tooFewItems' });
    }
    if (blocks.length > Math.min(section.repeat.max, ABSOLUTE_LIMITS.maxAuthors)) {
      errors.push({ path: section.key, code: 'tooManyItems' });
      continue;
    }
    const fieldKeys = new Set(section.fields.map((field) => field.key));
    const kept: Record<string, AnswerValue>[] = [];
    blocks.forEach((block: unknown, index) => {
      const prefix = `${section.key}[${String(index)}].`;
      if (!isPlainObject(block)) {
        errors.push({ path: `${section.key}[${String(index)}]`, code: 'wrongType' });
        return;
      }
      for (const key of Object.keys(block)) {
        if (!fieldKeys.has(key)) {
          errors.push({ path: `${prefix}${key}`, code: 'unknownField' });
        }
      }
      kept.push(checkFields(section.fields, block, input, prefix, index, errors));
    });
    answers[section.key] = kept;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, answers };
}
