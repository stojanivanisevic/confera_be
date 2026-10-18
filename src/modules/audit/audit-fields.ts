/**
 * The fields whose old and new VALUES the audit log may keep (ADR-06, SA-18, SEC-A-24):
 * settings that are not personal data. Every other field that changes is kept by its name
 * only ("reference only" is the default), and the recorder refuses to write its values.
 * A field joins this list in a change that a reviewer sees, with the reason.
 *
 * Not on it, on purpose: a person's name, email, role and state (they are about a person);
 * the organisation's contact email and PayPal payee (an address that may be a person's);
 * the bank account numbers (D9); any free text an admin types as a reason.
 *
 * The list also applies when the log is READ: an entry written before a field left the
 * list shows that field's name only (`visibleChanges`).
 */
export const AUDIT_VALUE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // The issuer data of the organisation (FR-ORG-03): a legal entity's. The account numbers
  // (`rsdAccount`, `eurIban`) are NOT here (owner decision D9, 2026-10-17): the log says that
  // the bank details changed, not to what, as the notice mail does.
  organisation: [
    'legalName',
    'address',
    'registrationNumber',
    'taxNumber',
    'vatNoteSr',
    'vatNoteEn',
    'eurSwift',
    'eurBankName',
    'mailLogContent',
  ],
  // A mail server's target and settings (FR-SMTP-01): the user name and the sender address
  // may be a person's address, and the password is never a value anywhere.
  mail_server: [
    'name',
    'host',
    'port',
    'tlsMode',
    'fromName',
    'isDefault',
    'isFallback',
    'enabled',
    'sendRatePerMinute',
  ],
  // A conference's settings (FR-CONF-01): data of an event, not of a person.
  conference: [
    'name',
    'code',
    'editionYear',
    'startsOn',
    'endsOn',
    'venue',
    'listedSites',
    'languages',
    'timeZone',
    'state',
    'mailServerId',
    'publicationTermsUrl',
    'privacyNoticeUrl',
  ],
  // A deadline of a conference (FR-DL-03): a date of an event.
  conference_deadline: ['endsOn'],
  // A form: the published version's number and the send breaker (switches, ADR-08). What
  // the draft says is kept by the form versions themselves.
  form: ['versionNumber', 'breakerPerHour', 'breakerPerDay'],
  // The send breaker of the organisation, and how many held emails were released.
  organisation_breaker: ['breakerPerHour', 'breakerPerDay'],
  // A submission's status (Spec section 5): a state of the workflow, not what the author
  // typed. A correction is kept by its field names only; the revisions keep the values.
  submission: ['status'],
  // The status emails switched off for a conference (FR-MAIL-07), and the retention of
  // the mail log (FR-SMTP-06): settings.
  conference_status_emails: ['off'],
  mail_log_retention: ['days'],
};

/** May the old and new values of this field of this kind of subject be recorded? */
export function valuesMayBeRecorded(subjectType: string, field: string): boolean {
  return (AUDIT_VALUE_FIELDS[subjectType] ?? []).includes(field);
}

/** The stored values of an entry that the list allows today; the rest are not shown. */
export function visibleChanges<T>(
  subjectType: string,
  changes: Readonly<Record<string, T>>,
): Record<string, T> {
  const shown: Record<string, T> = {};
  for (const [field, change] of Object.entries(changes)) {
    if (valuesMayBeRecorded(subjectType, field)) {
      shown[field] = change;
    }
  }
  return shown;
}
