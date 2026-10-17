/**
 * Form texts that an admin edits (ADR-09, SEC-A-19): labels, help, the consent, the
 * thank-you and closed messages. They are plain text with one safe link syntax and never
 * markup:
 *
 *   [the label](https://example.org/terms)   a link to an https address
 *   [the label](terms)                       the conference's terms of publication (D6)
 *   [the label](privacy)                     the conference's privacy notice (D6)
 *
 * Whatever else is typed, `<b>` and braces included, is text and is shown as text. The web
 * application renders a text from these segments only, never as HTML.
 */

/** The links a text may name by a word: the consent links of the conference (owner decision D6). */
export const NAMED_LINKS = ['terms', 'privacy'] as const;
export type NamedLink = (typeof NAMED_LINKS)[number];

export type TextSegment =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'link'; readonly text: string; readonly target: string };

export type SafeTextProblem = 'tooLong' | 'invalidCharacters' | 'badLink' | 'required';

const LINK = /\[([^[\]\n]{1,200})\]\(([^()\s]{1,500})\)/g;

/** Control characters other than a line break, and the invisible direction and format characters. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u0009\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/;

/** An https address that holds nothing but an address: no user part, no space, no quote. */
export function isSafeHttpsUrl(value: string): boolean {
  if (value.length > 500 || !/^https:\/\/[^\s<>"'`\\]+$/.test(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' && url.username === '' && url.password === '' && url.hostname !== ''
    );
  } catch {
    return false;
  }
}

function isTarget(target: string): boolean {
  return (NAMED_LINKS as readonly string[]).includes(target) || isSafeHttpsUrl(target);
}

/** The length of a text in code points (characters), as the limits count it. */
export function codePoints(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    // A high surrogate followed by its low one is one character.
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
      }
    }
    count += 1;
  }
  return count;
}

/** The segments of a text: what the renderer shows. A link whose target is not allowed stays text. */
export function parseSafeText(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    const [whole, label, target] = match;
    if (label === undefined || target === undefined || !isTarget(target)) {
      continue;
    }
    if (match.index > last) {
      segments.push({ type: 'text', text: text.slice(last, match.index) });
    }
    segments.push({ type: 'link', text: label, target });
    last = match.index + whole.length;
  }
  if (last < text.length) {
    segments.push({ type: 'text', text: text.slice(last) });
  }
  return segments;
}

/** What is wrong with a text an admin typed, or null. A link syntax with a target that is not allowed is refused. */
export function safeTextProblem(
  text: string,
  maxLength: number,
  options: { required?: boolean; multiline?: boolean } = {},
): SafeTextProblem | null {
  if (options.required === true && text.trim() === '') {
    return 'required';
  }
  if (codePoints(text) > maxLength) {
    return 'tooLong';
  }
  if (FORBIDDEN.test(text) || (options.multiline !== true && text.includes('\n'))) {
    return 'invalidCharacters';
  }
  for (const match of text.matchAll(LINK)) {
    if (match[2] === undefined || !isTarget(match[2])) {
      return 'badLink';
    }
  }
  return null;
}
