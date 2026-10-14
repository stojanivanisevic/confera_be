// The scan for secrets that are given away by their NAME. Version: see VERSION below.
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
// (smtpPassword, SMTP_PASSWORD, smtp-password, "smtp password"), by its LAST word:
//
//     - the last word is, or ends with: password, passwd, pwd, passphrase, secret, token
//       (PGPASSWORD, DBPASSWD, MYSQL_PWD, keyPassphrase, csrfToken, clientSecret)
//     - the last word is: pass, credential, credentials (DB_PASS, smtpPass; not bypass)
//     - the last word is `key` and the word before it is one of: api, private, data,
//       access, secret, signing, encryption, master, client, session
//       (AWS_SECRET_ACCESS_KEY, DATA_KEY, signingKey)
//
// Qualifier words after the secret word, and a number, do not count: sandbox, live,
// prod, production, staging, test, dev, local, previous, prev, old, new, current, next,
// primary, secondary, backup, rotated (PAYPAL_CLIENT_SECRET_SANDBOX, DATA_KEY_PREVIOUS,
// SMTP_PASSWORD_2). `passwordPolicy`, `tokenType`, `secretName`, `PASSWORD_MIN_LENGTH`
// end with another word and are not secret-like; nor are `primaryKey`, `sortKey`,
// `cacheKey`, `publicKey`, `idempotencyKey`, nor plurals (`secrets`, `tokens`).
//
// ALLOWED VALUES, and nothing else:
//
//     - nothing: an empty value, `null`, `~`, `true`, `false` (no value, or a flag)
//     - a reference to something else as the WHOLE value: `${VAR}`, `$VAR`, `$1`, `$@`,
//       references one after the other (`$PREFIX$SUFFIX`), `$(command)`,
//       `${{ secrets.X }}`, `{{ value }}`, a YAML alias; in JavaScript any expression
//       that is not a literal (`process.env.X`, a call, another variable); in PowerShell
//       a command or a call (`$p = Read-Host`)
//     - a placeholder: a literal that STARTS with `invented-` or `local-only-`
//
// A list of values under a secret-like name is read value by value.
//
// There is no guess by length or by randomness: `'too_short'` under a secret-like name is
// a finding, and so is `changeme`. The code is changed to follow the rule.
//
// THE WRITTEN EXCEPTIONS, and no others:
//
//     - `credentials` of the Fetch API takes a mode: under exactly that name, exactly
//       'include', 'same-origin' and 'omit' are not a finding
//     - versions under names of packages: the maps dependencies, devDependencies,
//       optionalDependencies, peerDependencies, overrides, resolutions, catalog and
//       catalogs of a package manifest or a pnpm workspace file (also pnpm.overrides)
//     - GitHub Actions: under `permissions`, the levels read, write and none
//       (`id-token: write`)
//
// SYNTAX, by the kind of file (an extension such as .example or .dist after the real one
// does not count: `compose.yml.example` is YAML):
//
//     JavaScript, TypeScript     an assignment (also +=, ??=), a declaration (typed or
//     (.js .cjs .mjs .jsx        not), a class field, an object property, a default
//      .ts .cts .mts .tsx)       parameter, an attribute of a JSX element, and a literal
//                                used as a fallback for such a name (`??`, `||`, a
//                                ternary branch), also inside the `${...}` of a template
//     JSON (.json .jsonc)        "name": value, in any letter case
//     YAML (.yml .yaml)          name: value, in any letter case; lists, mappings in
//                                braces (also over several lines), the lines below
//     every other text file      NAME=value at the start of a line, with or without
//     (.env, shell, Dockerfile,  `export`, quotes, a leading list dash, `ENV`, `ARG` or
//      .npmrc, Markdown, ...)    `RUN`; `ENV NAME value`; several pairs on one line; and
//                                `-e NAME=value` or `--env NAME=value` anywhere in a line
//
// A file is read as UTF-8, or as UTF-16 when a byte-order mark says so. A file with a zero
// byte and no such mark is binary and is not read. Comments are not read.
//
// The files are read as their syntax (a tokenizer for JavaScript and JSON, a reader of
// entries for YAML, a reader of lines for the others), not searched with one pattern per
// shape.
//
// Use, as a program (exit code 1 when something is found):
//
//     node secret-assignments.mjs [directory] [--exclude <path or glob>]...
//     node secret-assignments.mjs --self-test [--json]
//     node secret-assignments.mjs --version
//     node secret-assignments.mjs --write-manifest     after a change, with a new VERSION
//
// and as a module: scanDirectory(root, { exclude }), scanText(file, text).
//
// `--self-test` runs the two corpora that lie beside this file: the shapes that must be
// reported (secret-assignments.reported.mjs) and the ordinary lines that must not be
// (secret-assignments.ordinary.mjs). It also compares the three files with the manifest
// beside them (secret-assignments.manifest.json): their version and their SHA-256.
//
// This file and its two corpora have no dependency and hold nothing about the repository
// they are in: copy the three unchanged, with the manifest. What a repository leaves out
// (generated or vendored files) is passed by the caller as `exclude`. Lockfiles are always
// left out.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/** The documented way to write a placeholder: a literal that starts with one of these. */
export const PLACEHOLDER_PREFIXES = ['invented-', 'local-only-'];

/** The version of this scanner and its two corpora, as the manifest beside them records it. */
export const VERSION = '1.0.0';

/**
 * A name is secret-like when its last word is one of these, or ends with one
 * (`PGPASSWORD`, `keyPassphrase`).
 */
export const SECRET_WORD_ENDINGS = ['password', 'passwd', 'pwd', 'passphrase', 'secret', 'token'];

/** ... or when its last word is one of these (`DB_PASS`; `bypass` is not the word), ... */
export const SECRET_LAST_WORDS = ['pass', 'credential', 'credentials'];

/**
 * Words that may follow the secret word and change nothing: which copy of the secret it
 * is (`PAYPAL_CLIENT_SECRET_SANDBOX`, `DATA_KEY_PREVIOUS`). A number may follow too.
 */
export const QUALIFIER_WORDS = [
  'sandbox',
  'live',
  'prod',
  'production',
  'staging',
  'test',
  'dev',
  'local',
  'previous',
  'prev',
  'old',
  'new',
  'current',
  'next',
  'primary',
  'secondary',
  'backup',
  'rotated',
];

/** ... or when its last word is `key` and the word before it is one of these. */
export const SECRET_KEY_QUALIFIERS = [
  'api',
  'private',
  'data',
  'access',
  'secret',
  'signing',
  'encryption',
  'master',
  'client',
  'session',
];

/**
 * The one fixed exception: `credentials` of the Fetch API takes a mode, not a credential.
 * Exactly these values under exactly that name are not a finding; any other literal is.
 */
const FETCH_OPTION = 'credentials';
const FETCH_MODES = new Set(['include', 'same-origin', 'omit']);

function isFetchMode(name, value) {
  return name === FETCH_OPTION && FETCH_MODES.has(value);
}

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
    .map((word) => word.toLowerCase());
}

export function isSecretLikeName(name) {
  const words = wordsOf(name);
  // `API_KEY_2`, `password2`, `SMTP_PASSWORD_OLD`: a number and a qualifier word at the
  // end say which copy of the secret it is; the word before them decides.
  for (;;) {
    const end = words.length - 1;
    if (end >= 0 && /^[0-9]+$/.test(words[end])) {
      words.pop();
    } else if (end > 0 && QUALIFIER_WORDS.includes(words[end].replace(/[0-9]+$/, ''))) {
      words.pop();
    } else {
      break;
    }
  }
  if (words.length === 0) {
    return false;
  }
  const last = words[words.length - 1].replace(/[0-9]+$/, '');
  if (SECRET_WORD_ENDINGS.some((ending) => last.endsWith(ending))) {
    return true; // password, PGPASSWORD, csrfToken, client secret
  }
  if (SECRET_LAST_WORDS.includes(last)) {
    return true;
  }
  if (last === 'key') {
    return SECRET_KEY_QUALIFIERS.includes(words[words.length - 2] ?? '');
  }
  // `apikey`, `SECRETKEY`: the two words written as one, where no casing separates them.
  return last.endsWith('key') && SECRET_KEY_QUALIFIERS.includes(last.slice(0, -'key'.length));
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
  if (/^%[A-Za-z_][A-Za-z0-9_]*%$/.test(text)) {
    return true; // %VAR%
  }
  if (text.startsWith('$') && !text.startsWith('${{')) {
    return isShellReferences(text); // $VAR, $1, "$PREFIX$SUFFIX", ${VAR}, $(command)
  }
  if (text.startsWith('${{')) {
    return closingIndex(text, 0, '${{', '}}') === text.length; // ${{ secrets.X }}
  }
  if (text.startsWith('{{')) {
    return closingIndex(text, 0, '{{', '}}') === text.length; // {{ value }}
  }
  // `command`
  return text.length > 1 && text.startsWith('`') && text.indexOf('`', 1) === text.length - 1;
}

/**
 * Is this text made of references of a shell and nothing else? `$VAR`, `$env:VAR`, `$1`,
 * `$@`, `${VAR}`, `$(command)`, one after the other (`$PREFIX$SUFFIX`). Any written
 * character between them (`$PREFIX-value`) makes it a literal.
 */
function isShellReferences(text) {
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '$') {
      return false;
    }
    const next = text[index + 1] ?? '';
    if (next === '{' || next === '(') {
      const end = closingIndex(text, index + 1, next, next === '{' ? '}' : ')');
      if (end === -1) {
        return false;
      }
      if (next === '{') {
        // ${VAR:-fallback}: the fallback is a value of its own.
        const fallback = /^[A-Za-z_][A-Za-z0-9_]*(:?[-=+])(.*)$/s.exec(
          text.slice(index + 2, end - 1),
        );
        if (fallback !== null && !plainValueIsAllowed(fallback[2])) {
          return false;
        }
      }
      index = end;
    } else if (/[0-9@*#?$!-]/.test(next)) {
      index += 2; // $1, $@, $*, $#, $?, $$, $!, $-
    } else {
      const variable = /^[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)?/.exec(
        text.slice(index + 1),
      );
      if (variable === null) {
        return false;
      }
      index += 1 + variable[0].length;
    }
  }
  return text.length > 0;
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
const DOCKERFILE_PREFIX = /^(?:ONBUILD[ \t]+)?(?:ENV|ARG)[ \t]+/i;
/** RUN of a Dockerfile: a shell command line follows, which may begin with NAME=value. */
const DOCKERFILE_RUN = /^(?:ONBUILD[ \t]+)?RUN[ \t]+/i;
const LINE_NAME = /^[A-Za-z0-9_.$:/@~+-]*[A-Za-z][A-Za-z0-9_.$:/@~+-]*/;
/** `-e NAME=value`, `--env NAME=value`, `--env=NAME=value`: an argument of a command. */
const ENV_ARGUMENT = /(?:^|\s)(?:-e|--env)(?:[ \t]+|=)(["']?)([A-Za-z_][A-Za-z0-9_]*)=/g;

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
 * The value of a variable of PowerShell (`$name = ...`). A word without quotes there is a
 * command (`Read-Host`, `Get-Content`), and brackets are a call or an expression: only a
 * text in quotes or a number is a literal. Anything else gives null.
 */
function powerShellValue(written) {
  const quote = written[0];
  if (quote === '"' || quote === "'") {
    const end = written.indexOf(quote, 1);
    return { value: written.slice(1, end === -1 ? written.length : end), length: written.length };
  }
  const number = /^-?[0-9][0-9_.]*(?=\s|;|$)/.exec(written);
  if (number !== null) {
    return { value: number[0], length: number[0].length };
  }
  if (written.startsWith('$')) {
    return firstWord(written); // another variable: a reference
  }
  return written.trim() === '' ? { value: '', length: written.length } : null;
}

/**
 * The pairs NAME=value that a line begins with. `export`, `ENV`, `RUN`, a list dash and
 * quotes around the pair are stepped over, in any order (`export "NAME=value"`);
 * `ENV NAME value` of a Dockerfile is read too.
 * @returns {{ name: string, value: string }[]}
 */
function pairsOfLine(line) {
  let rest = line.trim();
  let dockerfile = false;
  for (let before = ''; before !== rest;) {
    before = rest;
    rest = rest.replace(/^-[ \t]+/, '');
    if (rest === '' || /^[#;]/.test(rest)) {
      return [];
    }
    // "NAME=value": the quotes are around the whole pair.
    const quote = rest[0];
    if ((quote === '"' || quote === "'") && rest.indexOf(quote, 1) === rest.length - 1) {
      rest = rest.slice(1, -1);
    }
    dockerfile ||= DOCKERFILE_PREFIX.test(rest);
    const prefix =
      LINE_PREFIX.exec(rest) ?? DOCKERFILE_PREFIX.exec(rest) ?? DOCKERFILE_RUN.exec(rest);
    if (prefix) {
      rest = rest.slice(prefix[0].length);
    }
  }

  const pairs = [];
  for (;;) {
    const name = LINE_NAME.exec(rest);
    if (!name) {
      break;
    }
    const after = rest.slice(name[0].length);
    // `=`, and `:=`, `?=`, `+=` of a Makefile or a shell; not `==` or `=~` of a comparison.
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
    if (name[0].startsWith('$')) {
      // $name = ... of PowerShell: one assignment, and a command is no literal.
      const value = powerShellValue(written);
      if (value !== null) {
        pairs.push({ name: name[0], value: value.value });
      }
      break;
    }
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

/** The pairs of `-e NAME=value` and `--env NAME=value` anywhere in a line. */
function argumentPairs(line) {
  const pairs = [];
  for (const match of line.matchAll(ENV_ARGUMENT)) {
    const [whole, quote, name] = match;
    let written = line.slice(match.index + whole.length);
    if (quote !== '') {
      // -e "NAME=value": the value ends where the quotes do.
      const end = written.indexOf(quote);
      written = end === -1 ? written : written.slice(0, end);
    }
    pairs.push({ name, value: firstWord(written).value });
  }
  return pairs;
}

function scanLine(line, number, report, depth = 0) {
  for (const { name, value } of [...pairsOfLine(line), ...argumentPairs(line)]) {
    if (isSecretLikeName(name) && !plainValueIsAllowed(value) && !isFetchMode(name, value)) {
      report(number, name);
    } else if (depth < 2 && value.includes('=')) {
      // Environment=SMTP_PASSWORD=value: the value is a pair of its own.
      scanLine(value, number, report, depth + 1);
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

/** GitHub Actions: under `permissions`, these are levels of access (`id-token: write`). */
const PERMISSION_LEVELS = new Set(['read', 'write', 'none']);

/**
 * The maps of a package manifest or a pnpm workspace file that hold version specifiers
 * under names of packages (`generate-password: 1.7.1`). They are not read.
 */
const DEPENDENCY_MAPS = new Set([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'overrides',
  'resolutions',
  'catalog',
  'catalogs',
]);

/** Files that hold such maps. */
const PACKAGE_FILE = /(?:^|[\\/])(?:package\.json5?|package\.ya?ml|pnpm-workspace\.ya?ml)$/;

/**
 * A value of YAML under a secret-like name. `parents` are the names of the mappings
 * around it, the innermost last.
 */
function yamlValueIsAllowed(raw, name, parents = []) {
  // An anchor names the value and `!!str` says its type: neither changes what it is.
  const value = raw.replace(/^(?:&\S+(?:[ \t]+|$)|!![A-Za-z]+(?:[ \t]+|$))+/, '');
  if (value === '' || /^[*!]/.test(value)) {
    return true; // nothing, an alias, a value that a tag of the application looks up
  }
  const quoted = unquoted(value);
  const text = quoted ?? withoutComment(value).replace(/,$/, '');
  if (isFetchMode(name, text)) {
    return true;
  }
  if (parents[parents.length - 1] === 'permissions' && PERMISSION_LEVELS.has(text)) {
    return true;
  }
  return quoted === null ? plainValueIsAllowed(text) : quotedValueIsAllowed(text);
}

/**
 * A collection in braces or brackets, { a: b } or [a, b], on one line or on several:
 * every entry of it, the nested ones too. A list under a secret-like name (`secret`) is a
 * list of its values, and each must be allowed.
 */
function scanYamlFlow(text, number, report, parents, secret) {
  const end = closingIndex(text, 0, text[0], text[0] === '{' ? '}' : ']');
  if (end === -1) {
    return;
  }
  for (const item of flowItems(text.slice(1, end - 1))) {
    if (text[0] === '[' && secret !== null && !/^[{[]/.test(item)) {
      if (!yamlValueIsAllowed(item, secret, parents)) {
        report(number, secret);
      }
    } else {
      scanYamlEntry(unquoted(item) ?? item, number, report, () => undefined, parents);
    }
  }
}

/**
 * One entry of YAML: `name: value`, or else a line that may begin with NAME=value.
 * `follow` is told when the value comes on the lines below: ('block', name) for a text of
 * several lines after `|` or `>`; ('below', name) for a name with no value on its line;
 * ('flow', name, text) for braces or brackets that close on a later line.
 */
function scanYamlEntry(entry, number, report, follow, parents = []) {
  if (entry.startsWith('{') || entry.startsWith('[')) {
    scanYamlFlow(entry, number, report, parents, null);
    return;
  }
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
    follow('below', name);
  } else if (value.startsWith('{') || value.startsWith('[')) {
    if (closingIndex(value, 0, value[0], value[0] === '{' ? '}' : ']') === -1) {
      follow('flow', name, value);
    } else {
      scanYamlFlow(value, number, report, [...parents, name], secret ? name : null);
    }
  } else if (secret) {
    if (!yamlValueIsAllowed(value, name, parents)) {
      report(number, name);
    }
  } else {
    // run: docker run -e NAME=value ..., command: NAME=value node app.js
    scanLine(unquoted(value) ?? withoutComment(value), number, report);
  }
}

/**
 * @param {boolean} packageFile a package manifest or a pnpm workspace file, whose maps of
 *   dependencies are not read
 */
function scanYaml(text, report, packageFile = false) {
  /**
   * What the lines below belong to: a text of several lines (`kind` 'block'), the value of
   * a name that had none on its line ('below'), a list of values under a secret-like name
   * ('list'), or braces that are still open ('flow').
   */
  let open = null;
  /** The mappings around the current line: { column, name }, the innermost last. */
  const parents = [];
  const names = () => parents.map(({ name }) => name);
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const number = index + 1;
    const indent = /^[ \t]*/.exec(line)[0].length;
    let entry = line.trim();
    if (open !== null && open.kind === 'flow') {
      open.text += `\n${line}`;
      if (closingIndex(open.text, 0, open.text[0], open.text[0] === '{' ? '}' : ']') !== -1) {
        const { name, line: at, text: flowText } = open;
        open = null;
        scanYamlFlow(
          flowText,
          at,
          report,
          [...names(), name],
          isSecretLikeName(name) ? name : null,
        );
      }
      return;
    }
    if (open !== null && entry !== '' && !entry.startsWith('#')) {
      if (open.kind === 'block' && indent > open.indent) {
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
      if (open.kind === 'below' && isSecretLikeName(open.name)) {
        const item = /^-(?:[ \t]+|$)(.*)$/.exec(entry);
        if (item !== null && indent >= open.indent) {
          // name:
          //   - value        a list of values under a secret-like name
          open = { ...open, kind: 'list', indent };
        } else if (indent > open.indent && !YAML_KEY.test(entry)) {
          // name:
          //   value          a plain value on the next line
          const { name, line: at } = open;
          open = null;
          if (!yamlValueIsAllowed(entry, name, names())) {
            report(at, name);
          }
          return;
        }
      }
      if (open !== null && open.kind === 'list') {
        const item = /^-(?:[ \t]+|$)(.*)$/.exec(entry);
        if (indent < open.indent || (indent === open.indent && item === null)) {
          open = null; // the list has ended
        } else if (
          item !== null &&
          indent === open.indent &&
          !YAML_KEY.test(item[1]) &&
          !/^[{[]/.test(item[1])
        ) {
          if (!yamlValueIsAllowed(item[1], open.name, names())) {
            report(number, open.name);
          }
          return;
        }
        // Otherwise a mapping in the list, or a line inside an item: read as usual.
      } else if (open !== null && (open.kind !== 'block' || indent <= open.indent)) {
        open = null;
      }
    }
    if (entry === '' || entry.startsWith('#') || entry === '---' || entry === '...') {
      return;
    }
    // A key that follows list dashes stands at the column after them.
    let column = indent;
    for (let dash = /^-[ \t]+/.exec(entry); dash; dash = /^-[ \t]+/.exec(entry)) {
      column += dash[0].length;
      entry = entry.slice(dash[0].length);
    }
    while (parents.length > 0 && parents[parents.length - 1].column >= column) {
      parents.pop();
    }
    if (packageFile && names().some((name) => DEPENDENCY_MAPS.has(name))) {
      return; // a version specifier under the name of a package
    }
    const key = YAML_KEY.exec(entry);
    const name = key === null ? null : (key[1] ?? key[2] ?? key[3]).trim();
    if (packageFile && name !== null && DEPENDENCY_MAPS.has(name)) {
      parents.push({ column, name });
      return;
    }
    scanYamlEntry(
      entry,
      number,
      report,
      (kind, opened, flowText) => {
        if (kind === 'below') {
          parents.push({ column, name: opened });
        }
        open = { kind, indent: column, name: opened, line: number, read: false, text: flowText };
      },
      names(),
    );
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
    /** The code inside each `${...}`, which is read as code of its own. */
    const holes = [];
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
          holes,
        };
      } else if (character === '$' && text[at + 1] === '{') {
        head ??= raw;
        substitutions += 1;
        const end = endOfSubstitution(at + 2);
        if (end === -1) {
          return -1;
        }
        holes.push({ from: at + 2, to: end - 1 });
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
          holes: end.holes.map(({ from: start, to }) => ({
            text: text.slice(start, to),
            // The line of the hole: the line of the template, plus the lines before it.
            line: line + (text.slice(index, start).match(/\n/g)?.length ?? 0),
          })),
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
const ASSIGNS = new Set(['=', '??=', '||=', '&&=', '+=']);

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
  const offends = (token, name = '') => {
    if (token.type === 'string') {
      return !quotedValueIsAllowed(token.value) && !isFetchMode(name, token.value);
    }
    if (token.type === 'number') {
      return true;
    }
    if (token.type === 'template') {
      if (token.plain && isFetchMode(name, token.head)) {
        return false;
      }
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
   * `name` is the name the value is bound to, for the one exception of the rule.
   */
  const givesLiteral = (start, end, name) => {
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
        return givesLiteral(a + 1, b - 1, name);
      }
      if (isContainer(a) && partner[a] === b - 1) {
        return givesLiteral(a + 1, b - 1, name); // name={'text'} in a JSX element
      }
      if (isPunctuator(tokens[a], '[') && partner[a] === b - 1) {
        // A list of values: ['deploy', 'value']. Each element is a value of the name.
        let element = a + 1;
        for (let index = a + 1; index <= b - 1; index += 1) {
          if (opens(index)) {
            index = partner[index];
          } else if (index === b - 1 || isPunctuator(tokens[index], ',')) {
            if (
              index > element &&
              !isPunctuator(tokens[element], '...') &&
              givesLiteral(element, index, name)
            ) {
              return true;
            }
            element = index + 1;
          }
        }
        return false;
      }
      // <string>'text': a cast in the old way of TypeScript.
      if (b - a >= 4 && isPunctuator(tokens[a], '<') && isPunctuator(tokens[b - 2], '>')) {
        a = b - 1;
      }
      if (b - a === 2 && ['-', '+'].includes(tokens[a].value) && tokens[a + 1].type === 'number') {
        a += 1;
      }
      if (b - a === 1) {
        return offends(tokens[a], name);
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

  /** The name that a reference ends with at `index`: `a.b.name` or `a['name']`; or null. */
  const nameEndingAt = (index) => {
    const token = tokens[index];
    if (isWord(token) && !NOT_A_NAME.has(token.value)) {
      return token.value;
    }
    return isPunctuator(token, ']') ? computedName(index) : null;
  };

  /** The index after one operand: up to the next `??`, `||`, `?`, `:` or the end. */
  const endOfOperand = (start) => {
    const limit = endOfExpression(start);
    let end = start;
    while (end < limit && !(isPunctuator(tokens[end]) && ALTERNATIVES.has(tokens[end].value))) {
      end = opens(end) ? partner[end] + 1 : end + 1;
    }
    return end;
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
        givesLiteral(index + 1, endOfExpression(index + 1), target.name)
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
        givesLiteral(index + 1, endOfExpression(index + 1), name)
      ) {
        report(tokens[first].line, name);
      }
    } else if (token.value === '??' || token.value === '||') {
      // secretLike ?? 'literal': a literal as the fallback of a secret-like reference.
      const name = nameEndingAt(index - 1);
      if (
        name !== null &&
        isSecretLikeName(name) &&
        givesLiteral(index + 1, endOfOperand(index + 1), name)
      ) {
        report(tokens[index - 1].line, name);
      }
    } else if (token.value === '?' && !isPunctuator(tokens[index + 1], ':')) {
      // secretLike ? secretLike : 'literal': the same fallback, written as a ternary.
      let colon = -1;
      for (let at = index + 1, nested = 0; at < tokens.length && colon === -1; at += 1) {
        if (opens(at)) {
          at = partner[at];
        } else if (isPunctuator(tokens[at], '?')) {
          nested += 1;
        } else if (isPunctuator(tokens[at], ':')) {
          if (nested === 0) {
            colon = at;
          }
          nested -= 1;
        } else if (
          isPunctuator(tokens[at]) &&
          (tokens[at].value === ',' || tokens[at].value === ';' || CLOSERS.has(tokens[at].value))
        ) {
          break;
        }
      }
      // The name is the one the first branch ends with; a condition alone
      // (`password ? 'yes' : 'no'`) binds nothing to it.
      const name = colon === -1 ? null : nameEndingAt(colon - 1);
      if (
        name !== null &&
        isSecretLikeName(name) &&
        givesLiteral(colon + 1, endOfOperand(colon + 1), name)
      ) {
        report(tokens[colon - 1].line, name);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** In a package manifest these hold names of packages with their versions: DEPENDENCY_MAPS. */
const PACKAGE_MAPS = DEPENDENCY_MAPS;

const JAVASCRIPT = /\.(?:[cm]?[jt]sx?)$/i;
const JSON_FILE = /\.(?:json[c5l]?|ndjson|webmanifest)$/i;
const YAML = /\.ya?ml$/i;
/** A file whose name says nothing (`.babelrc`) and that starts as an object is JSON. */
const NO_EXTENSION = /(?:^|[\\/])\.?[^.\\/]+$/;
/**
 * An extension that says what a file is FOR, not what it is written in: the one before it
 * decides (`compose.yml.example` is YAML, `settings.json.dist` is JSON).
 */
const SECOND_EXTENSION = /\.(?:example|sample|dist|template|tmpl|tpl|default|orig|bak|local|in)$/i;

/**
 * JavaScript and TypeScript, and the code inside every `${...}` of a template, which is
 * read as code of its own (`Bearer ${process.env.API_TOKEN ?? 'value'}`).
 */
function scanJavaScript(text, report) {
  const tokens = tokenize(text);
  scanTokens(tokens, report);
  for (const token of tokens) {
    for (const hole of token.holes ?? []) {
      scanJavaScript(hole.text, (line, name) => {
        report(hole.line + line - 1, name);
      });
    }
  }
}

/**
 * Findings in one text. The name of the file decides how it is read.
 * @returns {{ line: number, name: string }[]} in the order of the lines, each once
 */
export function scanText(file, text) {
  const found = new Map();
  const report = (line, name) => {
    found.set(`${String(line)}\u0000${name}`, { line, name });
  };
  let syntax = file;
  while (SECOND_EXTENSION.test(syntax) && /\.[^.\\/]+\.[^.\\/]+$/.test(syntax)) {
    syntax = syntax.replace(SECOND_EXTENSION, '');
  }
  if (JAVASCRIPT.test(syntax)) {
    scanJavaScript(text, report);
  } else if (JSON_FILE.test(syntax) || (NO_EXTENSION.test(syntax) && /^\s*\{/.test(text))) {
    scanTokens(tokenize(text), report, { json: true, manifest: PACKAGE_FILE.test(syntax) });
  } else if (YAML.test(syntax)) {
    scanYaml(text, report, PACKAGE_FILE.test(syntax));
  } else {
    scanLines(text, report);
  }
  return [...found.values()].sort((a, b) => a.line - b.line);
}

/**
 * The text of a file, or null when it is not a text. UTF-8, with or without a byte-order
 * mark, and UTF-16 in either order of bytes when a byte-order mark says so (what
 * PowerShell 5 writes with `>`). A file with a zero byte and no such mark is binary.
 */
export function decode(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2, buffer.length - (buffer.length % 2)));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buffer.subarray(0, 8000).includes(0)) {
    return null;
  }
  const text = buffer.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Findings in the bytes of one file; none when it is not a text. */
export function scanBuffer(file, buffer) {
  const text = decode(buffer);
  return text === null ? [] : scanText(file, text);
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
    for (const finding of scanBuffer(file, content)) {
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
  const beside = (name) => pathToFileURL(path.join(HERE, name)).href;
  const { REPORTED } = await import(beside(SCANNER_FILES[1]));
  const { ORDINARY } = await import(beside(SCANNER_FILES[2]));

  /** A corpus entry as the bytes of a file: UTF-8, or UTF-16 with its byte-order mark. */
  const findingsOf = ({ file, text, encoding }) => {
    if (encoding === undefined) {
      return scanText(file, text);
    }
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    if (encoding === 'utf-16be') {
      bytes.swap16();
    }
    return scanBuffer(file, bytes);
  };

  const missed = [];
  for (const entry of REPORTED) {
    const found = findingsOf(entry).map(({ name }) => name);
    if (JSON.stringify(found) !== JSON.stringify(entry.names)) {
      const { syntax, what, file, names } = entry;
      missed.push({ syntax, what, file, expected: names, found });
    }
  }
  const wrong = [];
  for (const entry of ORDINARY) {
    const found = findingsOf(entry);
    if (found.length > 0) {
      wrong.push({ what: entry.what, file: entry.file, found });
    }
  }
  const manifest = checkManifest();
  return {
    version: VERSION,
    reported: {
      total: REPORTED.length,
      names: REPORTED.reduce((count, { names }) => count + names.length, 0),
      syntaxes: [...new Set(REPORTED.map(({ syntax }) => syntax))],
      missed,
    },
    ordinary: { total: ORDINARY.length, wrong },
    manifest,
    ok: missed.length === 0 && wrong.length === 0 && manifest.ok,
  };
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The three files that are copied together, unchanged. */
export const SCANNER_FILES = [
  'secret-assignments.mjs',
  'secret-assignments.reported.mjs',
  'secret-assignments.ordinary.mjs',
];

/** Beside the three files: their version and their hashes. */
export const MANIFEST_FILE = 'secret-assignments.manifest.json';

/**
 * The manifest of the three files in `directory`: the version of the scanner and the
 * SHA-256 of each file, taken over its text with LF line endings, so that a checkout with
 * CRLF gives the same hash.
 */
export function manifestOf(directory = HERE) {
  const files = {};
  for (const name of SCANNER_FILES) {
    const text = readFileSync(path.join(directory, name), 'utf8').replace(/\r\n/g, '\n');
    files[name] = createHash('sha256').update(text, 'utf8').digest('hex');
  }
  return {
    scanner: 'secret-assignments',
    version: VERSION,
    hash: 'sha256, LF line endings',
    files,
  };
}

/**
 * Compares the three files beside this one with the manifest beside them. A copy in
 * another repository that was changed, or is of another version, fails here.
 */
export function checkManifest(directory = HERE) {
  const file = path.join(directory, MANIFEST_FILE);
  if (!existsSync(file)) {
    return { ok: false, problems: [`${MANIFEST_FILE} is missing beside the scanner`] };
  }
  const recorded = JSON.parse(readFileSync(file, 'utf8'));
  const actual = manifestOf(directory);
  const problems = [];
  if (recorded.version !== actual.version) {
    problems.push(
      `the manifest is of version ${String(recorded.version)}, the scanner is ${actual.version}`,
    );
  }
  for (const name of SCANNER_FILES) {
    if (recorded.files?.[name] !== actual.files[name]) {
      problems.push(`${name} is not the file the manifest records`);
    }
  }
  return { ok: problems.length === 0, version: recorded.version, problems };
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
      process.stdout.write(
        result.manifest.ok
          ? `manifest: the three files are version ${VERSION}, as ${MANIFEST_FILE} records\n`
          : `MANIFEST      ${result.manifest.problems.join('; ')}\n`,
      );
    }
    return result.ok ? 0 : 1;
  }
  if (args.includes('--version')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.includes('--write-manifest')) {
    // After a change of the scanner or a corpus, and with a new VERSION.
    writeFileSync(path.join(HERE, MANIFEST_FILE), `${JSON.stringify(manifestOf(), null, 2)}\n`);
    process.stdout.write(`wrote ${MANIFEST_FILE} for version ${VERSION}\n`);
    return 0;
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
