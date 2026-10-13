// The second half of the secret scan (ADR-01, test ST-11).
//
// secretlint knows the FORMAT of many credentials (a GitHub token, an AWS key, a private
// key, an address with a password). A mail password, a PayPal client secret or a data key
// has no format: it is any text. What gives those away is the NAME they are assigned to.
// This scan reports a literal value that is assigned to a name like a secret:
//
//   SMTP_PASSWORD=...        in an environment or configuration file (KEY=value, KEY: value)
//   clientSecret: '...'      a quoted value anywhere, source code included
//
// A placeholder is written the documented way, with the prefix `invented-` or
// `local-only-`; such a value, an empty one and a reference (`${VAR}`, `<set on the server>`)
// are not reported. A finding names the file, the line and the variable, never the value.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Source code and JSON: an unquoted value there is an expression, not a literal. */
const CODE_FILE = /\.(?:[cm]?[jt]sx?|json)$/i;

/** The documented way to write a placeholder (README, "Dependencies and the supply chain"). */
const PLACEHOLDER = /^(?:invented-|local-only-)/;

const SHORTEST_SECRET = 8;
const LARGEST_FILE = 2 * 1024 * 1024;

// NAME=value or NAME: value, the whole line. The value may be quoted and may be followed by a comment.
const ENVIRONMENT_LINE =
  /^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]*)[ \t]*[=:][ \t]*(["']?)([^\s"'#]*)\2[ \t]*(?:#.*)?$/;

// An upper-case name with a word that means "secret", or with KEY as a word of its own.
const SECRET_WORD = /(?:PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL)/;
const KEY_WORD = /(?:^|_)KEY(?:_|$)/;

// name: 'value', name = "value", "name": "value" (any case, camelCase or with - and _).
const QUOTED_ASSIGNMENT =
  /([A-Za-z0-9_.-]*(?:pass(?:word|wd)|secret|token|credential|(?:api|private|data|client|signing|encryption)[_-]?key)[A-Za-z0-9_-]*)["'`]?[ \t]*[:=][ \t]*(["'])([^"'\s]*)\2/gi;

// A name that says where a secret is, or what it is called, holds no secret itself.
const NOT_THE_SECRET_ITSELF = /(?:url|uri|path|file|dir|name|header|prefix|field|column|ttl)$/i;

function isLiteralSecret(value) {
  return (
    value.length >= SHORTEST_SECRET &&
    !PLACEHOLDER.test(value) &&
    // A reference or a template, not a literal.
    !/[${}<>]/.test(value) &&
    // A number is a setting (a lifetime, a length), not a secret.
    !/^[0-9]+$/.test(value)
  );
}

/**
 * Findings in one text. `file` decides which rules apply.
 * @returns {{ line: number, name: string }[]}
 */
export function scanText(file, text) {
  const findings = [];
  const isCode = CODE_FILE.test(file);
  const lines = text.split(/\r?\n/);
  lines.forEach((content, index) => {
    const seen = new Set();
    const report = (name) => {
      if (!seen.has(name)) {
        seen.add(name);
        findings.push({ line: index + 1, name });
      }
    };

    if (!isCode) {
      const assignment = ENVIRONMENT_LINE.exec(content);
      if (assignment) {
        const [, name, , value] = assignment;
        const secretName =
          (SECRET_WORD.test(name) || KEY_WORD.test(name)) && !NOT_THE_SECRET_ITSELF.test(name);
        if (secretName && isLiteralSecret(value)) {
          report(name);
        }
      }
    }

    for (const match of content.matchAll(QUOTED_ASSIGNMENT)) {
      const [, name, , value] = match;
      if (!NOT_THE_SECRET_ITSELF.test(name) && isLiteralSecret(value)) {
        report(name);
      }
    }
  });
  return findings;
}

/**
 * The files under `root` that git would take: everything that no `.gitignore` excludes.
 *
 * Git answers the question itself, with an empty repository of its own as the index, so
 * that the answer is the same in a clone, in a work tree and in a plain copy of the files.
 */
export function listFiles(root) {
  const gitDirectory = mkdtempSync(path.join(tmpdir(), 'confera-secret-scan-'));
  try {
    execFileSync('git', ['init', '--quiet', '--bare', gitDirectory], { stdio: 'ignore' });
    const listed = execFileSync(
      'git',
      [
        `--git-dir=${gitDirectory}`,
        `--work-tree=${root}`,
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
      ],
      { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
    return listed.split('\0').filter((file) => file !== '');
  } finally {
    rmSync(gitDirectory, { recursive: true, force: true });
  }
}

/**
 * Scans every file under `root` that git would take.
 * @returns {{ file: string, line: number, name: string }[]}
 */
export function scanDirectory(root) {
  const findings = [];
  for (const file of listFiles(root)) {
    const absolute = path.join(root, file);
    let content;
    try {
      if (statSync(absolute).size > LARGEST_FILE) {
        continue;
      }
      content = readFileSync(absolute);
    } catch {
      continue; // listed and gone, or not a regular file
    }
    if (content.subarray(0, 8000).includes(0)) {
      continue; // binary
    }
    for (const finding of scanText(file, content.toString('utf8'))) {
      findings.push({ file, ...finding });
    }
  }
  return findings;
}

/** One line per finding, with the path as git and secretlint print it. */
export function formatFindings(root, findings) {
  return findings
    .map(({ file, line, name }) => {
      const location = path.join(root, file).replaceAll('\\', '/');
      return `${location}\n  ${String(line)}  error  a literal value is assigned to "${name}", which is named like a secret. A placeholder starts with invented- or local-only-.`;
    })
    .join('\n');
}
