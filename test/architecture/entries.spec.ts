import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { repoRoot } from '../support/run-node';

/**
 * Who may start the application (ADR-24, ST-01, ST-04).
 *
 * Until the second fix round of 0.1.0 `start()` of src/bootstrap.ts read the environment
 * itself, so nothing could start the application past the STAGE and INSTANCE guard. Since
 * then the two entries read the configuration first (`configurationOrRefusal` of
 * src/startup.ts) and load the application only for a start that it allows; `start()`
 * takes the configuration it is given. That is faster, and it moves the guarantee from
 * the function to its callers. These tests hold the callers:
 *
 * - the application listens in one place, `start()`;
 * - `start()` is called in the two entries and nowhere else;
 * - each entry calls it only inside the branch that `configurationOrRefusal` allowed,
 *   with the configuration that function returned and nothing else;
 * - a third entry, or a second way to a listening application, fails here until it is
 *   reviewed and added.
 *
 * The scans read the syntax tree, and each is first shown the code it must find.
 */

const SRC = join(repoRoot, 'src');
const BOOTSTRAP = 'src/bootstrap.ts';
const STARTUP = 'src/startup.ts';
const ENTRIES = ['src/main.ts', 'src/modules/dev-tools/main.dev.ts'];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      return name === 'generated' ? [] : sourceFiles(path);
    }
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  name: relative(repoRoot, path).replaceAll('\\', '/'),
  text: readFileSync(path, 'utf8'),
}));

const parse = (name: string, text: string): ts.SourceFile =>
  ts.createSourceFile(name, text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => {
    walk(child, visit);
  });
}

/** The module a file loads, in whatever way: import, export from, require, import(). */
function loadedModules(name: string, text: string): string[] {
  const modules: string[] = [];
  walk(parse(name, text), (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      // `import type` loads nothing when the program runs.
      const typeOnly = ts.isImportDeclaration(node)
        ? node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
        : node.isTypeOnly;
      if (!typeOnly) {
        modules.push(node.moduleSpecifier.text);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      const [argument] = node.arguments;
      modules.push(
        argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : '(computed)',
      );
    }
  });
  return modules;
}

/** Does this file load the bootstrap when the program runs? */
function loadsBootstrap(name: string, text: string): boolean {
  return loadedModules(name, text).some(
    (module) => module === '(computed)' || /(?:^|\/)bootstrap(?:\.js|\.ts)?$/.test(module),
  );
}

/** Every call of a function or method with this name, as "line: text of the call". */
function callsOf(name: string, text: string, called: string): string[] {
  const source = parse(name, text);
  const calls: string[] = [];
  walk(source, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    const callee = node.expression;
    const calledName = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
          ? callee.argumentExpression.text
          : '';
    if (calledName === called) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      calls.push(`${String(line)}: ${node.getText(source).replace(/\s+/g, ' ').slice(0, 60)}`);
    }
  });
  return calls;
}

/**
 * What an entry must look like, read from its syntax tree:
 *
 *   const config = configurationOrRefusal(...);
 *   if (config !== undefined) { ... start(config, ...) ... }
 *
 * Returns the problems; none when the entry has that shape and no other call of `start`.
 */
function entryProblems(name: string, text: string): string[] {
  const source = parse(name, text);
  const problems: string[] = [];

  // 1. Exactly one top-level `const <name> = configurationOrRefusal(...)`.
  const accepted = source.statements.flatMap((statement) =>
    ts.isVariableStatement(statement) &&
    (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
      ? statement.declarationList.declarations.filter(
          (declaration) =>
            ts.isIdentifier(declaration.name) &&
            declaration.initializer !== undefined &&
            ts.isCallExpression(declaration.initializer) &&
            ts.isIdentifier(declaration.initializer.expression) &&
            declaration.initializer.expression.text === 'configurationOrRefusal',
        )
      : [],
  );
  if (accepted.length !== 1) {
    return [`${name}: expected one "const config = configurationOrRefusal(...)" at the top`];
  }
  const [declaration] = accepted as [ts.VariableDeclaration];
  const configName = (declaration.name as ts.Identifier).text;

  // 2. `configurationOrRefusal` is the function of src/startup.ts, imported, not a local one.
  const imported = source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      /(?:^|\/)startup$/.test(statement.moduleSpecifier.text) &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) =>
          element.name.text === 'configurationOrRefusal' && element.propertyName === undefined,
      ),
  );
  if (!imported) {
    problems.push(`${name}: configurationOrRefusal is not imported from the startup module`);
  }

  // 3. Every statement that is not an import or that declaration is the one guarded branch.
  const others = source.statements.filter(
    (statement) =>
      !ts.isImportDeclaration(statement) &&
      !(
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.includes(declaration)
      ),
  );
  const guarded = others.filter(
    (statement): statement is ts.IfStatement =>
      ts.isIfStatement(statement) &&
      statement.elseStatement === undefined &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
      ts.isIdentifier(statement.expression.left) &&
      statement.expression.left.text === configName &&
      ts.isIdentifier(statement.expression.right) &&
      statement.expression.right.text === 'undefined',
  );
  if (guarded.length !== 1 || others.length !== 1) {
    problems.push(
      `${name}: besides the imports and the configuration, the entry must be one "if (${configName} !== undefined) { ... }" and nothing else`,
    );
    return problems;
  }
  const [branch] = guarded as [ts.IfStatement];

  // 4. Nothing of the application is loaded outside that branch.
  const outside = text.slice(0, branch.getStart(source)) + text.slice(branch.getEnd());
  if (loadsBootstrap(name, outside)) {
    problems.push(`${name}: the bootstrap is loaded outside the branch the configuration allowed`);
  }

  // 5. `start` is called once, inside the branch, with that configuration first.
  const starts: ts.CallExpression[] = [];
  walk(source, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'start'
    ) {
      starts.push(node);
    }
  });
  if (starts.length !== 1) {
    problems.push(
      `${name}: start() must be called exactly once, it is called ${String(starts.length)} times`,
    );
  }
  for (const call of starts) {
    const inside =
      call.getStart(source) >= branch.thenStatement.getStart(source) &&
      call.getEnd() <= branch.thenStatement.getEnd();
    const [first] = call.arguments;
    if (!inside) {
      problems.push(`${name}: start() is called outside the branch the configuration allowed`);
    }
    if (first === undefined || !ts.isIdentifier(first) || first.text !== configName) {
      problems.push(
        `${name}: start() must get "${configName}", the configuration that was accepted, as it is`,
      );
    }
  }

  // 6. The accepted configuration is not replaced or filled in on the way.
  walk(source, (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const target = node.left.getText(source);
      if (
        target === configName ||
        target.startsWith(`${configName}.`) ||
        target.startsWith(`${configName}[`)
      ) {
        problems.push(`${name}: the accepted configuration is written to (${target})`);
      }
    }
  });
  return problems;
}

describe('who may start the application (ADR-24)', () => {
  it('reads the source tree', () => {
    expect(files.length).toBeGreaterThan(30);
    for (const name of [BOOTSTRAP, STARTUP, ...ENTRIES]) {
      expect(files.map((file) => file.name)).toContain(name);
    }
  });

  describe('the scans find what they are for', () => {
    const GOOD = [
      "import { configurationOrRefusal } from './startup';",
      'const config = configurationOrRefusal();',
      'if (config !== undefined) {',
      "  const { start } = require('./bootstrap') as typeof import('./bootstrap');",
      '  void start(config);',
      '}',
      '',
    ].join('\n');

    it('an entry of the expected shape has no problem', () => {
      expect(entryProblems('src/entry.ts', GOOD)).toEqual([]);
      expect(loadsBootstrap('src/entry.ts', GOOD)).toBe(true);
    });

    it.each([
      ['no check at all', "import { start } from './bootstrap';\nvoid start(makeConfig());\n"],
      [
        'the check is made and its answer is not used',
        GOOD.replace('if (config !== undefined) {', 'if (true) {'),
      ],
      [
        'a configuration of its own when the check refuses',
        GOOD.replace('void start(config);', 'void start(config ?? fallback);'),
      ],
      [
        'another configuration is started',
        GOOD.replace('void start(config);', 'void start(other);'),
      ],
      [
        'a start in the other branch too',
        GOOD.replace(/\}\n$/, "} else {\n  void require('./bootstrap').start(fallback);\n}\n"),
      ],
      ['a second start after the branch', `${GOOD}void require('./bootstrap').start(fallback);\n`],
      [
        'the application is loaded before the check',
        GOOD.replace(
          "import { configurationOrRefusal } from './startup';",
          "import { configurationOrRefusal } from './startup';\nimport './bootstrap';",
        ),
      ],
      [
        'the check is a function of the entry itself',
        GOOD.replace(
          "import { configurationOrRefusal } from './startup';",
          'const configurationOrRefusal = () => ({}) as never;',
        ),
      ],
      [
        'the accepted configuration is changed before the start',
        GOOD.replace('  void start(config);', "  config.stage = 'local';\n  void start(config);"),
      ],
      [
        'the check is imported under another name',
        GOOD.replace(
          'import { configurationOrRefusal }',
          'import { somethingElse as configurationOrRefusal }',
        ),
      ],
    ])('an entry that is wrong is named: %s', (_what, text) => {
      expect(entryProblems('src/entry.ts', text)).not.toEqual([]);
    });

    it.each([
      ["import { start } from '../bootstrap';", true],
      ["export * from './bootstrap';", true],
      ["const b = require('../../bootstrap');", true],
      ["const b = await import('./bootstrap.js');", true],
      ['const b = require(name);', true],
      ["import type { AppOptions } from './bootstrap';", false],
      ["type B = typeof import('./bootstrap');", false],
      ["import { x } from './bootstrap-helpers';", false],
    ])('loading the bootstrap is seen in "%s": %s', (text, expected) => {
      expect(loadsBootstrap('src/a.ts', text)).toBe(expected);
    });

    it('a call is seen whatever way it is written', () => {
      expect(
        callsOf('src/a.ts', 'await app.listen(1);\napp["listen"](2);\nlisten(3);\n', 'listen'),
      ).toHaveLength(3);
    });
  });

  it('the application listens in one place: start() of the bootstrap', () => {
    const listening = files
      .map(({ name, text }) => ({ name, calls: callsOf(name, text, 'listen') }))
      .filter(({ calls }) => calls.length > 0);
    expect(listening.map(({ name }) => name)).toEqual([BOOTSTRAP]);
    expect(listening[0]?.calls).toHaveLength(1);

    // ... and that place is inside start(), which takes the configuration as its first parameter.
    const source = parse(BOOTSTRAP, files.find(({ name }) => name === BOOTSTRAP)?.text ?? '');
    const start = source.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === 'start',
    );
    expect(start).toBeDefined();
    expect(start?.parameters[0]?.getText(source)).toBe('config: AppConfig');
    expect(start?.parameters[0]?.questionToken).toBeUndefined();
    expect(start?.parameters[0]?.initializer).toBeUndefined();
    expect(callsOf(BOOTSTRAP, start?.getText(source) ?? '', 'listen')).toHaveLength(1);
  });

  it('the bootstrap is loaded, when the program runs, by the two entries and by two reviewed tools', () => {
    const loading = files
      .filter(({ name }) => name !== BOOTSTRAP)
      .filter(({ name, text }) => loadsBootstrap(name, text))
      .map(({ name }) => name)
      .sort();
    expect(loading).toEqual(
      [
        ...ENTRIES,
        // Builds the application for the tests of a module; it never listens (see above).
        'src/common/testing/test-app.ts',
        // Writes the OpenAPI files from the application; a development tool, it never listens.
        'src/modules/dev-tools/openapi/generate.ts',
      ].sort(),
    );
  });

  it('start() is called in the two entries and nowhere else', () => {
    const calling = files
      .filter(({ name }) => name !== BOOTSTRAP)
      .filter(({ name, text }) => callsOf(name, text, 'start').length > 0)
      .map(({ name }) => name)
      .sort();
    expect(calling).toEqual([...ENTRIES].sort());
  });

  it.each(ENTRIES)(
    '%s starts the application only with the configuration that was accepted',
    (name) => {
      const text = files.find((file) => file.name === name)?.text ?? '';
      expect(entryProblems(name, text)).toEqual([]);
    },
  );

  it('the development entry says that it is one, so that it refuses outside local and dev', () => {
    const text = files.find(({ name }) => name === ENTRIES[1])?.text ?? '';
    expect(text).toContain('configurationOrRefusal({ developmentEntry: true })');
    const production = files.find(({ name }) => name === ENTRIES[0])?.text ?? '';
    expect(production).toContain('configurationOrRefusal()');
  });

  it('the check reads the configuration first and loads nothing of the application', () => {
    const text = files.find(({ name }) => name === STARTUP)?.text ?? '';
    const modules = loadedModules(STARTUP, text).sort();
    expect(modules).toEqual(['./config/config', './config/env', './config/stage-guard']);
    // The first statement of the function is the reading of the environment, and every way
    // out that is not the accepted configuration sets the exit code of a refusal.
    const body = text.slice(text.indexOf('export function configurationOrRefusal('));
    expect(body.indexOf('const loaded = loadConfig();')).toBeGreaterThan(-1);
    expect(body.indexOf('const loaded = loadConfig();')).toBeLessThan(body.indexOf('return'));
    expect(body.match(/return undefined;/g)).toHaveLength(2);
    expect(body.match(/process\.exitCode = EXIT_CODE\.configuration;/g)).toHaveLength(2);
    expect(body.match(/\breturn\b/g)).toHaveLength(3);
  });
});
