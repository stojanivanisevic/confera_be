import { COMMON_PASSWORDS } from './common-passwords';

/**
 * The password rule set (ADR-03, G2-25, FR-USR-06, ST-62): the four lines of the live
 * checklist, decided at Gate 2.
 *
 *   length         at least 12 characters (and at most 128)
 *   not_common     not a common or leaked password
 *   not_personal   not the person's own name or email name, nor the name of the
 *                  organisation (or, from 0.2.0 part B, of a conference)
 *   match          both entries match
 *
 * The server enforces it wherever a password is set (invitation, reset, change). The web
 * application ticks the same lines while the person types, without a request: the rule
 * set and its vectors are exported once, as contracts/password-rules.json (generated
 * from this file by `pnpm openapi:generate`), and both repositories run the vectors.
 *
 * Everything below is written so that the browser can do exactly the same:
 *
 * - A length is counted in Unicode code points of the password in NFC.
 * - The NORMAL FORM of a text: NFC, lower case, then only letters and digits
 *   (\p{L} and \p{N}) kept.
 * - The FOLDED FORM: the normal form with š→s, č→c, ć→c, ž→z, đ→dj, and every other
 *   letter without its accents (NFD, marks removed, NFC). A second folded form writes
 *   đ as d. Cyrillic is not transliterated.
 */

export const PASSWORD_RULES_VERSION = 1;

export const MIN_LENGTH = 12;
export const MAX_LENGTH = 128;

/** A word of a name shorter than this, in its folded form, is not looked for in a password. */
export const MIN_PERSONAL_WORD_LENGTH = 4;

/** Units of repetition this short make a password common whatever they are (`abcabcabcabc`). */
export const MAX_TRIVIAL_UNIT_LENGTH = 4;

/**
 * Lines of keyboards and of counting. A password whose normal form is part of one of
 * these, or of one of them read backwards, is common.
 */
export const SEQUENCES: readonly string[] = [
  'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz',
  '0123456789012345678901234567890123456789',
  'qwertyuiopasdfghjklzxcvbnmqwertyuiopasdfghjklzxcvbnm',
  'qwertzuiopasdfghjklyxcvbnmqwertzuiopasdfghjklyxcvbnm',
  'azertyuiopqsdfghjklmwxcvbnazertyuiopqsdfghjklmwxcvbn',
  '1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p',
  '1q2w3e4r5t6y7u8i9o0p',
  'zaq1xsw2cde3vfr4bgt5nhy6mju7',
  'qazwsxedcrfvtgbyhnujmikolp',
];

/** The letters of Serbian Latin that lose more than an accent when they are folded. */
export const FOLDS: Readonly<Record<string, string>> = { š: 's', č: 'c', ć: 'c', ž: 'z', đ: 'dj' };

export type PasswordRuleId = 'length' | 'not_common' | 'not_personal' | 'match';

export const PASSWORD_RULE_IDS: readonly PasswordRuleId[] = [
  'length',
  'not_common',
  'not_personal',
  'match',
];

/** The code of the field error when a rule is not met (FR-USR-06: "with that rule named"). */
export const RULE_CODES: Readonly<Record<PasswordRuleId, string>> = {
  length: 'password_length',
  not_common: 'password_common',
  not_personal: 'password_personal',
  match: 'password_mismatch',
};

/** Whose password it is: the words it must not contain. */
export interface PasswordContext {
  readonly email?: string | undefined;
  readonly displayName?: string | undefined;
  readonly organisationName?: string | undefined;
  readonly conferenceNames?: readonly string[] | undefined;
}

export interface PasswordCheck {
  readonly id: PasswordRuleId;
  readonly met: boolean;
}

const COMMON = new Set(COMMON_PASSWORDS.map((entry) => normalForm(entry)));

/** NFC, lower case, letters and digits only. */
export function normalForm(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** The folded forms of a text: đ written as dj, and as d. */
export function foldedForms(text: string): [string, string] {
  const fold = (dj: string): string =>
    normalForm(text)
      .replace(/[ščćžđ]/g, (letter) => (letter === 'đ' ? dj : (FOLDS[letter] ?? letter)))
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .normalize('NFC');
  return [fold('dj'), fold('d')];
}

export function codePointLength(password: string): number {
  // Code points, on purpose: what the rule says and what the browser counts the same way.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  return [...password.normalize('NFC')].length;
}

function isSequence(normal: string): boolean {
  return SEQUENCES.some(
    (sequence) =>
      sequence.includes(normal) || sequence.split('').reverse().join('').includes(normal),
  );
}

/** The shortest unit that the text is two or more copies of, or null. */
function repeatedUnit(normal: string): string | null {
  for (let size = 1; size <= normal.length / 2; size += 1) {
    if (normal.length % size === 0) {
      const unit = normal.slice(0, size);
      if (unit.repeat(normal.length / size) === normal) {
        return unit;
      }
    }
  }
  return null;
}

function isCommonCore(normal: string): boolean {
  const core = normal.replace(/^\p{N}+|\p{N}+$/gu, '');
  return COMMON.has(normal) || (core !== '' && COMMON.has(core)) || isSequence(normal);
}

/**
 * Not a common or leaked password: its normal form is not on the list (also with digits
 * before or after it), has more than two different characters, is no part of a line of a
 * keyboard or of counting, and is not two or more copies of a unit that is any of these
 * or has at most four characters.
 */
export function isCommon(password: string): boolean {
  const normal = normalForm(password);
  if (normal === '') {
    return true;
  }
  if (new Set(normal).size <= 2 || isCommonCore(normal)) {
    return true;
  }
  const core = normal.replace(/^\p{N}+|\p{N}+$/gu, '');
  return [normal, core].some((text) => {
    const unit = repeatedUnit(text);
    return unit !== null && (unit.length <= MAX_TRIVIAL_UNIT_LENGTH || isCommonCore(unit));
  });
}

/**
 * The words a password must not contain, in their folded forms: the runs of letters of the
 * email before its last @ and of the names, each at least four characters long. A number
 * (the year in the name of a conference) is not a word.
 */
export function personalWords(context: PasswordContext): string[] {
  const words = new Set<string>();
  const add = (text: string): void => {
    for (const run of text.normalize('NFC').match(/\p{L}+/gu) ?? []) {
      for (const folded of foldedForms(run)) {
        if (folded.length >= MIN_PERSONAL_WORD_LENGTH) {
          words.add(folded);
        }
      }
    }
  };
  if (context.email !== undefined) {
    const at = context.email.lastIndexOf('@');
    add(at === -1 ? context.email : context.email.slice(0, at));
  }
  for (const name of [
    context.displayName,
    context.organisationName,
    ...(context.conferenceNames ?? []),
  ]) {
    if (name !== undefined) {
      add(name);
    }
  }
  return [...words].sort();
}

/** Not the person's own name or email name, nor the name of the organisation. */
export function isPersonal(password: string, context: PasswordContext): boolean {
  const forms = foldedForms(password);
  return personalWords(context).some((word) => forms.some((form) => form.includes(word)));
}

/** The four lines of the checklist, each met or not. */
export function checkPassword(
  password: string,
  repeat: string,
  context: PasswordContext,
): PasswordCheck[] {
  const length = codePointLength(password);
  return [
    { id: 'length', met: length >= MIN_LENGTH && length <= MAX_LENGTH },
    { id: 'not_common', met: !isCommon(password) },
    { id: 'not_personal', met: !isPersonal(password, context) },
    { id: 'match', met: password === repeat },
  ];
}

/** The codes of the rules a password does not meet, in the order of the checklist. */
export function passwordProblems(
  password: string,
  repeat: string,
  context: PasswordContext,
): string[] {
  return checkPassword(password, repeat, context)
    .filter(({ met }) => !met)
    .map(({ id }) => RULE_CODES[id]);
}

/** The rule set as data, for the export (contracts/password-rules.json). */
export function ruleSet() {
  return {
    version: PASSWORD_RULES_VERSION,
    lines: [
      {
        id: 'length',
        code: RULE_CODES.length,
        minimum: MIN_LENGTH,
        maximum: MAX_LENGTH,
        counted: 'Unicode code points of the password in NFC',
      },
      {
        id: 'not_common',
        code: RULE_CODES.not_common,
        normalForm: 'NFC, lower case, then only letters and digits (\\p{L} and \\p{N})',
        refusedWhen: [
          'the normal form is on the list `common`',
          'the normal form without its leading and trailing digits is on the list (and not empty)',
          'the normal form has at most two different characters',
          'the normal form is part of a line of `sequences`, or of one read backwards',
          `the normal form, or the normal form without its leading and trailing digits, is two or more copies of one unit, and the unit has at most ${String(MAX_TRIVIAL_UNIT_LENGTH)} characters or is on the list, on the list without its leading and trailing digits, or part of a line of \`sequences\``,
        ],
        common: [...COMMON].sort(),
        sequences: SEQUENCES,
      },
      {
        id: 'not_personal',
        code: RULE_CODES.not_personal,
        foldedForm:
          'the normal form with the letters of `folds` replaced (đ as dj, and in a second form as d), then every other letter without its accents (NFD, marks removed, NFC); Cyrillic is not transliterated',
        folds: FOLDS,
        words:
          'the runs of letters (\\p{L}+, in NFC) of the email before its last @, of the person’s name, of the organisation’s name and of the conferences’ names, each in both folded forms; digits are no part of a word',
        minimumWordLength: MIN_PERSONAL_WORD_LENGTH,
        refusedWhen: 'a folded form of the password contains one of the words',
      },
      { id: 'match', code: RULE_CODES.match, refusedWhen: 'the two entries differ' },
    ],
  };
}
