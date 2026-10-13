// What the scan for secret-like names (scripts/secret-assignments/) leaves out in THIS
// repository. The scanner itself knows nothing about the repository it runs in; lockfiles
// it leaves out everywhere.
//
// Only generated or vendored files belong here, and the README lists the same ones
// (section 12, "Secret scan"). A hand-written file with a finding is changed to follow
// the rule, never added to this list.
export const SECRET_SCAN_EXCLUDE = [
  // The OpenAPI documents, generated from the code by `pnpm openapi:generate`.
  'openapi/',
];
