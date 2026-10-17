import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkConfiguration } from '../../forms/configuration';
import { buildDefinition, type FormDefinition, parseDefinition } from '../../forms/definition';
import { proofOfWorkHolds, solveProofOfWork } from '../../forms/proof-of-work';
import { checkAnswers, countWords, hasUrl } from '../../forms/rules';
import { parseSafeText, safeTextProblem } from '../../forms/safe-text';
import { serialise } from '../openapi/files';
import {
  FORM_CONFIGURATION_SCHEMA_FILE,
  FORM_DEFINITION_SCHEMA_FILE,
  FORM_RULE_VECTORS_FILE,
  formConfigurationSchemaDocument,
  formDefinitionSchemaDocument,
  formRuleVectorsDocument,
} from './form-contracts-file';
import { ANSWER_VECTORS, URL_VECTORS, VECTOR_DEFINITION, WORD_VECTORS } from './form-rule-vectors';
import { CONTRACTS_DIRECTORY } from './password-rules-file';

/** The rule interpreter against its shared vectors (ADR-09, M3-BE-02, ST-41). */
describe('the rule interpreter of the forms', () => {
  it.each(ANSWER_VECTORS.map((vector) => [vector.name, vector] as const))('%s', (_name, vector) => {
    const result = checkAnswers(VECTOR_DEFINITION, JSON.parse(vector.answers));
    expect(result.ok ? [] : result.errors).toEqual(vector.errors);
    if (vector.kept !== undefined) {
      expect(result).toEqual({ ok: true, answers: vector.kept });
    }
  });

  it.each(WORD_VECTORS)('counts $words words in $text', ({ text, words }) => {
    expect(countWords(text)).toBe(words);
  });

  it.each(URL_VECTORS)('the URL rule on $text: refused $refused', ({ text, refused }) => {
    expect(hasUrl(text)).toBe(refused);
  });

  it('a refused key never reaches the kept answers, and no prototype is touched', () => {
    const result = checkAnswers(VECTOR_DEFINITION, JSON.parse('{"__proto__":{"polluted":true}}'));
    expect(result.ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('the stated maxima hold whatever a planted definition says (ST-41)', () => {
    const planted = JSON.parse(JSON.stringify(VECTOR_DEFINITION)) as {
      sections: {
        repeat: { max: number } | null;
        fields: { rules: { maxLength: number | null; maxWords: number | null } }[];
      }[];
    };
    for (const section of planted.sections) {
      if (section.repeat !== null) {
        section.repeat.max = 10_000;
      }
      for (const field of section.fields) {
        field.rules.maxLength = null;
        field.rules.maxWords = null;
      }
    }
    // A definition beyond the stated maxima is refused when it is read ...
    expect(() => parseDefinition(planted)).toThrow();
    // ... and the interpreter holds them even when it is handed one.
    const definition = planted as unknown as FormDefinition;
    const many = Array.from({ length: 500 }, () => ({
      firstName: 'Ana',
      lastName: 'Bojić',
      institution: 'Institut',
      email: 'ana@example.test',
    }));
    const authors = checkAnswers(definition, { authors: many });
    expect(authors.ok ? [] : authors.errors).toContainEqual({
      path: 'authors',
      code: 'tooManyItems',
    });
    const megabyte = checkAnswers(definition, { comments: 'x'.repeat(1024 * 1024) });
    expect(megabyte.ok ? [] : megabyte.errors).toContainEqual({
      path: 'comments',
      code: 'tooLong',
    });
  });

  it('a configuration is refused beyond the catalogue: mandatory fields, caps, options, links', () => {
    expect(checkConfiguration('abstract', { maxAuthors: 51 }).ok).toBe(false);
    expect(checkConfiguration('abstract', { fields: { isAdmin: { enabled: true } } }).ok).toBe(
      false,
    );
    expect(checkConfiguration('abstract', { extra: 1 }).ok).toBe(false);
    expect(
      checkConfiguration('abstract', {
        texts: {
          title: { en: 'Line\nbreak', sr: '' },
          consent: { en: 'Read [this](javascript:alert)', sr: '' },
        },
        fields: {
          title: { enabled: false },
          participationType: { required: false },
          attendance: { options: { by_boat: { en: 'By boat', sr: 'Brodom' } } },
          keywords: { maxWords: 3 },
          heardFrom: { file: { accept: ['pdf'] } },
          biographies: { file: { accept: ['png'] } },
          institution: { maxLength: 301 },
        },
      }),
    ).toEqual({
      ok: false,
      problems: [
        { path: 'texts.title.en', code: 'invalidCharacters' },
        { path: 'texts.consent.en', code: 'badLink' },
        { path: 'fields.title.enabled', code: 'mandatoryField' },
        { path: 'fields.participationType.required', code: 'mandatoryField' },
        { path: 'fields.attendance.options.by_boat', code: 'unknownOption' },
        { path: 'fields.keywords.maxWords', code: 'notApplicable' },
        { path: 'fields.heardFrom.file', code: 'notApplicable' },
        { path: 'fields.biographies.file.accept', code: 'typeNotAllowed' },
        { path: 'fields.institution.maxLength', code: 'aboveCap' },
      ],
    });
  });

  it('a configuration within the catalogue builds the definition it says (FR-FORM-02)', () => {
    const checked = checkConfiguration('abstract', {
      maxAuthors: 6,
      texts: { closed: { en: 'Closed for now.', sr: 'Zatvoreno.' } },
      fields: {
        abstract: { maxWords: 300, label: { en: 'Summary', sr: 'Sažetak' } },
        orcid: { enabled: false },
        institution: { required: false },
        biographies: { file: { accept: ['pdf'], maxBytes: 5 * 1024 * 1024 } },
      },
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) {
      return;
    }
    const definition = buildDefinition('abstract', checked.configuration);
    expect(parseDefinition(definition)).toEqual(definition);
    const fields = new Map(definition.sections.flatMap((s) => s.fields.map((f) => [f.key, f])));
    expect(fields.get('abstract')?.rules.maxWords).toBe(300);
    expect(fields.get('abstract')?.label).toEqual({ en: 'Summary', sr: 'Sažetak' });
    expect(fields.has('orcid')).toBe(false);
    expect(fields.get('institution')?.required).toBe(false);
    expect(fields.get('biographies')?.rules.file).toEqual({
      accept: ['pdf'],
      maxBytes: 5 * 1024 * 1024,
    });
    expect(definition.sections.find((s) => s.key === 'authors')?.repeat?.max).toBe(6);
    expect(definition.texts.closed).toEqual({ en: 'Closed for now.', sr: 'Zatvoreno.' });
  });

  it('the seeded abstract form takes 10 authors, 500 words and files of 20 MB (D7, FR-FILE-01)', () => {
    const definition = buildDefinition('abstract', {});
    expect(definition.sections.find((s) => s.key === 'authors')?.repeat?.max).toBe(10);
    const fields = new Map(definition.sections.flatMap((s) => s.fields.map((f) => [f.key, f])));
    expect(fields.get('abstract')?.rules.maxWords).toBe(500);
    expect(fields.get('biographies')?.rules.file).toEqual({
      accept: ['pdf', 'docx', 'doc'],
      maxBytes: 20 * 1024 * 1024,
    });
  });

  it('form texts are plain text with the safe link syntax only', () => {
    expect(parseSafeText('See [terms](terms) and <b>x</b>')).toEqual([
      { type: 'text', text: 'See ' },
      { type: 'link', text: 'terms', target: 'terms' },
      { type: 'text', text: ' and <b>x</b>' },
    ]);
    expect(safeTextProblem('[x](http://example.test)', 100)).toBe('badLink');
    expect(safeTextProblem('[x](https://user:pw@example.test)', 100)).toBe('badLink');
    expect(safeTextProblem('ok \u202E', 100)).toBe('invalidCharacters');
    expect(safeTextProblem('ok', 1)).toBe('tooLong');
  });

  it('the proof-of-work holds for its counter and for nothing else', () => {
    const counter = solveProofOfWork('test-challenge', 8);
    expect(proofOfWorkHolds('test-challenge', 8, counter)).toBe(true);
    expect(proofOfWorkHolds('test-challenge', 8, `0${counter}`)).toBe(false);
    expect(proofOfWorkHolds('test-challenge', 8, 12)).toBe(false);
    expect(proofOfWorkHolds('test-challenge', 8, '1'.repeat(13))).toBe(false);
  });

  it.each([
    [FORM_RULE_VECTORS_FILE, formRuleVectorsDocument],
    [FORM_DEFINITION_SCHEMA_FILE, formDefinitionSchemaDocument],
    [FORM_CONFIGURATION_SCHEMA_FILE, formConfigurationSchemaDocument],
  ])('the committed contracts/%s is current', (file, document) => {
    const committed = readFileSync(join(process.cwd(), CONTRACTS_DIRECTORY, file), 'utf8');
    expect(committed).toBe(serialise(document()));
  });
});
