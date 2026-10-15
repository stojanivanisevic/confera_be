import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REFUSED_VECTORS, RENDERED_VECTORS } from '../dev-tools/contracts/template-vectors';
import { checkBody, checkSubject, DocumentError } from './document';
import { catalogueOf, LANGUAGES, TEMPLATE_TYPES } from './placeholders';
import { renderTemplate } from './render';

/** The template document format against its shared vectors (ADR-12, ST-58, ST-22). */
describe('the template document format', () => {
  describe('refuses (ST-58)', () => {
    it.each(REFUSED_VECTORS.map((vector) => [vector.name, vector] as const))(
      '%s',
      (_name, vector) => {
        const catalogue = catalogueOf(vector.type);
        const check = () =>
          vector.kind === 'body'
            ? checkBody(vector.document, catalogue)
            : checkSubject(vector.document, catalogue);
        expect(check).toThrow(DocumentError);
        try {
          check();
        } catch (error) {
          expect((error as DocumentError).code).toBe(vector.code);
        }
      },
    );

    it('also at render time, when a document is planted straight into the table', () => {
      const catalogue = catalogueOf('invitation');
      const planted = {
        subject: { type: 'subject', children: [] },
        body: { type: 'doc', children: [{ type: 'script' }] },
      };
      expect(() =>
        renderTemplate(planted, catalogue, { values: {}, conditions: new Set() }),
      ).toThrow(DocumentError);
    });
  });

  describe('renders (ST-22, ST-59)', () => {
    it.each(RENDERED_VECTORS.map((vector) => [vector.name, vector] as const))(
      '%s',
      (_name, vector) => {
        const rendered = renderTemplate(
          { subject: vector.subject, body: vector.body },
          catalogueOf(vector.type),
          {
            values: vector.input.values,
            conditions: new Set(vector.input.conditions),
            link: vector.input.link,
          },
        );
        expect(rendered).toEqual(vector.expected);
      },
    );

    it('a missing value or a missing link is refused, never left as a hole', () => {
      const catalogue = catalogueOf('invitation');
      const stored = {
        subject: { type: 'subject', children: [{ type: 'placeholder', key: 'recipientName' }] },
        body: {
          type: 'doc',
          children: [
            {
              type: 'paragraph',
              children: [
                {
                  type: 'link',
                  href: { placeholder: 'link' },
                  children: [{ type: 'text', text: 'x' }],
                },
              ],
            },
          ],
        },
      };
      expect(() =>
        renderTemplate(stored, catalogue, {
          values: {},
          conditions: new Set(),
          link: 'https://x.test/',
        }),
      ).toThrow('missing_value');
      expect(() =>
        renderTemplate(stored, catalogue, {
          values: { recipientName: 'x' },
          conditions: new Set(),
        }),
      ).toThrow('missing_link');
    });
  });

  describe('the default templates', () => {
    const file = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', 'prisma', 'seed', 'default-templates.json'),
        'utf8',
      ),
    ) as {
      templates: { type: string; language: string; subject: unknown; body: unknown }[];
    };

    it('exist for every type in both languages, and pass the check of their type', () => {
      for (const type of TEMPLATE_TYPES) {
        for (const language of LANGUAGES) {
          const template = file.templates.find(
            (entry) => entry.type === type && entry.language === language,
          );
          expect({ type, language, found: template !== undefined }).toEqual({
            type,
            language,
            found: true,
          });
          const catalogue = catalogueOf(type);
          expect(() => checkSubject(template?.subject, catalogue)).not.toThrow();
          expect(() => checkBody(template?.body, catalogue)).not.toThrow();
        }
      }
      expect(file.templates).toHaveLength(TEMPLATE_TYPES.length * LANGUAGES.length);
    });

    it('a template that carries a link has the link node, and no other has', () => {
      for (const template of file.templates) {
        const hasLink = JSON.stringify(template.body).includes('"placeholder":"link"');
        expect({ type: template.type, hasLink }).toEqual({
          type: template.type,
          hasLink: catalogueOf(template.type as 'invitation').placeholders.has('link'),
        });
      }
    });
  });
});
