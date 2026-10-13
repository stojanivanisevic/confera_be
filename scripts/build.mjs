// Compiles the application with the TypeScript compiler API.
//
//   node scripts/build.mjs <tsconfig> [--watch]
//
// Why not the Nest CLI: @nestjs/cli 12 needs Node 22.22 or later (through
// @angular-devkit 22) and does not start on Node 22.14. This script does what
// `nest build` does for this repository: empty the output folder, compile, and apply the
// @nestjs/swagger compiler plugin, which writes the OpenAPI metadata from the TypeScript
// types of DTOs and controllers (ADR-19).
import { rmSync } from 'node:fs';
import path from 'node:path';
import { before as swaggerPlugin } from '@nestjs/swagger/plugin';
import ts from 'typescript';
import { repoRoot } from './lib/process.mjs';

const SWAGGER_PLUGIN_OPTIONS = {
  classValidatorShim: true,
  introspectComments: true,
};

const formatHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => repoRoot,
  getNewLine: () => '\n',
};

function report(diagnostics) {
  if (diagnostics.length > 0) {
    process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost));
  }
}

function parseArguments() {
  const args = process.argv.slice(2);
  const watch = args.includes('--watch');
  const project = args.find((arg) => !arg.startsWith('--'));
  if (!project) {
    process.stderr.write('Usage: node scripts/build.mjs <tsconfig> [--watch]\n');
    process.exit(2);
  }
  return { configPath: path.resolve(repoRoot, project), watch };
}

function readConfig(configPath) {
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      report([diagnostic]);
      process.exit(1);
    },
  });
  if (!parsed) {
    process.exit(1);
  }
  return parsed;
}

function emptyOutputFolder(outDir) {
  const relative = path.relative(repoRoot, outDir);
  // Only ever delete a build folder inside this repository.
  if (!/^dist(-[a-z]+)?$/.test(relative)) {
    process.stderr.write(`Refusing to empty "${outDir}": not a build folder of this repository.\n`);
    process.exit(1);
  }
  rmSync(outDir, { recursive: true, force: true });
}

function transformersFor(program) {
  return { before: [swaggerPlugin({ ...SWAGGER_PLUGIN_OPTIONS }, program)] };
}

function buildOnce(parsed) {
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const preEmit = ts.getPreEmitDiagnostics(program);
  const emitted = program.emit(undefined, undefined, undefined, false, transformersFor(program));
  const diagnostics = ts.sortAndDeduplicateDiagnostics([...preEmit, ...emitted.diagnostics]);
  report(diagnostics);
  const errors = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error).length;
  if (errors > 0) {
    process.stderr.write(`Build failed: ${String(errors)} error(s).\n`);
    return 1;
  }
  const outDir = path.relative(repoRoot, parsed.options.outDir);
  process.stdout.write(`Built ${String(parsed.fileNames.length)} files into ${outDir}/\n`);
  return 0;
}

function buildAndWatch(configPath) {
  const host = ts.createWatchCompilerHost(
    configPath,
    {},
    ts.sys,
    ts.createEmitAndSemanticDiagnosticsBuilderProgram,
    (diagnostic) => {
      report([diagnostic]);
    },
    (diagnostic) => {
      process.stdout.write(`${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}\n`);
    },
  );
  // Every emit of the watch program goes through the same plugin as a one-off build.
  const createProgram = host.createProgram;
  host.createProgram = (rootNames, options, compilerHost, oldProgram, ...rest) => {
    const builder = createProgram(rootNames, options, compilerHost, oldProgram, ...rest);
    const emit = builder.emit.bind(builder);
    builder.emit = (targetSourceFile, writeFile, cancellationToken, emitOnlyDts) =>
      emit(
        targetSourceFile,
        writeFile,
        cancellationToken,
        emitOnlyDts,
        transformersFor(builder.getProgram()),
      );
    return builder;
  };
  ts.createWatchProgram(host);
}

const { configPath, watch } = parseArguments();
const parsed = readConfig(configPath);
emptyOutputFolder(parsed.options.outDir);
if (watch) {
  buildAndWatch(configPath);
} else {
  process.exit(buildOnce(parsed));
}
