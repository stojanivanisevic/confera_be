// What the seeds of this repository share: the stage rule of the operator's commands and
// the default email templates. Plain Node, no build needed.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from './process.mjs';
import { EXIT_CONFIGURATION } from './stage.mjs';

export const STAGES = ['local', 'dev', 'test', 'prod'];

/**
 * The stage of an operator's command (the production seed, the first admin): one of the
 * four stages exactly, never a default. Ends the process with exit code 78 otherwise,
 * before anything else is read, and never repeats the value.
 */
export function requireAnyStage(tool) {
  const stage = process.env.STAGE;
  if (typeof stage === 'string' && STAGES.includes(stage)) {
    return stage;
  }
  process.stderr.write(
    [
      `${tool} did not run: STAGE must be one of ${STAGES.join(', ')}.`,
      '  - STAGE: is missing or has another value (there is no default)',
      '',
    ].join('\n'),
  );
  process.exit(EXIT_CONFIGURATION);
}

/** The default templates (ADR-12) of prisma/seed/default-templates.json. */
export function defaultTemplates() {
  return JSON.parse(
    readFileSync(path.join(repoRoot, 'prisma', 'seed', 'default-templates.json'), 'utf8'),
  ).templates;
}

/** Writes the templates an organisation lacks; never changes one an admin edited. */
export async function seedTemplates(client, organisationId) {
  let written = 0;
  for (const template of defaultTemplates()) {
    const result = await client.query(
      `INSERT INTO mail_templates (organisation_id, conference_id, type, language, subject, body)
       VALUES ($1, NULL, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [
        organisationId,
        template.type,
        template.language,
        JSON.stringify(template.subject),
        JSON.stringify(template.body),
      ],
    );
    written += result.rowCount ?? 0;
  }
  return written;
}

/** Runs `work` in one transaction inside an organisation, so that its policies apply. */
export async function inOrganisation(client, organisationId, work) {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.org_id', $1, true)", [organisationId]);
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
