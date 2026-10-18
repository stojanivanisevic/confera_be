import type { Catalogue } from './document';

/**
 * The placeholder catalogue per template type (ADR-12): what a template of each kind may
 * insert, and the conditions it may switch a block on. A key not in the catalogue of the
 * type is refused when the template is saved and again when it is rendered.
 *
 * Every value is plain text; a secure link is never a text placeholder, it is the address
 * of a link node (`{ placeholder: 'link' }`), which exists only in the types that carry one.
 */
export const TEMPLATE_TYPES = [
  'invitation',
  'password_reset',
  'email_change_confirmation',
  'email_change_notice',
  'security_notice',
  'sign_in_brake',
  'test_message',
  'submission_confirmation',
  // The status emails of Spec section 5 (FR-MAIL-03, M4-BE-02): transitions 2 and 4 to 9.
  'submission_opened',
  'submission_returned',
  'submission_resumed',
  'submission_accepted',
  'submission_rejected',
  'submission_withdrawn',
  'submission_reopened',
] as const;

export type TemplateType = (typeof TEMPLATE_TYPES)[number];

export const LANGUAGES = ['en', 'sr'] as const;
export type Language = (typeof LANGUAGES)[number];

const COMMON = ['recipientName', 'organisationName'] as const;

/**
 * A status email (FR-MAIL-05): to the corresponding author, about one submission. Sent by an
 * admin's act, so it may name the first author; `message` is the admin's text for the
 * author (FR-MAIL-08), the one placeholder whose value keeps its line breaks.
 */
const STATUS = [
  'organisationName',
  'conferenceName',
  'reference',
  'title',
  'authorName',
  'message',
] as const;

export const PLACEHOLDERS: Readonly<Record<TemplateType, readonly string[]>> = {
  invitation: [...COMMON, 'inviterName', 'expiresIn', 'link'],
  password_reset: [...COMMON, 'expiresIn', 'link'],
  email_change_confirmation: [...COMMON, 'newEmail', 'expiresIn', 'link'],
  email_change_notice: [...COMMON, 'newEmail'],
  security_notice: [...COMMON, 'change', 'actorName', 'subjectName'],
  sign_in_brake: [...COMMON],
  test_message: ['organisationName', 'serverName'],
  // Fixed text, the reference and the title only (FR-FORM-15, SA-13): no name and nothing
  // else the author typed; the conference and the organisation are the office's own words.
  submission_confirmation: ['organisationName', 'conferenceName', 'reference', 'title'],
  submission_opened: STATUS,
  submission_returned: STATUS,
  submission_resumed: STATUS,
  submission_accepted: STATUS,
  submission_rejected: STATUS,
  submission_withdrawn: STATUS,
  submission_reopened: STATUS,
};

/** Placeholders whose value is several lines: rendered with its line breaks, still escaped. */
export const MULTILINE_PLACEHOLDERS: ReadonlySet<string> = new Set(['message']);

/** Conditions: blocks a template may switch on. None in 0.2.0; "a full paper is due" arrives with 0.5.0. */
export const CONDITIONS: Readonly<Record<TemplateType, readonly string[]>> = {
  invitation: [],
  password_reset: [],
  email_change_confirmation: [],
  email_change_notice: [],
  security_notice: ['hasActor', 'hasSubject'],
  sign_in_brake: [],
  test_message: [],
  submission_confirmation: ['hasTitle'],
  submission_opened: ['hasTitle', 'hasMessage'],
  submission_returned: ['hasTitle', 'hasMessage'],
  submission_resumed: ['hasTitle', 'hasMessage'],
  submission_accepted: ['hasTitle', 'hasMessage'],
  submission_rejected: ['hasTitle', 'hasMessage'],
  submission_withdrawn: ['hasTitle', 'hasMessage'],
  submission_reopened: ['hasTitle', 'hasMessage'],
};

export function catalogueOf(type: TemplateType): Catalogue {
  return { placeholders: new Set(PLACEHOLDERS[type]), conditions: new Set(CONDITIONS[type]) };
}

export function isTemplateType(value: string): value is TemplateType {
  return (TEMPLATE_TYPES as readonly string[]).includes(value);
}

export function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}
