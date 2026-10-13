// The stage rule of the test tools (ADR-24): a tool that exists for development and
// testing refuses to run anywhere else.
//
// `STAGE` has no default here either, and its values are compared exactly, as in the
// application (src/config): a missing, empty or misspelt stage is a refusal, never a
// guess. The message names the variable and never repeats its value.

/** Exit code of a refused start, the same as the application's (EX_CONFIG). */
export const EXIT_CONFIGURATION = 78;

/**
 * Returns the stage when it is one of `allowed`; otherwise prints why the tool does not
 * run and ends the process with exit code 78, before anything else happens.
 */
export function requireStage(tool, allowed) {
  const stage = process.env.STAGE;
  if (typeof stage === 'string' && allowed.includes(stage)) {
    return stage;
  }
  process.stderr.write(
    [
      `${tool} did not run: it is a test tool and runs only on STAGE=${allowed.join(' or ')}.`,
      '  - STAGE: is missing or has another value (there is no default)',
      '',
    ].join('\n'),
  );
  process.exit(EXIT_CONFIGURATION);
}
