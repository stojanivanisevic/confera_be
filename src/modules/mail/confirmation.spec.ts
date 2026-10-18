import { renderTemplate } from '../templates/render';
import { catalogueOf } from '../templates/placeholders';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../../../test/support/run-node';
import { CONFIRMATION_TITLE_LENGTH, confirmationTitle } from './mail-sender';

/**
 * ST-35 (M3-BE-06, FR-FORM-15 as amended by SA-13): the confirmation of a submission carries
 * fixed text, the reference and the title only; the title arrives as plain text, without a
 * link or markup, cut to its length, also when a row was planted past the form's rules.
 */
interface StoredTemplate {
  type: string;
  language: string;
  subject: unknown;
  body: unknown;
}

const templates = (
  JSON.parse(readFileSync(join(repoRoot, 'prisma', 'seed', 'default-templates.json'), 'utf8')) as {
    templates: StoredTemplate[];
  }
).templates.filter((template) => template.type === 'submission_confirmation');

describe('the confirmation of a submission (ST-35)', () => {
  it('names no person and nothing else the author typed: its catalogue', () => {
    expect([...catalogueOf('submission_confirmation').placeholders].sort()).toEqual([
      'conferenceName',
      'organisationName',
      'reference',
      'title',
    ]);
    expect(templates.map((template) => template.language).sort()).toEqual(['en', 'sr']);
  });

  it('a title with markup and 10 000 characters arrives escaped, as one line, cut to its length', () => {
    const planted = `<a href="https://x.example.test">klik</a> ${'Ž'.repeat(10_000)}`;
    // A planted title with an address is not shown at all.
    expect(confirmationTitle(planted)).toBeNull();
    const long = `<b>Naslov</b>\r\n${'Ž'.repeat(10_000)}`;
    const title = confirmationTitle(long) ?? '';
    expect(Array.from(title)).toHaveLength(CONFIRMATION_TITLE_LENGTH + 1);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/[\r\n]/);
    for (const template of templates) {
      const rendered = renderTemplate(template, catalogueOf('submission_confirmation'), {
        values: {
          organisationName: 'UdEkoM Balkans',
          conferenceName: 'ITEMA',
          reference: 'IT27-0001',
          title,
        },
        conditions: new Set(['hasTitle']),
      });
      expect(rendered.html).toContain('&lt;b&gt;Naslov&lt;/b&gt;');
      expect(rendered.html).not.toMatch(/<a\s/i);
      expect(rendered.html).not.toContain('<b>');
      expect(rendered.text).toContain('IT27-0001');
      expect(rendered.subject).toContain('IT27-0001');
    }
  });

  it('without a title (no paper) the line of the title is left out', () => {
    for (const template of templates) {
      const rendered = renderTemplate(template, catalogueOf('submission_confirmation'), {
        values: { organisationName: 'U', conferenceName: 'C', reference: 'IT27-0002', title: '' },
        conditions: new Set(),
      });
      expect(rendered.text).not.toMatch(/Title:|Naslov:/);
    }
  });

  it.each([
    ['www.example.test', null],
    ['Pišite na ana@example.test', null],
    ['  Učenje   na\tdaljinu  ', 'Učenje na daljinu'],
    ['', null],
    [null, null],
  ])('the title %j is shown as %j', (title, shown) => {
    expect(confirmationTitle(title)).toBe(shown);
  });

  // SEC-M3-03 (M3-ISS-03): a bare domain, which mail programs make a link of, leaves the title out.
  it.each([
    ['evil.com', null],
    ['Posetite paypal-verify.com danas', null],
    ['Prijava na x.com:8080/a', null],
    ['x.com?a', null],
    ['EVIL.COM', null],
    ['Primer: пример.срб', null],
    ['Primena ASP.NET u nastavi', null],
    ['Šđčćž: učenje na daljinu u Srbiji', 'Šđčćž: učenje na daljinu u Srbiji'],
    ['Industrija 4.0, npr. u Vojvodini', 'Industrija 4.0, npr. u Vojvodini'],
    ['Đorđe i Ćirić: š.č. analiza', 'Đorđe i Ćirić: š.č. analiza'],
  ])('the title %j is shown as %j', (title, shown) => {
    expect(confirmationTitle(title)).toBe(shown);
  });

  it('a domain in the part of a long title that the mail shows leaves it out; the rest is not judged', () => {
    expect(confirmationTitle(`${'a '.repeat(50)}evil.com ${'ž'.repeat(300)}`)).toBeNull();
    expect(confirmationTitle(`${'ž'.repeat(300)} evil.com`)).toBe(`${'ž'.repeat(200)}…`);
  });
});
