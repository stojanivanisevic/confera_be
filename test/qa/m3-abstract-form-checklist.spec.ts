import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildDefinition,
  type FieldDefinition,
  type FormDefinition,
} from '../../src/modules/forms/definition';
import { DEFAULT_FILE_BYTES } from '../../src/modules/forms/catalogue';
import { repoRoot } from '../support/run-node';

/**
 * M3-QA-02, the checklist of FR-FORM-01: the seeded abstract form, field by field, against the
 * current abstract form of the conference sites (ITEMA 2026, read on 2026-10-12: vault
 * "UDEKOM Conference Submission Forms 2026-10-12"). Each `it` is one line of that page. Where
 * Confera differs on purpose, the line says so and the test holds the decided form.
 */
const definition: FormDefinition = buildDefinition('abstract', {});

function field(key: string): FieldDefinition {
  for (const section of definition.sections) {
    const found = section.fields.find((candidate) => candidate.key === key);
    if (found !== undefined) {
      return found;
    }
  }
  throw new Error(`The abstract form has no field ${key}`);
}
const values = (key: string) => (field(key).options ?? []).map((option) => option.value);
const english = (key: string) => (field(key).options ?? []).map((option) => option.label.en);
const sectionOf = (key: string) =>
  definition.sections.find((section) => section.fields.some((f) => f.key === key));

describe('M3-QA-02: the seeded abstract form against the ITEMA 2026 form (FR-FORM-01)', () => {
  it('the seed publishes exactly the catalogue defaults (seed:e2e takes the contract`s definition)', () => {
    const contract = JSON.parse(
      readFileSync(join(repoRoot, 'contracts', 'form-rule-vectors.json'), 'utf8'),
    ) as { seededAbstractDefinition: unknown };
    expect(contract.seededAbstractDefinition).toEqual(JSON.parse(JSON.stringify(definition)));
  });

  it('participation: with an abstract and a paper, or without a paper', () => {
    expect(values('participationType')).toEqual(['with_paper', 'without_paper']);
    expect(field('participationType').required).toBe(true);
  });

  it('authors: name, institution, institution address, ORCID iD and email in every block; the phone only in the first', () => {
    const authors = sectionOf('email');
    expect(authors?.repeat).not.toBeNull();
    expect(authors?.fields.map((f) => f.key)).toEqual([
      'firstName',
      'lastName',
      'institution',
      'institutionAddress',
      'orcid',
      'email',
      'phone',
    ]);
    expect(field('phone').onlyFirstInRepeat).toBe(true);
    expect(field('orcid').rules.pattern).toBe('orcid');
    expect(field('email').kind).toBe('email');
  });

  it('authors: ITEMA offers 1 to 3 and charges each one beyond three; Confera takes up to 10 (D7) and says so from the fourth', () => {
    const authors = sectionOf('email')?.repeat;
    expect(authors?.min).toBe(1);
    expect(authors?.max).toBe(10);
    expect(authors?.noticeFrom).toBe(4);
    expect(authors?.notice?.en).toMatch(/beyond the third/);
  });

  it('paper: title, abstract of up to 500 words, keywords', () => {
    expect(field('title').required).toBe(true);
    expect(field('abstract').kind).toBe('longText');
    expect(field('abstract').rules.maxWords).toBe(500);
    expect(field('keywords').required).toBe(true);
    // Shown with a paper only (ITEMA shows the block to everyone; without a paper it is empty).
    expect(sectionOf('title')?.visibleWhen).toEqual({
      field: 'participationType',
      in: ['with_paper'],
    });
  });

  it('file: biographies with photos of all authors; ITEMA asks for doc or docx under 5 MB, Confera takes PDF too, up to 20 MB (FR-FILE-01)', () => {
    expect(field('biographies').kind).toBe('file');
    expect(field('biographies').label.en).toMatch(/photos of all authors/);
    expect(field('biographies').rules.file).toEqual({
      accept: ['pdf', 'docx', 'doc'],
      maxBytes: DEFAULT_FILE_BYTES,
    });
  });

  it('membership of UdEkoM Balkans: yes or no', () => {
    expect(field('membership').kind).toBe('yesNo');
    expect(field('membership').required).toBe(true);
  });

  it('attendance: the five options, and that attendance is not needed for publication', () => {
    expect(values('attendance')).toEqual([
      'in_person',
      'live_online',
      'prerecorded_video',
      'follow_online',
      'not_attending',
    ]);
    expect(english('attendance')[2]).toMatch(/7 minutes/);
    expect(field('attendance').help?.en).toBe('Attendance is not required for publication.');
  });

  it('publication: proceedings or selected papers, a partner monograph, the partner journals, the abstract only', () => {
    expect(english('publication')).toEqual([
      'Proceedings or selected papers',
      'A partner monograph',
      'The partner journals',
      'The abstract only',
    ]);
  });

  it('billing: a discount or waiver (award, peer reviewer, partner institution), the payer with the data of the proforma, four ways to pay', () => {
    expect(field('discountClaim').kind).toBe('yesNo');
    expect(values('discountReason')).toEqual(['award', 'peer_reviewer', 'partner_institution']);
    expect(field('discountReason').visibleWhen).toEqual({ field: 'discountClaim', in: ['yes'] });
    expect(values('payer')).toEqual(['individual', 'employer']);
    expect(field('billingAddress').visibleWhen).toEqual({ field: 'payer', in: ['individual'] });
    for (const key of [
      'employerName',
      'employerAddress',
      'employerTaxNumber',
      'employerRegistrationNumber',
      'billingEmail',
    ]) {
      expect(field(key).visibleWhen).toEqual({ field: 'payer', in: ['employer'] });
      expect(field(key).required).toBe(true);
    }
    expect(values('paymentMethod')).toEqual(['bank_wire', 'card', 'paypal', 'rsd_domestic']);
  });

  it('other: where the author heard of the conference, comments', () => {
    expect(field('heardFrom').required).toBe(false);
    expect(field('comments').kind).toBe('longText');
  });

  it('consent: ITEMA has an agree/disagree radio; Confera has one required box with the privacy notice linked (D6)', () => {
    expect(field('consent').kind).toBe('consent');
    expect(field('consent').required).toBe(true);
    expect(definition.texts.consent.en).toMatch(/\[privacy notice\]\(privacy\)/);
  });

  it('after Send: thanks, and the confirmation on its way', () => {
    expect(definition.texts.thankYou.en).toMatch(/^Thank you\..*confirmation.*on its way/);
    expect(definition.texts.thankYou.sr).not.toBe('');
  });

  it('every label and option has its Serbian text', () => {
    for (const section of definition.sections) {
      expect(section.label.sr).not.toBe('');
      for (const f of section.fields) {
        expect([f.key, f.label.sr]).not.toEqual([f.key, '']);
        for (const option of f.options ?? []) {
          expect([f.key, option.value, option.label.sr]).not.toEqual([f.key, option.value, '']);
        }
      }
    }
  });
});
