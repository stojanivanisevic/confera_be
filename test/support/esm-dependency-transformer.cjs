// Jest transformer for ESM-only dependencies (NestJS 12).
//
// Jest can `require()` an ES module natively only on Node 24.9 and later. Confera runs on
// Node 22 LTS (ADR-01), where the application itself loads these packages with Node's own
// require(esm), but Jest's module sandbox cannot. This transformer turns the ESM-only
// packages named in jest.config.cjs into CommonJS for the test run only.
// Remove it when the toolchain moves to Node 24.
const { createHash } = require('node:crypto');
const ts = require('typescript');

const VERSION = 'esm-dependency-transformer-v3';

const IMPORT_META_URL = 'require("node:url").pathToFileURL(__filename).href';

// `const require = createRequire(import.meta.url);` in an ES module. CommonJS already has
// a `require` that resolves from the same file, and declaring it twice is a syntax error.
const OWN_REQUIRE = /^[ \t]*const require = createRequire\(import\.meta\.url\);?[ \t]*$/m;

function toCommonJs(sourceText, sourcePath) {
  const patched = sourceText
    .replace(OWN_REQUIRE, '')
    .replaceAll('import.meta.url', IMPORT_META_URL)
    .replaceAll('import.meta.dirname', '__dirname')
    .replaceAll('import.meta.filename', '__filename');
  const result = ts.transpileModule(patched, {
    fileName: sourcePath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2023,
      esModuleInterop: true,
      allowJs: true,
      sourceMap: false,
    },
  });
  return result.outputText;
}

module.exports = {
  process(sourceText, sourcePath) {
    return { code: toCommonJs(sourceText, sourcePath) };
  },
  getCacheKey(sourceText, sourcePath) {
    return createHash('sha256')
      .update(VERSION)
      .update(ts.version)
      .update(sourcePath)
      .update(sourceText)
      .digest('hex');
  },
};
