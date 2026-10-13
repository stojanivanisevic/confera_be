/**
 * Every route of the dev-tools module. test/build/dev-tools-absent.spec.ts searches the
 * production build for these strings and fails if it finds one (ST-02), so a new
 * dev-tools route must be added here.
 */
export const DEV_TOOLS_ROUTES = {
  info: 'dev/info',
  apiDocs: 'dev/docs',
} as const;
