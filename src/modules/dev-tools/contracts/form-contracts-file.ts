import { z } from 'zod';
import { isMailAddress } from '../../../common/validation/mail-address';
import {
  ABSOLUTE_LIMITS,
  DEFAULT_FILE_BYTES,
  DEFAULT_MAX_AUTHORS,
  FIELD_KINDS,
  FILE_TYPES,
  MAX_FILE_BYTES,
  PATTERNS,
  TEXT_LIMITS,
} from '../../forms/catalogue';
import { configurationSchema } from '../../forms/configuration';
import { buildDefinition, formDefinitionSchema } from '../../forms/definition';
import { NAMED_LINKS, parseSafeText } from '../../forms/safe-text';
import {
  PROOF_OF_WORK_DIFFICULTY,
  proofOfWorkHolds,
  solveProofOfWork,
} from '../../forms/proof-of-work';
import { RULE_CODES, checkAnswers, countWords, hasUrl } from '../../forms/rules';
import { ANSWER_VECTORS, URL_VECTORS, VECTOR_DEFINITION, WORD_VECTORS } from './form-rule-vectors';

/**
 * The contracts of the forms for the web application (ADR-09, M3-BE-01, M3-BE-02), written
 * by `pnpm openapi:generate` into contracts/ and held current by `pnpm openapi:check`:
 *
 * - form-definition.schema.json: the JSON schema of a form version's definition;
 * - form-configuration.schema.json: the JSON schema of a form's configuration (the draft);
 * - form-rule-vectors.json: the rules and their vectors, which both interpreters must pass.
 */
export const FORM_DEFINITION_SCHEMA_FILE = 'form-definition.schema.json';
export const FORM_CONFIGURATION_SCHEMA_FILE = 'form-configuration.schema.json';
export const FORM_RULE_VECTORS_FILE = 'form-rule-vectors.json';

const GENERATED = 'Generated from src/modules/forms by `pnpm openapi:generate`; do not edit.';

export function formDefinitionSchemaDocument(): Record<string, unknown> {
  return {
    $comment: `${GENERATED} The definition of a published form version (ADR-09): built by the server from the field catalogue and the admin's configuration; never changed once published.`,
    ...z.toJSONSchema(formDefinitionSchema),
  };
}

export function formConfigurationSchemaDocument(): Record<string, unknown> {
  return {
    $comment: `${GENERATED} The configuration of an abstract form (FR-FORM-02): what an admin may set over the catalogue. Left out: the catalogue's default. The server refuses besides: a mandatory field switched off or made optional (mandatoryField), a limit over the catalogue's cap (aboveCap), an option the field does not have (unknownOption), a word limit or file rule on a field without one (notApplicable), a file type the field may not take (typeNotAllowed), and a text that is not plain text with the safe link syntax (tooLong, invalidCharacters, badLink, required).`,
    ...z.toJSONSchema(configurationSchema('abstract')),
  };
}

const POW_CHALLENGES = ['confera-vector-1', 'confera-vector-2'];
const POW_VECTOR_DIFFICULTY = 10;

export function formRuleVectorsDocument(): Record<string, unknown> {
  return {
    $comment: `${GENERATED} The rules of the public forms (ADR-09, M3-BE-02) and the vectors both the server and the browser must pass: for each answers vector, the same errors (path and code, in this order) and, where given, the same kept values. Paths name a field by its key and a block of a repeating section by its index from 0: authors[2].email.`,
    version: 1,
    codes: RULE_CODES,
    order:
      'The errors come in this order: keys the definition does not have, in the order of the answers; then the sections in order, and in each its fields in order (a repeating section: the count of blocks, then each block in order).',
    shown:
      'A field is shown when its section is shown and its visibleWhen holds (the answer of `field`, trimmed, is one of `in`); in a repeating section a field with onlyFirstInRepeat only in the first block. A field that is not shown is not checked and not kept.',
    values:
      'text, longText, email, choice, yesNo and file take a string; consent takes a boolean (true: given). Every string is composed (NFC) and trimmed; empty is the same as left out. An email address keeps its local part and lower-cases its domain.',
    characters:
      'Refused in every text (invalidCharacters): control characters (in a longText the tab, the line break and the carriage return are allowed), U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069 and U+FEFF. For an email field the code is notAnEmail.',
    checks:
      'In this order, the first that fails gives the code: wrong JSON type (wrongType); empty and required (required; a consent that is not true); more characters (code points) than rules.maxLength (tooLong); choice and yesNo: not an option (notAnOption); file: not a UUID (wrongType); email: not one plain address (notAnEmail); characters (invalidCharacters); more words than rules.maxWords (tooManyWords); the pattern (pattern); the URL rule when rules.noUrl (noUrl).',
    limits: {
      ...ABSOLUTE_LIMITS,
      defaultMaxAuthors: DEFAULT_MAX_AUTHORS,
      defaultFileBytes: DEFAULT_FILE_BYTES,
      maxFileBytes: MAX_FILE_BYTES,
      texts: TEXT_LIMITS,
      submitBodyBytes: 64 * 1024,
    },
    kinds: FIELD_KINDS,
    fileTypes: FILE_TYPES,
    patterns: PATTERNS,
    wordCount: {
      rule: 'Runs of characters between white space (JavaScript /\\s+/u) of the trimmed text.',
      vectors: WORD_VECTORS.map((vector) => ({ ...vector, words: countWords(vector.text) })),
    },
    noUrl: {
      rule: 'Refused: a scheme with // (https://), www., mailto:, a mail address, a host name followed by a path. A dotted word alone is a word.',
      vectors: URL_VECTORS.map((vector) => ({ ...vector, refused: hasUrl(vector.text) })),
    },
    emailAddress: {
      rule: 'The address rule (ADR-09): one plain address of at most 254 characters, a local part of at most 64 of the dot-atom of RFC 5322, a domain of at least two labels, the last of two letters at least. No display name, comma, angle bracket, space or control character.',
      vectors: [
        'ana.zivkovic@example.test',
        'ana+konferencija@sub.example.test',
        'ana@',
        'ana@example',
        'Ana <ana@example.test>',
        'ana@example.test, bojan@example.test',
        'ana zivkovic@example.test',
        'ana..zivkovic@example.test',
        'ana@example.t',
      ].map((address) => ({ address, accepted: isMailAddress(address) })),
    },
    safeText: {
      rule: 'Form texts are plain text; [label](target) is a link when the target is an https address or one of the named links, otherwise it stays text. The named links are the consent links of the conference (D6); a named link the conference has no address for is shown as its label.',
      namedLinks: NAMED_LINKS,
      vectors: [
        'Plain text with <b>markup</b> and {braces}.',
        'I accept the [terms of publication](terms) and the [privacy notice](privacy).',
        'Read [the guide](https://example.test/guide).',
        'Not a link: [click](javascript:alert(1)) or [x](http://example.test).',
      ].map((text) => ({ text, segments: parseSafeText(text) })),
    },
    proofOfWork: {
      rule: 'SHA-256 of the UTF-8 text challenge + ":" + counter begins with at least difficulty zero bits; counter is a decimal number of at most 12 digits, without leading zeros.',
      difficulty: PROOF_OF_WORK_DIFFICULTY,
      vectors: POW_CHALLENGES.flatMap((challenge) => {
        const counter = solveProofOfWork(challenge, POW_VECTOR_DIFFICULTY);
        return [
          { challenge, difficulty: POW_VECTOR_DIFFICULTY, counter, holds: true },
          {
            challenge,
            difficulty: POW_VECTOR_DIFFICULTY,
            counter: String(Number(counter) + 1),
            holds: proofOfWorkHolds(challenge, POW_VECTOR_DIFFICULTY, String(Number(counter) + 1)),
          },
          { challenge, difficulty: POW_VECTOR_DIFFICULTY, counter: `0${counter}`, holds: false },
        ];
      }),
    },
    definition: VECTOR_DEFINITION,
    answers: ANSWER_VECTORS.map((vector) => {
      const result = checkAnswers(VECTOR_DEFINITION, JSON.parse(vector.answers));
      return {
        name: vector.name,
        answers: JSON.parse(vector.answers) as unknown,
        errors: result.ok ? [] : result.errors,
        ...(result.ok ? { kept: result.answers } : {}),
      };
    }),
    seededAbstractDefinition: buildDefinition('abstract', {}),
  };
}
