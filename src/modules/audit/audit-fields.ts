/**
 * The fields whose old and new VALUES the audit log may keep (ADR-06, SA-18, SEC-A-24):
 * settings that are not personal data. Every other field that changes is kept by its name
 * only ("reference only" is the default), and the recorder refuses to write its values.
 * A field joins this list in a change that a reviewer sees, with the reason.
 *
 * Not on it, on purpose: a person's name, email, role and state (they are about a person);
 * the organisation's contact email and PayPal payee (an address that may be a person's);
 * any free text an admin types as a reason.
 */
export const AUDIT_VALUE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // The issuer data and bank accounts of the organisation (FR-ORG-03): a legal entity's.
  organisation: [
    'legalName',
    'address',
    'registrationNumber',
    'taxNumber',
    'vatNoteSr',
    'vatNoteEn',
    'rsdAccount',
    'eurIban',
    'eurSwift',
    'eurBankName',
  ],
};

/** May the old and new values of this field of this kind of subject be recorded? */
export function valuesMayBeRecorded(subjectType: string, field: string): boolean {
  return (AUDIT_VALUE_FIELDS[subjectType] ?? []).includes(field);
}
