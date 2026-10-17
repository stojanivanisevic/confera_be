import { buildDefinition, type FormDefinition } from '../../forms/definition';
import type { RuleError } from '../../forms/rules';

/**
 * The shared vectors of the rule interpreter (ADR-09, M3-BE-02, ST-41): answers, and the
 * errors both interpreters give for them, against one definition. The server owns them; the
 * web application vendors contracts/form-rule-vectors.json and its interpreter must give the
 * same errors, in the same order, and keep the same values.
 */

/** The definition of the vectors: the abstract form with a word limit of 5 and at most 3 authors. */
export const VECTOR_DEFINITION: FormDefinition = buildDefinition('abstract', {
  maxAuthors: 3,
  fields: { abstract: { maxWords: 5 } },
});

export interface AnswerVector {
  readonly name: string;
  /** The answers as JSON text, so that keys like `__proto__` arrive as a parser gives them. */
  readonly answers: string;
  readonly errors: readonly RuleError[];
  /** What is kept, when the answers pass. */
  readonly kept?: Readonly<Record<string, unknown>>;
}

const author = (overrides: Record<string, unknown> = {}) => ({
  firstName: 'Ana',
  lastName: 'Živković',
  institution: 'Univerzitet u Izmišljenom Gradu',
  email: 'ana.zivkovic@example.test',
  ...overrides,
});

/** A complete submission with a paper, paid by the author. */
const complete = (overrides: Record<string, unknown> = {}) => ({
  participationType: 'with_paper',
  authors: [author({ phone: '+381 11 123 4567' })],
  title: 'Učenje na daljinu u malim školama',
  abstract: 'Kratak apstrakt od pet.',
  keywords: 'učenje, škole',
  publication: 'proceedings',
  membership: 'no',
  attendance: 'in_person',
  discountClaim: 'no',
  payer: 'individual',
  billingAddress: 'Izmišljena 1, Beograd',
  paymentMethod: 'bank_wire',
  consent: true,
  ...overrides,
});

const json = (value: unknown) => JSON.stringify(value);

export const ANSWER_VECTORS: readonly AnswerVector[] = [
  {
    name: 'a complete submission with a paper passes',
    answers: json(complete()),
    errors: [],
    kept: complete(),
  },
  {
    name: 'without a paper, the fields of the paper are not shown, not required and not kept',
    answers: json(
      complete({
        participationType: 'without_paper',
        title: 'Ostaje u nacrtu',
        publication: 'proceedings',
      }),
    ),
    errors: [],
    kept: (() => {
      const kept: Record<string, unknown> = complete({ participationType: 'without_paper' });
      for (const key of ['title', 'abstract', 'keywords', 'publication']) {
        Reflect.deleteProperty(kept, key);
      }
      return kept;
    })(),
  },
  {
    name: 'nothing: every required field that is shown is named, in the order of the form',
    answers: json({}),
    errors: [
      { path: 'participationType', code: 'required' },
      { path: 'authors', code: 'tooFewItems' },
      { path: 'membership', code: 'required' },
      { path: 'attendance', code: 'required' },
      { path: 'discountClaim', code: 'required' },
      { path: 'payer', code: 'required' },
      { path: 'paymentMethod', code: 'required' },
      { path: 'consent', code: 'required' },
    ],
  },
  {
    name: 'keys outside the definition are refused, the prototype ones too',
    answers: `{${json(complete()).slice(1, -1)},"__proto__":{"isAdmin":true},"constructor":"x","isAdmin":true}`,
    errors: [
      { path: '__proto__', code: 'unknownField' },
      { path: 'constructor', code: 'unknownField' },
      { path: 'isAdmin', code: 'unknownField' },
    ],
  },
  {
    name: 'a key outside an author block is refused',
    answers: json(complete({ authors: [author({ role: 'admin' })] })),
    errors: [{ path: 'authors[0].role', code: 'unknownField' }],
  },
  {
    name: 'a title with an address is refused (ADR-08)',
    answers: json(complete({ title: 'Pogledajte https://example.test/x' })),
    errors: [{ path: 'title', code: 'noUrl' }],
  },
  {
    name: 'a name with www. and an institution with a mail address are refused',
    answers: json(
      complete({
        authors: [author({ firstName: 'www.example.test', institution: 'pisite@example.test' })],
      }),
    ),
    errors: [
      { path: 'authors[0].firstName', code: 'noUrl' },
      { path: 'authors[0].institution', code: 'noUrl' },
    ],
  },
  {
    name: 'a dotted word in a title is a word, not an address',
    answers: json(complete({ title: 'ASP.NET i Node.js u nastavi' })),
    errors: [],
  },
  {
    name: 'markup in a title is text and passes the rules (the email escapes it)',
    answers: json(complete({ title: '<b>Podebljano</b> & "navodnici"' })),
    errors: [],
  },
  {
    name: 'six words where five are allowed',
    answers: json(complete({ abstract: 'jedan dva tri četiri pet šest' })),
    errors: [{ path: 'abstract', code: 'tooManyWords' }],
  },
  {
    name: 'a title one character over its limit',
    answers: json(complete({ title: 'Ž'.repeat(301) })),
    errors: [{ path: 'title', code: 'tooLong' }],
  },
  {
    name: 'an abstract over its character limit, whatever its words',
    answers: json(complete({ abstract: 'a'.repeat(10_001) })),
    errors: [{ path: 'abstract', code: 'tooLong' }],
  },
  {
    name: 'more authors than the form takes',
    answers: json(complete({ authors: [author(), author(), author(), author()] })),
    errors: [{ path: 'authors', code: 'tooManyItems' }],
  },
  {
    name: 'three authors pass, in order; the phone of a later author is not kept',
    answers: json(
      complete({
        authors: [
          author({ phone: '+381 11 123 4567' }),
          author({ firstName: 'Bojan', phone: '011 222 333' }),
          author({ firstName: 'Čedomir' }),
        ],
      }),
    ),
    errors: [],
    kept: complete({
      authors: [
        author({ phone: '+381 11 123 4567' }),
        author({ firstName: 'Bojan' }),
        author({ firstName: 'Čedomir' }),
      ],
    }),
  },
  {
    name: 'an address that is not one plain address',
    answers: json(
      complete({
        authors: [
          author({ email: 'ana@' }),
          author({ email: 'Ana <ana@example.test>' }),
          author({ email: 'ana@example.test, bojan@example.test' }),
        ],
      }),
    ),
    errors: [
      { path: 'authors[0].email', code: 'notAnEmail' },
      { path: 'authors[1].email', code: 'notAnEmail' },
      { path: 'authors[2].email', code: 'notAnEmail' },
    ],
  },
  {
    name: 'an ORCID iD and a phone that do not have their pattern',
    answers: json(complete({ authors: [author({ orcid: '0000-0002-1825', phone: 'zovite me' })] })),
    errors: [
      { path: 'authors[0].orcid', code: 'pattern' },
      { path: 'authors[0].phone', code: 'pattern' },
    ],
  },
  {
    name: 'the employer pays: its billing data become required (FR-FORM-05)',
    answers: json(complete({ payer: 'employer', billingAddress: 'ne prikazuje se' })),
    errors: [
      { path: 'employerName', code: 'required' },
      { path: 'employerAddress', code: 'required' },
      { path: 'employerTaxNumber', code: 'required' },
      { path: 'employerRegistrationNumber', code: 'required' },
      { path: 'billingEmail', code: 'required' },
    ],
  },
  {
    name: 'a claimed discount needs its ground',
    answers: json(complete({ discountClaim: 'yes' })),
    errors: [{ path: 'discountReason', code: 'required' }],
  },
  {
    name: 'a value that is not one of the options',
    answers: json(complete({ attendance: 'by_carrier_pigeon', membership: 'maybe' })),
    errors: [
      { path: 'membership', code: 'notAnOption' },
      { path: 'attendance', code: 'notAnOption' },
    ],
  },
  {
    name: 'a consent that is not given',
    answers: json(complete({ consent: false })),
    errors: [{ path: 'consent', code: 'required' }],
  },
  {
    name: 'a consent given as text is the wrong type',
    answers: json(complete({ consent: 'true' })),
    errors: [{ path: 'consent', code: 'wrongType' }],
  },
  {
    name: 'a number where a text belongs, an object where the authors belong',
    answers: json(complete({ title: 42, authors: { firstName: 'Ana' } })),
    errors: [
      { path: 'authors', code: 'wrongType' },
      { path: 'title', code: 'wrongType' },
    ],
  },
  {
    name: 'a control character and a direction override in a name',
    answers: json(
      complete({ authors: [author({ firstName: 'An\u0007a', lastName: 'Živ\u202Ekov' })] }),
    ),
    errors: [
      { path: 'authors[0].firstName', code: 'invalidCharacters' },
      { path: 'authors[0].lastName', code: 'invalidCharacters' },
    ],
  },
  {
    name: 'line breaks are kept in a long text and refused in a one-line text',
    answers: json(complete({ comments: 'Prvi red.\nDrugi red.', keywords: 'jedan\ndva' })),
    errors: [{ path: 'keywords', code: 'invalidCharacters' }],
  },
  {
    name: 'values are trimmed and composed (NFC); the domain of an address is lower-cased',
    answers: json(
      complete({
        authors: [
          author({
            firstName: '  Ana  ',
            lastName: 'Živković',
            email: 'Ana.Zivkovic@EXAMPLE.TEST',
          }),
        ],
      }),
    ),
    errors: [],
    kept: complete({
      authors: [
        author({ firstName: 'Ana', lastName: 'Živković', email: 'Ana.Zivkovic@example.test' }),
      ],
    }),
  },
  {
    name: 'answers that are not an object',
    answers: json(['participationType', 'with_paper']),
    errors: [{ path: '', code: 'wrongType' }],
  },
];

/** Word counts both sides must agree on. */
export const WORD_VECTORS: readonly { text: string; words: number }[] = [
  { text: '', words: 0 },
  { text: '   ', words: 0 },
  { text: 'jedan', words: 1 },
  { text: 'jedan dva', words: 2 },
  { text: '  jedan\tdva\ntri  ', words: 3 },
  { text: 'e-učenje, škole; ASP.NET', words: 3 },
  { text: 'jedan\u00A0dva', words: 2 },
  { text: 'š č ć ž đ', words: 5 },
];

/** The URL rule (hasUrl), text by text. */
export const URL_VECTORS: readonly { text: string; refused: boolean }[] = [
  { text: 'https://example.test', refused: true },
  { text: 'HTTP://EXAMPLE.TEST', refused: true },
  { text: 'ftp://example.test/x', refused: true },
  { text: 'Pogledajte www.example.test', refused: true },
  { text: 'mailto:ana', refused: true },
  { text: 'ana.zivkovic@example.test', refused: true },
  { text: 'example.test/stranica', refused: true },
  { text: 'ASP.NET i Node.js', refused: false },
  { text: 'Ulaz/izlaz u nastavi', refused: false },
  { text: 'Škola 2.0', refused: false },
  { text: 'Fakultet tehničkih nauka', refused: false },
];
