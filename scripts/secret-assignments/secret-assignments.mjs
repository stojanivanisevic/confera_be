// The scan for secrets that are given away by their NAME.
//
// A scanner of formats (secretlint, gitleaks) knows what a GitHub token or a private key
// looks like. A mail password, a session secret or a data key looks like nothing: it is
// any text. What gives it away is the name it is bound to. This scan reports
//
//     a LITERAL VALUE bound to a SECRET-LIKE NAME
//
// in every file that git tracks or would take, in any syntax where a name gets a value.
//
// SECRET-LIKE NAME. Decided by the words of the name, in any casing convention
// (smtpPassword, SMTP_PASSWORD, smtp-password, "smtp password"): the name is, or ends
// with, one of
//
//     password, passwd, secret, token, api key, private key, credential, credentials,
//     data key, client secret, session secret
//
// `passwordPolicy`, `tokenType`, `secretName`, `PASSWORD_MIN_LENGTH` end with another
// word and are not secret-like. A number at the end does not count (`API_KEY_2`).
//
// ALLOWED VALUES, and nothing else:
//
//     - nothing: an empty value, `null`, `~`, `true`, `false`
//     - a reference to something else as the WHOLE value: `${VAR}`, `$VAR`, `$(command)`,
//       `${{ secrets.X }}`, `{{ value }}`, a YAML alias; in JavaScript any expression
//       that is not a literal (`process.env.X`, a call, another variable)
//     - a placeholder: a literal that STARTS with `invented-` or `local-only-`
//
// There is no guess by length or by randomness: `'too_short'` under a secret-like name is
// a finding, and so is `changeme`. The code is changed to follow the rule.
//
// SYNTAX, by the kind of file:
//
//     JavaScript, TypeScript     an assignment, a declaration (typed or not), a class
//     (.js .cjs .mjs .jsx        field, an object property, a default parameter, an
//      .ts .cts .mts .tsx)       attribute of a JSX element, and a literal used as a
//                                fallback for such a name (`??`, `||`, a ternary branch)
//     JSON (.json .jsonc)        "name": value, in any letter case
//     YAML (.yml .yaml)          name: value, in any letter case, and the lines below
//     every other text file      NAME=value at the start of a line, with or without
//     (.env, shell, Dockerfile,  `export`, quotes, a leading list dash, `ENV` or `ARG`;
//      .npmrc, Markdown, ...)    `ENV NAME value`; several pairs on one line
//
// The files are read as their syntax (a tokenizer for JavaScript and JSON, a reader of
// lines for the others), not searched with one pattern per shape. Comments are not read.
//
// Use, as a program (exit code 1 when something is found):
//
//     node secret-assignments.mjs [directory] [--exclude <path or glob>]...
//     node secret-assignments.mjs --self-test [--json]
//
// and as a module: scanDirectory(root, { exclude }), scanText(file, text).
//
// `--self-test` runs the two corpora that lie beside this file: the shapes that must be
// reported (secret-assignments.reported.mjs) and the ordinary lines that must not be
// (secret-assignments.ordinary.mjs).
//
// This file and its two corpora have no dependency and hold nothing about the repository
// they are in: copy the three unchanged. What a repository leaves out (generated or
// vendored files) is passed by the caller as `exclude`. Lockfiles are always left out.
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/** The documented way to write a placeholder: a literal that starts with one of these. */
export const PLACEHOLDER_PREFIXES = ['invented-', 'local-only-'];

/** A name is secret-like when its words end with one of these. */
export const SECRET_NAME_ENDINGS = [
  ['password'],
  ['passwd'],
  ['secret'],
  ['token'],
  ['api', 'key'],
  ['private', 'key'],
  ['credential'],
  ['credentials'],
  ['data', 'key'],
  ['client', 'secret'],
  ['session', 'secret'],
];

/** Two words that are often written as one, in lower case, where no casing separates them. */
const WRITTEN_AS_ONE = new Map(
  SECRET_NAME_ENDINGS.filter((words) => words.length > 1).map((words) => [words.join(''), words]),
);

/** Lockfiles are written by a package manager, hold hashes, and are never scanned. */
export const LOCKFILES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
];

const LARGEST_FILE = 2 * 1024 * 1024;

/** The words of a name: `smtpPassword`, `SMTP_PASSWORD`, `smtp-password` are "smtp password". */
export function wordsOf(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase())
    .flatMap((word) => WRITTEN_AS_ONE.get(word) ?? [word]);
}

export function isSecretLikeName(name) {
  const words = wordsOf(name);
  // `API_KEY_2`, `password2`: a number at the end is not a word of the name.
  while (words.length > 0 && /^[0-9]+$/.test(words[words.length - 1])) {
    words.pop();
  }
  if (words.length > 0) {
    const last = words[words.length - 1].replace(/[0-9]+$/, '');
    words.splice(words.length - 1, 1, ...(WRITTEN_AS_ONE.get(last) ?? [last]));
  }
  return SECRET_NAME_ENDINGS.some(
    (ending) =>
      ending.length <= words.length &&
      ending.every((word, index) => words[words.length - ending.length + index] === word),
  );
}

/** A literal text that may stand under a secret-like name: empty, or a placeholder. */
function literalIsAllowed(text) {
  return text === '' || PLACEHOLDER_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/** Words that stand for "no value" where a file has no types. */
const NOTHING = /^(?:null|~|true|false)$/i;

/** The index after the bracket that closes the one at `start`, or -1. Quotes are skipped. */
function closingIndex(text, start, open, close) {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') {
      index += 1;
    } else if (character === "'" || character === '"') {
      const end = text.indexOf(character, index + 1);
      if (end === -1) {
        return -1;
      }
      index = end;
    } else if (text.startsWith(open, index)) {
      depth += 1;
      index += open.length - 1;
    } else if (text.startsWith(close, index)) {
      depth -= 1;
      if (depth === 0) {
        return index + close.length;
      }
      index += close.length - 1;
    }
  }
  return -1;
}

/**
 * Is this text, all of it, a reference to something else? The forms of a shell, of a
 * compose file, of a CI system and of a template language.
 */
function isWholeReference(text) {
  if (/^\$[A-Za-z_][A-Za-z0-9_:]*$/.test(text) || /^%[A-Za-z_][A-Za-z0-9_]*%$/.test(text)) {
    return true; // $VAR, $env:VAR, %VAR%
  }
  if (text.startsWith('${{')) {
    return closingIndex(text, 0, '${{', '}}') === text.length; // ${{ secrets.X }}
  }
  if (text.startsWith('{{')) {
    return closingIndex(text, 0, '{{', '}}') === text.length; // {{ value }}
  }
  if (text.startsWith('$(')) {
    return closingIndex(text, 1, '(', ')') === text.length; // $(command)
  }
  if (text.length > 1 && text.startsWith('`') && text.indexOf('`', 1) === text.length - 1) {
    return true; // `command`
  }
  if (text.startsWith('${') && closingIndex(text, 1, '{', '}') === text.length) {
    // ${VAR}, and ${VAR:-fallback}: the fallback is a value of its own.
    const fallback = /^[A-Za-z_][A-Za-z0-9_]*(:?[-=+])(.*)$/s.exec(text.slice(2, -1));
    return fallback === null || plainValueIsAllowed(fallback[2]);
  }
  return false;
}

/** A value written in quotes, without them: a text, so `null` and `true` are texts too. */
function quotedValueIsAllowed(value) {
  return literalIsAllowed(value) || isWholeReference(value);
}

/** A value as a file without types writes it, where no quotes say that it is a text. */
function plainValueIsAllowed(value) {
  return quotedValueIsAllowed(value) || NOTHING.test(value);
}

// ---------------------------------------------------------------------------
// Lines: NAME=value
// ---------------------------------------------------------------------------

const LINE_PREFIX =
  /^(?:(?:export|declare|local|readonly|typeset|set|setx|env)[ \t]+(?:-[A-Za-z]+[ \t]+)*|(?:ENV|ARG)[ \t]+)/;
const DOCKERFILE_PREFIX = /^(?:ENV|ARG)[ \t]+/i;
const LINE_NAME = /^[A-Za-z0-9_.$:/@~+-]*[A-Za-z][A-Za-z0-9_.$:/@~+-]*/;

/** The first word of a shell line: up to white space, with quotes and $( ) kept whole. */
function firstWord(text) {
  let index = 0;
  let value = '';
  while (index < text.length && !/\s/.test(text[index])) {
    const character = text[index];
    if (character === '"' || character === "'") {
      const end = text.indexOf(character, index + 1);
      if (end === -1) {
        value += text.slice(index + 1);
        return { value, length: text.length };
      }
      value += text.slice(index + 1, end);
      index = end + 1;
    } else if (text.startsWith('$(', index) || text.startsWith('${', index)) {
      const open = text[index + 1];
      const end = closingIndex(text, index + 1, open, open === '(' ? ')' : '}');
      const stop = end === -1 ? text.length : end;
      value += text.slice(index, stop);
      index = stop;
    } else if (character === '`') {
      const end = text.indexOf('`', index + 1);
      const stop = end === -1 ? text.length : end + 1;
      value += text.slice(index, stop);
      index = stop;
    } else {
      value += character;
      index += 1;
    }
  }
  return { value, length: index };
}

/**
 * The pairs NAME=value that a line begins with. `export`, `ENV`, a list dash and quotes
 * around the pair are stepped over; `ENV NAME value` of a Dockerfile is read too.
 * @returns {{ name: string, value: string }[]}
 */
function pairsOfLine(line) {
  let rest = line.trim();
  while (/^-[ \t]+/.test(rest)) {
    rest = rest.replace(/^-[ \t]+/, '');
  }
  if (rest === '' || /^[#;]/.test(rest)) {
    return [];
  }
  // - "NAME=value": the quotes are around the whole pair.
  const quote = rest[0];
  if ((quote === '"' || quote === "'") && rest.indexOf(quote, 1) === rest.length - 1) {
    rest = rest.slice(1, -1);
  }
  const dockerfile = DOCKERFILE_PREFIX.test(rest);
  const prefix = LINE_PREFIX.exec(rest) ?? DOCKERFILE_PREFIX.exec(rest);
  if (prefix) {
    rest = rest.slice(prefix[0].length);
  }

  const pairs = [];
  for (;;) {
    const name = LINE_NAME.exec(rest);
    if (!name) {
      break;
    }
    const after = rest.slice(name[0].length);
    // `=`, and `:=`, `?=`, `+=` of a Makefile; not `==` or `=~` of a comparison.
    const equals = /^[ \t]*[:?+]?=(?![=~>])[ \t]*/.exec(after);
    if (!equals) {
      // ENV NAME value: the value is the rest of the line.
      const spaced = /^[ \t]+(\S.*)$/.exec(after);
      if (dockerfile && pairs.length === 0 && spaced) {
        pairs.push({ name: name[0], value: firstWord(spaced[1]).value });
      }
      break;
    }
    const written = after.slice(equals[0].length);
    // NAME=   # a comment: white space, then a comment, is no value.
    const word =
      /\s$/.test(equals[0]) && written.startsWith('#')
        ? { value: '', length: written.length }
        : firstWord(written);
    pairs.push({ name: name[0], value: word.value });
    rest = written.slice(word.length).trimStart();
    if (rest === '' || rest.startsWith('#')) {
      break;
    }
  }
  return pairs;
}

function scanLine(line, number, report) {
  for (const { name, value } of pairsOfLine(line)) {
    if (isSecretLikeName(name) && !plainValueIsAllowed(value)) {
      report(number, name);
    }
  }
}

function scanLines(text, report) {
  text.split(/\r?\n/).forEach((line, index) => {
    scanLine(line, index + 1, report);
  });
}

// ---------------------------------------------------------------------------
// YAML: name: value
// ---------------------------------------------------------------------------

/** A scalar of YAML without its quotes, or null when the text is not one quoted scalar. */
function unquoted(text) {
  const quote = text[0];
  if (quote !== '"' && quote !== "'") {
    return null;
  }
  let value = '';
  for (let index = 1; index < text.length; index += 1) {
    const character = text[index];
    if (quote === '"' && character === '\\') {
      value += text[index + 1] ?? '';
      index += 1;
    } else if (character === quote) {
      if (quote === "'" && text[index + 1] === "'") {
        value += "'";
        index += 1;
      } else {
        // What follows a closed scalar is a comma of a flow collection or a comment.
        return /^\s*(?:[,#].*)?$/.test(text.slice(index + 1)) ? value : null;
      }
    } else {
      value += character;
    }
  }
  return null;
}

/** A plain scalar without its comment. */
function withoutComment(text) {
  const comment = /(?:^|\s)#/.exec(text);
  return (comment ? text.slice(0, comment.index) : text).trim();
}

/** Splits the inside of a flow collection at its commas, brackets and quotes kept whole. */
function flowItems(inside) {
  const items = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < inside.length; index += 1) {
    const character = inside[index];
    if (character === '"' || character === "'") {
      const end = inside.indexOf(character, index + 1);
      index = end === -1 ? inside.length : end;
    } else if (character === '{' || character === '[') {
      depth += 1;
    } else if (character === '}' || character === ']') {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      items.push(inside.slice(start, index));
      start = index + 1;
    }
  }
  items.push(inside.slice(start));
  return items.map((item) => item.trim()).filter((item) => item !== '');
}

/**
 * `name: value` at the start of an entry. The name is in quotes, or plain: a plain name is
 * a word or a few, without the characters of a command or a sentence in it.
 */
const YAML_KEY =
  /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s:#'"{}[\],&*!|>%@`=][^:#'"`$()=<>|;]*?))[ \t]*:(?:[ \t]+(.*))?$/;
const YAML_BLOCK = /^[|>][+-]?[0-9]?[+-]?[ \t]*(?:#.*)?$/;

/** A value of YAML under a secret-like name. */
function yamlValueIsAllowed(raw) {
  const value = raw.replace(/^&\S+[ \t]*/, '');
  if (value === '' || /^[*!]/.test(value)) {
    return true; // nothing, an alias, a tagged value
  }
  const text = unquoted(value);
  return text === null
    ? plainValueIsAllowed(withoutComment(value).replace(/,$/, ''))
    : quotedValueIsAllowed(text);
}

/**
 * One entry of YAML: `name: value`, or else a line that may begin with NAME=value.
 * `follow` is told when the value comes on the lines below: ('block', name) for a text of
 * several lines after `|` or `>`, ('next', name) for a secret-like name with no value yet.
 */
function scanYamlEntry(entry, number, report, follow) {
  const match = YAML_KEY.exec(entry);
  if (!match) {
    scanLine(entry, number, report);
    return;
  }
  const name = (match[1] ?? match[2] ?? match[3]).trim();
  const value = withoutComment(match[4] ?? '') === '' ? '' : (match[4] ?? '').trim();
  const secret = isSecretLikeName(name);
  if (YAML_BLOCK.test(value)) {
    follow('block', secret ? name : null);
  } else if (value === '' || /^&\S+$/.test(value)) {
    if (secret) {
      follow('next', name);
    }
  } else if (value.startsWith('{') || value.startsWith('[')) {
    const end = closingIndex(value, 0, value[0], value[0] === '{' ? '}' : ']');
    if (end !== -1) {
      for (const item of flowItems(value.slice(1, end - 1))) {
        scanYamlEntry(unquoted(item) ?? item, number, report, () => undefined);
      }
    }
  } else if (secret && !yamlValueIsAllowed(value)) {
    report(number, name);
  }
}

function scanYaml(text, report) {
  /**
   * What the lines below belong to: a text of several lines (`kind` 'block'), or the
   * value of a secret-like name that had none on its own line (`kind` 'next').
   */
  let open = null;
  text.split(/\r?\n/).forEach((line, index) => {
    const number = index + 1;
    const indent = /^[ \t]*/.exec(line)[0].length;
    let entry = line.trim();
    if (open !== null && entry !== '') {
      if (indent > open.indent && open.kind === 'block') {
        if (open.name === null) {
          scanLine(line, number, report); // a script in a `run: |` block
        } else if (!open.read) {
          open.read = true;
          if (!plainValueIsAllowed(entry)) {
            report(open.line, open.name);
          }
        }
        return;
      }
      if (indent > open.indent && open.kind === 'next' && !entry.startsWith('#')) {
        // name:
        //   value          a plain value on the next line; a mapping or a list is not one
        const { name, line: at } = open;
        open = null;
        if (!YAML_KEY.test(entry) && !/^-(?:[ \t]|$)/.test(entry)) {
          if (!yamlValueIsAllowed(entry)) {
            report(at, name);
          }
          return;
        }
      } else if (!entry.startsWith('#')) {
        open = null;
      }
    }
    if (entry === '' || entry.startsWith('#') || entry === '---' || entry === '...') {
      return;
    }
    for (let dash = /^-[ \t]+/.exec(entry); dash; dash = /^-[ \t]+/.exec(entry)) {
      entry = entry.slice(dash[0].length);
    }
    scanYamlEntry(entry, number, report, (kind, name) => {
      open = { kind, indent, name, line: number, read: false };
    });
  });
}

// ---------------------------------------------------------------------------
// JavaScript, TypeScript and JSON
// ---------------------------------------------------------------------------

const PUNCTUATORS = [
  '>>>=',
  '...',
  '===',
  '!==',
  '**=',
  '<<=',
  '>>=',
  '>>>',
  '&&=',
  '||=',
  '??=',
  '=>',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '?.',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '**',
  '<<',
  '>>',
];
const IDENTIFIER = /[\p{L}_$#][\p{L}\p{N}\p{Mn}\p{Mc}\p{Pc}$]*/uy;
const NUMBER =
  /(?:0[xXbBoO][0-9a-fA-F_]+|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][+-]?[0-9]+)?|\.[0-9][0-9_]*(?:[eE][+-]?[0-9]+)?)n?/y;
/** After these words a `/` starts a regular expression, and a `{` an object. */
const BEFORE_EXPRESSION = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'default',
]);
const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };

/** The text of a string literal: its escapes read, as far as a start of it needs. */
function cooked(raw) {
  return raw.replace(
    /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r?\n)|([^]))/g,
    (_all, braced, unicode, hex, newline, other) => {
      const code = braced ?? unicode ?? hex;
      if (code !== undefined) {
        const point = Number.parseInt(code, 16);
        return point <= 0x10ffff ? String.fromCodePoint(point) : '';
      }
      return newline !== undefined ? '' : (ESCAPES[other] ?? other);
    },
  );
}

/**
 * Tokens of JavaScript, TypeScript, JSX and JSON. Comments and white space are left out.
 * A token is { type, value, line }: type is 'word', 'string', 'template', 'number',
 * 'regex' or 'punctuator'. A template also has `head` (its text up to the first `${`),
 * `plain` (no `${` at all) and `reference` (nothing but one `${...}`).
 */
export function tokenize(text) {
  const tokens = [];
  let index = 0;
  let line = 1;
  const push = (type, value, extra = {}) => {
    tokens.push({ type, value, line, ...extra });
  };
  const countLines = (from, to) => {
    for (let at = from; at < to; at += 1) {
      if (text[at] === '\n') {
        line += 1;
      }
    }
  };

  /** The index after the `}` that closes a `${` whose inside starts at `from`, or -1. */
  const endOfSubstitution = (from) => {
    let depth = 1;
    for (let at = from; at < text.length; at += 1) {
      const character = text[at];
      if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          return at + 1;
        }
      } else if (character === "'" || character === '"') {
        const end = endOfString(at);
        at = end === -1 ? at : end - 1;
      } else if (character === '`') {
        const end = endOfTemplate(at);
        if (end === -1) {
          return -1;
        }
        at = end.index - 1;
      } else if (text.startsWith('//', at)) {
        const end = text.indexOf('\n', at);
        at = end === -1 ? text.length : end;
      } else if (text.startsWith('/*', at)) {
        const end = text.indexOf('*/', at + 2);
        at = end === -1 ? text.length : end + 1;
      }
    }
    return -1;
  };

  /** The index after the quote that closes the string at `from`, on the same line, or -1. */
  function endOfString(from) {
    const quote = text[from];
    for (let at = from + 1; at < text.length; at += 1) {
      const character = text[at];
      if (character === '\\') {
        at += text[at + 1] === '\r' && text[at + 2] === '\n' ? 2 : 1;
      } else if (character === quote) {
        return at + 1;
      } else if (character === '\n') {
        return -1;
      }
    }
    return -1;
  }

  /** Where the template at `from` ends and what it holds, or -1 when it never closes. */
  function endOfTemplate(from) {
    let head = null;
    let substitutions = 0;
    let literal = false;
    let raw = '';
    for (let at = from + 1; at < text.length; at += 1) {
      const character = text[at];
      if (character === '\\') {
        raw += text.slice(at, at + 2);
        literal = true;
        at += 1;
      } else if (character === '`') {
        return {
          index: at + 1,
          head: cooked(head ?? raw),
          plain: substitutions === 0,
          reference: substitutions === 1 && !literal,
        };
      } else if (character === '$' && text[at + 1] === '{') {
        head ??= raw;
        substitutions += 1;
        const end = endOfSubstitution(at + 2);
        if (end === -1) {
          return -1;
        }
        at = end - 1;
      } else {
        raw += character;
        literal = true;
      }
    }
    return -1;
  }

  /** The index after a regular expression that starts at `from`, on the same line, or -1. */
  const endOfRegex = (from) => {
    let inClass = false;
    for (let at = from + 1; at < text.length; at += 1) {
      const character = text[at];
      if (character === '\n') {
        return -1;
      }
      if (character === '\\') {
        at += 1;
      } else if (character === '[') {
        inClass = true;
      } else if (character === ']') {
        inClass = false;
      } else if (character === '/' && !inClass) {
        let end = at + 1;
        while (end < text.length && /[a-z]/i.test(text[end])) {
          end += 1;
        }
        return end;
      }
    }
    return -1;
  };

  const regexMayStart = () => {
    const previous = tokens[tokens.length - 1];
    if (previous === undefined) {
      return true;
    }
    if (previous.type === 'word') {
      return BEFORE_EXPRESSION.has(previous.value);
    }
    return previous.type === 'punctuator' && ![')', ']', '}'].includes(previous.value);
  };

  if (text.startsWith('#!')) {
    index = text.indexOf('\n');
    index = index === -1 ? text.length : index;
  }
  while (index < text.length) {
    const character = text[index];
    if (character === '\n') {
      line += 1;
      index += 1;
    } else if (/\s/.test(character)) {
      index += 1;
    } else if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end;
    } else if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      const stop = end === -1 ? text.length : end + 2;
      countLines(index, stop);
      index = stop;
    } else if (character === "'" || character === '"') {
      const end = endOfString(index);
      if (end === -1) {
        // An apostrophe in the text of a JSX element, not a string.
        push('punctuator', character);
        index += 1;
      } else {
        push('string', cooked(text.slice(index + 1, end - 1)));
        countLines(index, end);
        index = end;
      }
    } else if (character === '`') {
      const end = endOfTemplate(index);
      if (end === -1) {
        push('punctuator', character);
        index += 1;
      } else {
        push('template', text.slice(index, end.index), {
          head: end.head,
          plain: end.plain,
          reference: end.reference,
        });
        countLines(index, end.index);
        index = end.index;
      }
    } else if (character === '/') {
      // `</tag>` and `/>` belong to JSX.
      const previous = tokens[tokens.length - 1];
      const closesTag = previous?.value === '<' || text[index + 1] === '>';
      const end = !closesTag && regexMayStart() ? endOfRegex(index) : -1;
      if (end === -1) {
        const operator = text.startsWith('/=', index) ? '/=' : '/';
        push('punctuator', operator);
        index += operator.length;
      } else {
        push('regex', text.slice(index, end));
        index = end;
      }
    } else {
      IDENTIFIER.lastIndex = index;
      NUMBER.lastIndex = index;
      const word = IDENTIFIER.exec(text);
      const number = word ? null : NUMBER.exec(text);
      if (word) {
        push('word', word[0]);
        index += word[0].length;
      } else if (number) {
        push('number', number[0]);
        index += number[0].length;
      } else {
        const operator = PUNCTUATORS.find((candidate) => text.startsWith(candidate, index));
        push('punctuator', operator ?? character);
        index += (operator ?? character).length;
      }
    }
  }
  return tokens;
}

const OPENERS = { '{': '}', '(': ')', '[': ']' };
const CLOSERS = new Set(['}', ')', ']']);
/** Words of JavaScript that are never a name that gets a value. */
const NOT_A_NAME = new Set([
  'this',
  'super',
  'null',
  'undefined',
  'true',
  'false',
  'return',
  'typeof',
  'void',
  'new',
  'await',
  'yield',
  'delete',
  'in',
  'of',
  'instanceof',
  'as',
  'satisfies',
  'is',
  'keyof',
]);
const DECLARES = new Set(['const', 'let', 'var', 'using']);
const MODIFIERS = new Set([
  'private',
  'public',
  'protected',
  'readonly',
  'static',
  'declare',
  'override',
  'abstract',
  'accessor',
]);
/** After one of these, a `{` opens a type and not an object. */
const BEFORE_TYPE = new Set(['as', 'satisfies', 'extends', 'implements', 'keyof', 'is']);
/** Operators after which the next token on a new line still belongs to the expression. */
const CONTINUES = new Set([
  '.',
  '?.',
  '??',
  '||',
  '&&',
  '?',
  ':',
  '+',
  '-',
  '*',
  '/',
  '%',
  '=',
  '==',
  '===',
  '!=',
  '!==',
  '<',
  '>',
  '<=',
  '>=',
  ',',
  '(',
  '[',
  '=>',
  '|',
  '&',
  '^',
  '**',
  '!',
  '~',
  '...',
]);
/** Words that may follow a value inside one expression. */
const AFTER_A_VALUE = new Set(['as', 'satisfies', 'in', 'instanceof', 'of']);
const ALTERNATIVES = new Set(['??', '||', '&&', '?', ':']);
const ASSIGNS = new Set(['=', '??=', '||=', '&&=']);

function isWord(token, value) {
  return token?.type === 'word' && (value === undefined || token.value === value);
}

function isPunctuator(token, value) {
  return token?.type === 'punctuator' && (value === undefined || token.value === value);
}

/** Does a new line between these two tokens leave the expression or the type unfinished? */
function carriesOn(previous, token) {
  return (
    (previous.type === 'punctuator' && CONTINUES.has(previous.value)) ||
    (token.type === 'punctuator' && (CONTINUES.has(token.value) || CLOSERS.has(token.value))) ||
    isWord(token, 'as') ||
    isWord(token, 'satisfies')
  );
}

/**
 * Findings in the tokens of a JavaScript, TypeScript or JSON file.
 *
 * Every bracket is followed, and every `{` is told apart: an object (its properties are
 * names that get values), a block or the body of a class, a type, an enum.
 */
function scanTokens(tokens, report, { json = false, manifest = false } = {}) {
  /** For a bracket, the index of the one that closes or opens it; else -1. */
  const partner = new Array(tokens.length).fill(-1);
  /** For an opening bracket, what it opens. */
  const kind = new Array(tokens.length).fill('');
  /** For every token, what it stands in: the kind of the innermost bracket, or 'type'. */
  const context = new Array(tokens.length).fill('');
  const stack = [];
  /** Set by `enum`, `interface` and `class`: what the next `{` opens. */
  let pending = '';
  /** The depth of brackets at which a `type X = ...` is being read, or -1. */
  let alias = -1;

  const inner = () => (stack.length === 0 ? '' : kind[stack[stack.length - 1]]);

  /** Is the `:` at `colon` the one of a ternary (and not of a label or a `case`)? */
  const closesTernary = (colon) => {
    for (let at = colon - 1, steps = 0; at >= 0 && steps < 48; at -= 1, steps += 1) {
      const token = tokens[at];
      if (token.type === 'punctuator') {
        if (CLOSERS.has(token.value) && partner[at] !== -1) {
          at = partner[at];
        } else if (token.value === '?') {
          return true;
        } else if (token.value === ';' || token.value in OPENERS) {
          return false;
        }
      } else if (isWord(token, 'case')) {
        return false;
      }
    }
    return false;
  };

  const kindOfBrace = (index) => {
    if (json) {
      return 'object'; // JSON has no blocks and no types
    }
    if (pending !== '') {
      const opened = pending;
      pending = '';
      return opened;
    }
    if (alias !== -1 || inner() === 'type') {
      return 'type';
    }
    const previous = tokens[index - 1];
    if (previous === undefined) {
      return 'block';
    }
    if (previous.type === 'word') {
      if (BEFORE_TYPE.has(previous.value)) {
        return 'type';
      }
      return BEFORE_EXPRESSION.has(previous.value) && !['else', 'do'].includes(previous.value)
        ? 'object'
        : 'block';
    }
    if (previous.type !== 'punctuator') {
      return 'block';
    }
    if (['<', '|', '&'].includes(previous.value)) {
      return 'type';
    }
    if (previous.value === ':') {
      if (inner() === 'object') {
        return 'object'; // the value of a property
      }
      // `(options: { ... })` and `const x: { ... } =` give a type; a ternary an object;
      // a label and a `case` a block.
      let name = index - 2;
      if (isPunctuator(tokens[name], '?')) {
        name -= 1;
      }
      const before = tokens[name - 1];
      const declared =
        isWord(tokens[name]) &&
        (isPunctuator(before, '(') ||
          isPunctuator(before, ',') ||
          (isWord(before) && (DECLARES.has(before.value) || MODIFIERS.has(before.value))) ||
          inner() === 'class');
      if (declared && !closesTernary(index - 1)) {
        return 'type';
      }
      return closesTernary(index - 1) ? 'object' : 'block';
    }
    return [')', ']', '}', ';', '=>'].includes(previous.value) ? 'block' : 'object';
  };

  // First pass: the partner of every bracket, the kind of every brace, and for every
  // token what it stands in.
  tokens.forEach((token, index) => {
    const previous = tokens[index - 1];
    if (alias === stack.length && previous !== undefined && kind[index - 1] !== 'alias') {
      // A type ends at a `;`, or where a new line starts something else.
      if (isPunctuator(token, ';') || (token.line > previous.line && !carriesOn(previous, token))) {
        alias = -1;
      }
    }
    context[index] = alias !== -1 ? 'type' : inner();

    if (token.type === 'word') {
      const next = tokens[index + 1];
      if (isPunctuator(previous, '.') || isPunctuator(previous, '?.')) {
        return; // a property called `class` or `type`
      }
      if ((token.value === 'enum' || token.value === 'interface') && isWord(next)) {
        pending = token.value === 'enum' ? 'enum' : 'type';
      } else if (token.value === 'class' && (isWord(next) || isPunctuator(next, '{'))) {
        pending = 'class';
      } else if (
        token.value === 'type' &&
        alias === -1 &&
        !json &&
        isWord(next) &&
        next.line === token.line &&
        (isPunctuator(tokens[index + 2], '=') || isPunctuator(tokens[index + 2], '<'))
      ) {
        alias = stack.length;
        kind[index] = 'alias';
        context[index] = 'type';
      }
      return;
    }
    if (token.type !== 'punctuator') {
      return;
    }
    if (token.value in OPENERS) {
      kind[index] =
        token.value === '{' ? kindOfBrace(index) : token.value === '(' ? 'paren' : 'bracket';
      stack.push(index);
    } else if (CLOSERS.has(token.value)) {
      // A closer without its opener is text of a JSX element: it is stepped over.
      const open = stack[stack.length - 1];
      if (open !== undefined && OPENERS[tokens[open].value] === token.value) {
        stack.pop();
        partner[open] = index;
        partner[index] = open;
        if (alias > stack.length) {
          alias = -1;
        }
      }
    }
  });

  if (manifest) {
    // "dependencies": { "generate-password": "1.7.1" }: a name of a package, not of a value.
    tokens.forEach((token, index) => {
      if (
        kind[index] === 'object' &&
        isPunctuator(tokens[index - 1], ':') &&
        tokens[index - 2]?.type === 'string' &&
        PACKAGE_MAPS.has(tokens[index - 2].value)
      ) {
        context.fill('type', index, partner[index] === -1 ? index : partner[index]);
      }
    });
  }

  /** Is the text of this literal token a finding under a secret-like name? */
  const offends = (token) => {
    if (token.type === 'string') {
      return !quotedValueIsAllowed(token.value);
    }
    if (token.type === 'number') {
      return true;
    }
    if (token.type === 'template') {
      // `${x}` is a reference, `${x}text` starts with one; text first counts as written.
      return token.plain || token.head !== '' ? !literalIsAllowed(token.head) : false;
    }
    return false;
  };
  const isLiteral = (token) =>
    token !== undefined && ['string', 'number', 'template'].includes(token.type);
  const opens = (index) =>
    isPunctuator(tokens[index]) && tokens[index].value in OPENERS && partner[index] > index;

  /**
   * Is the `{` at `index` the braces around one expression, as in name={value} of a JSX
   * element, and not an object? An object starts with `name:`, `name,`, `...` or `[`.
   */
  const isContainer = (index) => {
    if (!opens(index) || tokens[index].value !== '{' || partner[index] === index + 1) {
      return false;
    }
    const first = tokens[index + 1];
    const second = tokens[index + 2];
    if (isPunctuator(first, '...') || isPunctuator(first, '[')) {
      return false;
    }
    if (partner[index] === index + 2) {
      return isLiteral(first);
    }
    if (isPunctuator(second, ':') || isPunctuator(second, ',') || isPunctuator(second, '(')) {
      return false;
    }
    for (let at = index + 1; at < partner[index]; at += 1) {
      if (opens(at)) {
        at = partner[at];
      } else if (isPunctuator(tokens[at], ',')) {
        return false;
      }
    }
    return true;
  };

  /** The index after the expression that starts at `start`. */
  const endOfExpression = (start) => {
    // name="text" and name={...} in a JSX element: the next attribute, `>` or `/>`
    // follows the value, where JavaScript would need an operator.
    const last =
      tokens[start]?.type === 'string' ? start : isContainer(start) ? partner[start] : -1;
    const after = tokens[last + 1];
    if (
      last !== -1 &&
      ((isWord(after) && !AFTER_A_VALUE.has(after.value) && after.line === tokens[last].line) ||
        isPunctuator(after, '>') ||
        isPunctuator(after, '/'))
    ) {
      return last + 1;
    }
    let index = start;
    while (index < tokens.length) {
      const token = tokens[index];
      if (opens(index)) {
        index = partner[index];
      } else if (
        token.type === 'punctuator' &&
        (token.value === ',' ||
          token.value === ';' ||
          CLOSERS.has(token.value) ||
          token.value in OPENERS)
      ) {
        break;
      }
      const next = tokens[index + 1];
      if (next !== undefined && next.line > tokens[index].line && !carriesOn(tokens[index], next)) {
        return index + 1;
      }
      index += 1;
    }
    return index;
  };

  /**
   * Does the expression in [start, end) give a literal that is not allowed? It is taken
   * apart at `??`, `||`, `&&` and the branches of a ternary; brackets, `as` and `!` are
   * taken off; `'text' + more` and `text${more}` count by the text they start with.
   */
  const givesLiteral = (start, end) => {
    const parts = [];
    let from = start;
    for (let index = start; index < end; index += 1) {
      if (opens(index)) {
        index = partner[index];
      } else if (isPunctuator(tokens[index]) && ALTERNATIVES.has(tokens[index].value)) {
        parts.push([from, index]);
        from = index + 1;
      }
    }
    parts.push([from, end]);
    return parts.some(([first, afterLast]) => {
      let a = first;
      let b = afterLast;
      for (let index = a + 1; index < b; index += 1) {
        if (opens(index)) {
          index = partner[index];
        } else if (isWord(tokens[index], 'as') || isWord(tokens[index], 'satisfies')) {
          b = index; // ... as string
        }
      }
      while (b > a && isPunctuator(tokens[b - 1], '!')) {
        b -= 1;
      }
      if (b - a >= 2 && isPunctuator(tokens[a], '(') && partner[a] === b - 1) {
        return givesLiteral(a + 1, b - 1);
      }
      if (isContainer(a) && partner[a] === b - 1) {
        return givesLiteral(a + 1, b - 1); // name={'text'} in a JSX element
      }
      // <string>'text': a cast in the old way of TypeScript.
      if (b - a >= 4 && isPunctuator(tokens[a], '<') && isPunctuator(tokens[b - 2], '>')) {
        a = b - 1;
      }
      if (b - a === 2 && ['-', '+'].includes(tokens[a].value) && tokens[a + 1].type === 'number') {
        a += 1;
      }
      if (b - a === 1) {
        return offends(tokens[a]);
      }
      // 'text' + more: a value that starts with written text.
      return b - a > 1 && isLiteral(tokens[a]) && isPunctuator(tokens[a + 1], '+')
        ? offends(tokens[a])
        : false;
    });
  };

  /** The name a `]` ends when it closes ['name'], or null. */
  const computedName = (close) => {
    const open = partner[close];
    return open !== -1 && close - open === 2 && tokens[open + 1].type === 'string'
      ? tokens[open + 1].value
      : null;
  };

  /** The name that the `=` at `index` gives a value to, and where it stands; or null. */
  const targetOf = (index) => {
    // NAME: Type = value, in a declaration, a parameter or a class: the name is before
    // the colon, and no name inside the type is the target.
    for (let at = index - 1, steps = 0; at >= 0 && steps < 64; at -= 1, steps += 1) {
      const token = tokens[at];
      const after = tokens[at + 1];
      if (after.line > token.line && !carriesOn(token, after)) {
        break; // the line before is another statement
      }
      if (token.type === 'punctuator') {
        if (CLOSERS.has(token.value) && partner[at] !== -1) {
          at = partner[at];
        } else if (token.value === ':') {
          let name = at - 1;
          if (isPunctuator(tokens[name], '?') || isPunctuator(tokens[name], '!')) {
            name -= 1;
          }
          const before = tokens[name - 1];
          const declared =
            isWord(tokens[name]) &&
            (before === undefined ||
              (before.type === 'word' &&
                (DECLARES.has(before.value) || MODIFIERS.has(before.value))) ||
              (before.type === 'punctuator' &&
                [',', '(', '{', ';', '}', ')'].includes(before.value)) ||
              before.line < tokens[name].line);
          // `case X:` and `default:` are labels of a switch, not names with a type.
          if (declared && !isWord(before, 'case') && tokens[name].value !== 'default') {
            return { name: tokens[name].value, at: name };
          }
          break;
        } else if (!['.', '|', '&', '<', '>', '?', '=>'].includes(token.value)) {
          break;
        }
      } else if (token.type === 'word' && (DECLARES.has(token.value) || token.value === 'return')) {
        break;
      }
    }
    let left = index - 1;
    if (isPunctuator(tokens[left], '!')) {
      left -= 1;
    }
    const token = tokens[left];
    if (isWord(token) && !NOT_A_NAME.has(token.value)) {
      return { name: token.value, at: left };
    }
    if (isPunctuator(token, ']')) {
      const name = computedName(left);
      return name === null ? null : { name, at: partner[left] };
    }
    return null;
  };

  // Second pass: every place where a name gets a value.
  tokens.forEach((token, index) => {
    if (token.type !== 'punctuator' || context[index] === 'type' || context[index] === 'enum') {
      return;
    }
    if (ASSIGNS.has(token.value)) {
      const target = targetOf(index);
      if (
        target !== null &&
        kind[target.at - 1] !== 'alias' &&
        isSecretLikeName(target.name) &&
        givesLiteral(index + 1, endOfExpression(index + 1))
      ) {
        report(tokens[target.at].line, target.name);
      }
    } else if (token.value === ':' && context[index] === 'object') {
      // name: value, 'name': value, ['name']: value, right after `{` or `,`.
      const key = tokens[index - 1];
      let name = null;
      let first = index - 1;
      if (key !== undefined && (key.type === 'word' || key.type === 'string')) {
        name = key.value;
      } else if (isPunctuator(key, ']')) {
        name = computedName(index - 1);
        first = partner[index - 1];
      }
      const before = tokens[first - 1];
      if (
        name !== null &&
        (isPunctuator(before, '{') || isPunctuator(before, ',')) &&
        isSecretLikeName(name) &&
        givesLiteral(index + 1, endOfExpression(index + 1))
      ) {
        report(tokens[first].line, name);
      }
    } else if (token.value === '??' || token.value === '||') {
      // secretLike ?? 'literal': a literal as the fallback of a secret-like reference.
      const left = tokens[index - 1];
      const name =
        isWord(left) && !NOT_A_NAME.has(left.value)
          ? left.value
          : isPunctuator(left, ']')
            ? computedName(index - 1)
            : null;
      if (name !== null && isSecretLikeName(name)) {
        const limit = endOfExpression(index + 1);
        let end = index + 1;
        while (end < limit && !(isPunctuator(tokens[end]) && ALTERNATIVES.has(tokens[end].value))) {
          end = opens(end) ? partner[end] + 1 : end + 1;
        }
        if (givesLiteral(index + 1, end)) {
          report(left.line, name);
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** In a package.json these hold names of packages with their versions. */
const PACKAGE_MAPS = new Set([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'overrides',
  'resolutions',
]);

const JAVASCRIPT = /\.(?:[cm]?[jt]sx?)$/i;
const JSON_FILE = /\.(?:json[c5l]?|ndjson|webmanifest)$/i;
const YAML = /\.ya?ml$/i;
/** A file whose name says nothing (`.babelrc`) and that starts as an object is JSON. */
const NO_EXTENSION = /(?:^|[\\/])\.?[^.\\/]+$/;

/**
 * Findings in one text. The name of the file decides how it is read.
 * @returns {{ line: number, name: string }[]} in the order of the lines, each once
 */
export function scanText(file, text) {
  const found = new Map();
  const report = (line, name) => {
    found.set(`${String(line)}\u0000${name}`, { line, name });
  };
  if (JAVASCRIPT.test(file)) {
    scanTokens(tokenize(text), report);
  } else if (JSON_FILE.test(file) || (NO_EXTENSION.test(file) && /^\s*\{/.test(text))) {
    const manifest = /(?:^|[\\/])package\.json$/.test(file);
    scanTokens(tokenize(text), report, { json: true, manifest });
  } else if (YAML.test(file)) {
    scanYaml(text, report);
  } else {
    scanLines(text, report);
  }
  return [...found.values()].sort((a, b) => a.line - b.line);
}

/**
 * The files under `root` that git tracks or would take: every tracked file, and every
 * other file that no `.gitignore` leaves out.
 *
 * Git answers both questions itself. For the second one it is given an empty repository
 * of its own as the index, so that the answer is the same in a clone, in a work tree and
 * in a plain copy of the files.
 */
export function listFiles(root) {
  const run = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
      .split('\0')
      .filter((file) => file !== '');
  const files = new Set();
  try {
    // Tracked files, also one that was added although a .gitignore names it.
    for (const file of run(['ls-files', '--cached', '-z'])) {
      files.add(file);
    }
  } catch {
    // not inside a repository: a plain copy of the files
  }
  const gitDirectory = mkdtempSync(path.join(tmpdir(), 'secret-assignments-'));
  try {
    execFileSync('git', ['init', '--quiet', '--bare', gitDirectory], { stdio: 'ignore' });
    const others = [
      `--git-dir=${gitDirectory}`,
      `--work-tree=${root}`,
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ];
    for (const file of run(others)) {
      files.add(file);
    }
  } finally {
    rmSync(gitDirectory, { recursive: true, force: true });
  }
  return [...files].sort();
}

/** `a/b/` (a folder), `a/b.json` (a file) or a glob with `*`, `**` and `?`, as a test. */
function excluder(patterns) {
  const tests = patterns.map((pattern) => {
    const source = pattern
      .replaceAll('\\', '/')
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\/?/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replaceAll('\u0000', '(?:.*/)?');
    return new RegExp(`^${source}${pattern.endsWith('/') ? '' : '(?:/|$)'}`);
  });
  return (file) => tests.some((test) => test.test(file));
}

/**
 * Scans every file under `root` that git tracks or would take.
 * @param {string} root
 * @param {{ exclude?: string[] }} [options] paths and globs, relative to `root`, that
 *   are left out: what the repository generates or vendors
 * @returns {{ file: string, line: number, name: string }[]}
 */
export function scanDirectory(root, options = {}) {
  const excluded = excluder(options.exclude ?? []);
  const findings = [];
  for (const file of listFiles(root)) {
    if (LOCKFILES.includes(path.posix.basename(file)) || excluded(file)) {
      continue;
    }
    const absolute = path.join(root, file);
    let content;
    try {
      const status = lstatSync(absolute);
      if (!status.isFile() || status.size > LARGEST_FILE) {
        continue;
      }
      content = readFileSync(absolute);
    } catch {
      continue; // listed and gone
    }
    if (content.subarray(0, 8000).includes(0)) {
      continue; // not a text
    }
    for (const finding of scanText(file, content.toString('utf8'))) {
      findings.push({ file, ...finding });
    }
  }
  return findings;
}

/** One finding per two lines, with the path as git and secretlint print it. Never the value. */
export function formatFindings(root, findings) {
  return findings
    .map(({ file, line, name }) => {
      const location = path.join(root, file).replaceAll('\\', '/');
      return `${location}\n  ${String(line)}  error  a literal value is bound to "${name}", a name like a secret. Leave it empty, refer to something else, or start a placeholder with ${PLACEHOLDER_PREFIXES.join(' or ')}.`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// The corpora
// ---------------------------------------------------------------------------

/**
 * Runs the two corpora beside this file.
 * @returns {Promise<{ reported: object, ordinary: object, ok: boolean }>}
 */
export async function selfTest() {
  const beside = (name) =>
    pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), name)).href;
  const { REPORTED } = await import(beside('secret-assignments.reported.mjs'));
  const { ORDINARY } = await import(beside('secret-assignments.ordinary.mjs'));

  const missed = [];
  for (const { syntax, what, file, text, names } of REPORTED) {
    const found = scanText(file, text).map(({ name }) => name);
    if (JSON.stringify(found) !== JSON.stringify(names)) {
      missed.push({ syntax, what, file, expected: names, found });
    }
  }
  const wrong = [];
  for (const { what, file, text } of ORDINARY) {
    const found = scanText(file, text);
    if (found.length > 0) {
      wrong.push({ what, file, found });
    }
  }
  return {
    reported: {
      total: REPORTED.length,
      syntaxes: [...new Set(REPORTED.map(({ syntax }) => syntax))],
      missed,
    },
    ordinary: { total: ORDINARY.length, wrong },
    ok: missed.length === 0 && wrong.length === 0,
  };
}

// ---------------------------------------------------------------------------
// As a program
// ---------------------------------------------------------------------------

async function main(args) {
  if (args.includes('--self-test')) {
    const result = await selfTest();
    if (args.includes('--json')) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      for (const { syntax, what, file, expected, found } of result.reported.missed) {
        process.stdout.write(
          `NOT REPORTED  ${syntax}: ${what} (${file}): expected ${expected.join(', ')}, found ${found.join(', ') || 'nothing'}\n`,
        );
      }
      for (const { what, file, found } of result.ordinary.wrong) {
        process.stdout.write(
          `REPORTED      ${what} (${file}): ${found.map(({ line, name }) => `${name} in line ${String(line)}`).join(', ')}\n`,
        );
      }
      process.stdout.write(
        `shapes that must be reported: ${String(result.reported.total - result.reported.missed.length)} of ${String(result.reported.total)}; ` +
          `ordinary lines left alone: ${String(result.ordinary.total - result.ordinary.wrong.length)} of ${String(result.ordinary.total)}\n`,
      );
    }
    return result.ok ? 0 : 1;
  }

  const exclude = [];
  let directory = '.';
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--exclude') {
      exclude.push(args[index + 1] ?? '');
      index += 1;
    } else {
      directory = args[index];
    }
  }
  const root = path.resolve(directory);
  const findings = scanDirectory(root, { exclude });
  if (findings.length > 0) {
    process.stdout.write(`${formatFindings(root, findings)}\n\n`);
    process.stdout.write(
      `${String(findings.length)} literal value(s) bound to a name like a secret.\n`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
