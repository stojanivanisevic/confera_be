import ts from 'typescript';

/**
 * Two scans over TypeScript source text, used by the architecture tests of ST-09
 * (govcore matrix, row 2: "a second master-password variable outside the DEV_ prefix").
 * They work on the syntax tree, so an alias, a computed name or a copy cannot go around
 * them the way they go around a lint selector.
 *
 * Each scan takes a file name and its text and returns one line per finding.
 */

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function shorten(text: string): string {
  const single = text.replace(/\s+/g, ' ');
  return single.length > 80 ? `${single.slice(0, 77)}...` : single;
}

// ---------------------------------------------------------------------------
// 1. Who touches the process environment
// ---------------------------------------------------------------------------

/**
 * What code outside the configuration module may use of `process`: output, exit and
 * time. Not `env`, and nothing through which the environment can be reached (`binding`,
 * `mainModule`, the object itself).
 */
export const ALLOWED_PROCESS_MEMBERS: readonly string[] = [
  'argv',
  'execPath',
  'exit',
  'exitCode',
  'hrtime',
  'stderr',
  'stdout',
];

const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'self', 'window']);
const PROCESS_MODULES = new Set(['process', 'node:process']);

/**
 * Every place where the text reaches for the process environment, or could:
 * `process.env`, `process['env']`, `const { env } = process`, `const p = process`,
 * `globalThis.process`, an import of `process` or `node:process`, `process` handed to a
 * function. Uses of the members in ALLOWED_PROCESS_MEMBERS are not findings.
 */
export function environmentAccesses(fileName: string, text: string): string[] {
  const source = parse(fileName, text);
  const findings: string[] = [];
  const add = (node: ts.Node, what: string): void => {
    findings.push(`${fileName}:${String(lineOf(source, node))}: ${what}`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'process') {
      const parent = node.parent;
      const isObjectOfAccess = ts.isPropertyAccessExpression(parent) && parent.expression === node;
      const isMemberName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node);
      if (isObjectOfAccess) {
        const member = parent.name.text;
        if (!ALLOWED_PROCESS_MEMBERS.includes(member)) {
          add(node, `process.${member}`);
        }
      } else if (isMemberName) {
        if (
          ts.isPropertyAccessExpression(parent) &&
          ts.isIdentifier(parent.expression) &&
          GLOBAL_OBJECTS.has(parent.expression.text)
        ) {
          add(node, `${parent.expression.text}.process`);
        }
      } else {
        add(node, `"process" used as a value: ${shorten(parent.getText(source))}`);
      }
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      GLOBAL_OBJECTS.has(node.expression.text) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'process'
    ) {
      add(node, `${node.expression.text}['process']`);
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      PROCESS_MODULES.has(node.moduleSpecifier.text)
    ) {
      add(node, `import of "${node.moduleSpecifier.text}"`);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]!) &&
      PROCESS_MODULES.has(node.arguments[0].text)
    ) {
      add(node, `import of "${node.arguments[0].text}"`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

// ---------------------------------------------------------------------------
// 2. A credential compared with a configuration value
// ---------------------------------------------------------------------------

/** Names that stand for something a person or a client presents to get in. */
const CREDENTIAL =
  /pass(word|wd|phrase|code)?s?\b|pwd|secret|token|credential|master|backdoor|bypass|api[-_]?key|otp\b/i;

/** Names that stand for the configuration or the environment. */
const CONFIGURATION =
  /\bconfig\b|\bconfiguration\b|\bAppConfig\b|\benv\b|\bprocess\b|\.reveal\s*\(/;

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** Functions and methods that compare two values. */
const COMPARING_CALLS = new Set([
  'timingSafeEqual',
  'compare',
  'compareSync',
  'verify',
  'verifySync',
  'equals',
  'isEqual',
  'localeCompare',
  'is',
]);

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text;
  }
  return undefined;
}

/**
 * Every comparison in the text that has a credential on one side and a configuration
 * value on the other, and every comparison that unwraps a `Secret`:
 *
 *   dto.password === this.config.masterPassword
 *   timingSafeEqual(Buffer.from(body.token), Buffer.from(config.support.secret.reveal()))
 *
 * A password is compared with the stored hash of its user and with nothing else
 * (ADR-03); a configuration value never opens a door (ADR-24).
 */
export function credentialComparisons(fileName: string, text: string): string[] {
  const source = parse(fileName, text);
  const findings: string[] = [];

  const judge = (node: ts.Node, operands: readonly ts.Node[]): void => {
    const texts = operands.map((operand) => operand.getText(source));
    const unwraps = texts.some((operand) => /\.reveal\s*\(/.test(operand));
    const credentialAgainstConfiguration = texts.some(
      (operand, index) =>
        CREDENTIAL.test(operand) &&
        texts.some((other, otherIndex) => otherIndex !== index && CONFIGURATION.test(other)),
    );
    const sameOperandBoth = texts.some(
      (operand) => CREDENTIAL.test(operand) && CONFIGURATION.test(operand),
    );
    if (unwraps || credentialAgainstConfiguration || (sameOperandBoth && texts.length > 1)) {
      findings.push(
        `${fileName}:${String(lineOf(source, node))}: ${shorten(node.getText(source))}`,
      );
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      judge(node, [node.left, node.right]);
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name !== undefined && COMPARING_CALLS.has(name)) {
        const receiver = ts.isPropertyAccessExpression(node.expression)
          ? [node.expression.expression]
          : [];
        judge(node, [...receiver, ...node.arguments]);
      }
    }
    if (ts.isSwitchStatement(node)) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) {
          judge(clause, [node.expression, clause.expression]);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}
