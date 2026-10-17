import { AUDIT_VALUE_FIELDS, valuesMayBeRecorded, visibleChanges } from './audit-fields';
import { AUDIT_ACTIONS, auditedChanges } from './audit-recorder';

/**
 * The recorder keeps old and new values only for the fields on the list in code (ADR-06,
 * SA-18, SEC-A-24; M2-BE-06: "a field off the list leaves a reference only").
 */
describe('the audit recorder', () => {
  it('a field off the list leaves its name and no value', () => {
    const { fields, values } = auditedChanges('user', {
      email: { old: 'mila.petrovic@example.test', new: 'mila.p@example.test' },
      displayName: { old: 'Mila', new: 'Mila P.' },
    });
    expect(fields).toEqual(['displayName', 'email']);
    expect(values).toEqual({});
  });

  it('a field on the list keeps its old and new value', () => {
    const { fields, values } = auditedChanges('organisation', {
      eurBankName: { old: null, new: 'Banka Intesa (izmišljeno)' },
      contactEmail: { old: null, new: 'office@example.test' },
    });
    expect(fields).toEqual(['contactEmail', 'eurBankName']);
    expect(values).toEqual({ eurBankName: { old: null, new: 'Banka Intesa (izmišljeno)' } });
  });

  it('a bank account number is never a value: the log says that it changed (D9)', () => {
    const { fields, values } = auditedChanges('organisation', {
      rsdAccount: { old: null, new: '160-0000000000123-45' },
      eurIban: { old: null, new: 'RS35260005601001611379' },
    });
    expect(fields).toEqual(['eurIban', 'rsdAccount']);
    expect(values).toEqual({});
    expect(AUDIT_VALUE_FIELDS.organisation).not.toContain('rsdAccount');
    expect(AUDIT_VALUE_FIELDS.organisation).not.toContain('eurIban');
  });

  it('an entry written while a field was on the list shows its name only when read (D9)', () => {
    expect(
      visibleChanges('organisation', {
        eurIban: { old: null, new: 'RS35260005601001611379' },
        eurSwift: { old: null, new: 'DBDBRSBG' },
      }),
    ).toEqual({ eurSwift: { old: null, new: 'DBDBRSBG' } });
  });

  it('the same field name under another kind of subject is not on the list', () => {
    expect(valuesMayBeRecorded('organisation', 'address')).toBe(true);
    expect(valuesMayBeRecorded('user', 'address')).toBe(false);
    expect(valuesMayBeRecorded('conference', 'address')).toBe(false);
  });

  it('the list names no field that holds personal data', () => {
    for (const [subject, fields] of Object.entries(AUDIT_VALUE_FIELDS)) {
      expect(subject).not.toBe('user');
      for (const field of fields) {
        // A legal name and a bank's name are a legal entity's; a person's name is not here.
        expect(field).not.toMatch(/email|displayName|password|token|hash|reason|phone|payee/i);
      }
    }
    expect(AUDIT_VALUE_FIELDS.organisation).not.toContain('contactEmail');
    expect(AUDIT_VALUE_FIELDS.organisation).not.toContain('paypalPayee');
  });

  it('the actions are stable codes of the form module.event', () => {
    for (const action of AUDIT_ACTIONS) {
      expect(action).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });
});
