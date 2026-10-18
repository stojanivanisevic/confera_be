import { AUTHORS_SECTION } from '../forms/catalogue';
import type { AnswerValue, Answers } from '../forms/rules';
import { searchTextOf } from './search';

/**
 * The typed columns of a submission, derived from its checked answers (ADR-06): what the
 * table lists, filters and searches, and its authors in order. The same for a submit
 * (intake.service.ts) and for a correction by an admin (FR-SUB-06), so the two never differ.
 */
export interface AuthorRow {
  readonly position: number;
  readonly firstName: string;
  readonly lastName: string;
  readonly institution: string | null;
  readonly institutionAddress: string | null;
  readonly orcid: string | null;
  readonly email: string;
  readonly phone: string | null;
  readonly isCorresponding: boolean;
}

export interface SubmissionColumns {
  readonly title: string | null;
  readonly participationType: string | null;
  readonly firstAuthorName: string;
  readonly firstAuthorInstitution: string | null;
  readonly correspondingEmail: string;
  readonly correspondingDomain: string;
  readonly authorCount: number;
  readonly authors: readonly AuthorRow[];
}

function asText(value: AnswerValue | Record<string, AnswerValue>[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

export function columnsOf(answers: Answers): SubmissionColumns {
  const blocks = (answers[AUTHORS_SECTION] ?? []) as Record<string, AnswerValue>[];
  const authors = blocks.map((author, index): AuthorRow => ({
    position: index + 1,
    firstName: asText(author.firstName) ?? '',
    lastName: asText(author.lastName) ?? '',
    institution: asText(author.institution),
    institutionAddress: asText(author.institutionAddress),
    orcid: asText(author.orcid),
    email: asText(author.email) ?? '',
    phone: asText(author.phone),
    isCorresponding: index === 0,
  }));
  const first = authors[0];
  const email = first?.email ?? '';
  return {
    title: asText(answers.title),
    participationType: asText(answers.participationType),
    firstAuthorName: `${first?.firstName ?? ''} ${first?.lastName ?? ''}`.trim(),
    firstAuthorInstitution: first?.institution ?? null,
    correspondingEmail: email,
    correspondingDomain: email.slice(email.lastIndexOf('@') + 1).toLowerCase(),
    authorCount: authors.length,
    authors,
  };
}

/** The search text of a submission with these columns (search.ts). */
export function searchTextOfColumns(reference: string, columns: SubmissionColumns): string {
  return searchTextOf(reference, columns.title, columns.authors);
}
