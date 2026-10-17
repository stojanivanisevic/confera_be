import { z } from 'zod';
import {
  ABSOLUTE_LIMITS,
  AUTHORS_SECTION,
  CATALOGUE,
  type CatalogueField,
  type Condition,
  DEFAULT_AUTHOR_NOTICE,
  DEFAULT_AUTHOR_NOTICE_FROM,
  DEFAULT_FILE_BYTES,
  DEFAULT_MAX_AUTHORS,
  DEFAULT_TEXTS,
  FIELD_KINDS,
  FILE_TYPES,
  type FieldKind,
  type FileType,
  FORM_TYPES,
  type FormType,
  type Localised,
  PATTERNS,
  type PatternName,
  TEXT_KEYS,
  type TextKey,
} from './catalogue';
import type { FormConfiguration } from './configuration';

/**
 * The definition of a form version (ADR-09, ADR-FE-04): what the public form renders and
 * what the rule interpreter checks, in both languages. It is BUILT by the server from the
 * catalogue in code and the admin's configuration (`buildDefinition`), never taken from a
 * browser, and a published one never changes. Its JSON schema is
 * contracts/form-definition.schema.json.
 */
export const DEFINITION_SCHEMA_VERSION = 1;

export interface FieldRules {
  /** Characters (code points) at most. */
  readonly maxLength: number | null;
  /** Words at most (a word is a run of characters between white space). */
  readonly maxWords: number | null;
  /** The name of a pattern of `patterns`. */
  readonly pattern: PatternName | null;
  /** No address, no `www.`, no mail address in the text. */
  readonly noUrl: boolean;
  readonly file: { readonly accept: readonly FileType[]; readonly maxBytes: number } | null;
}

export interface FieldDefinition {
  readonly key: string;
  readonly kind: FieldKind;
  readonly required: boolean;
  readonly label: Localised;
  readonly help: Localised | null;
  readonly options: readonly { readonly value: string; readonly label: Localised }[] | null;
  readonly rules: FieldRules;
  readonly visibleWhen: Condition | null;
  readonly onlyFirstInRepeat: boolean;
  readonly autocomplete: string | null;
}

export interface SectionDefinition {
  readonly key: string;
  readonly label: Localised;
  readonly repeat: {
    readonly min: number;
    readonly max: number;
    readonly itemLabel: Localised;
    readonly addLabel: Localised;
    readonly removeLabel: Localised;
    /** From this block on the notice is shown (the fee of a fourth author); null: never. */
    readonly noticeFrom: number | null;
    readonly notice: Localised | null;
  } | null;
  readonly visibleWhen: Condition | null;
  readonly fields: readonly FieldDefinition[];
}

export interface FormDefinition {
  readonly schemaVersion: typeof DEFINITION_SCHEMA_VERSION;
  readonly type: FormType;
  readonly texts: Readonly<Record<TextKey, Localised>>;
  /** The patterns its fields name, as regular expressions (ECMAScript, `u` flag). */
  readonly patterns: Readonly<Partial<Record<PatternName, string>>>;
  readonly sections: readonly SectionDefinition[];
}

function localised(base: Localised, override: Localised | undefined): Localised {
  return override === undefined ? base : { en: override.en, sr: override.sr };
}

function buildField(
  field: CatalogueField,
  configuration: FormConfiguration,
): FieldDefinition | null {
  const own = configuration.fields?.[field.key];
  const enabled = field.mandatory ? true : (own?.enabled ?? field.enabled);
  if (!enabled) {
    return null;
  }
  const options =
    field.options?.map((option) => ({
      value: option.value,
      label: localised(option.label, own?.options?.[option.value]),
    })) ?? null;
  const file =
    field.kind === 'file' && field.file !== undefined
      ? {
          accept: FILE_TYPES.filter((type) =>
            (own?.file?.accept ?? field.file?.accept ?? []).includes(type),
          ),
          maxBytes: own?.file?.maxBytes ?? DEFAULT_FILE_BYTES,
        }
      : null;
  return {
    key: field.key,
    kind: field.kind,
    required: field.mandatory ? field.required : (own?.required ?? field.required),
    label: localised(field.label, own?.label),
    help:
      own?.help === null
        ? null
        : own?.help !== undefined
          ? localised(own.help, undefined)
          : (field.help ?? null),
    options,
    rules: {
      maxLength:
        field.maxLength === undefined
          ? null
          : Math.min(own?.maxLength ?? field.maxLength.default, field.maxLength.cap),
      maxWords:
        field.maxWords === undefined
          ? null
          : Math.min(own?.maxWords ?? field.maxWords.default, field.maxWords.cap),
      pattern: field.pattern ?? null,
      noUrl: field.noUrl === true,
      file,
    },
    visibleWhen: field.visibleWhen ?? null,
    onlyFirstInRepeat: field.onlyFirstInRepeat === true,
    autocomplete: field.autocomplete ?? null,
  };
}

/**
 * The definition of a form of a type with an admin's configuration over the catalogue. The
 * configuration is checked first (`configurationProblems`); here it is trusted to be valid.
 */
export function buildDefinition(type: FormType, configuration: FormConfiguration): FormDefinition {
  const texts = Object.fromEntries(
    TEXT_KEYS.map((key) => [key, localised(DEFAULT_TEXTS[type][key], configuration.texts?.[key])]),
  ) as Record<TextKey, Localised>;
  const sections = CATALOGUE[type].map((section): SectionDefinition => {
    const fields = section.fields
      .map((field) => buildField(field, configuration))
      .filter((field): field is FieldDefinition => field !== null);
    const label = localised(section.label, configuration.sections?.[section.key]?.label);
    const repeat =
      section.repeat === undefined
        ? null
        : {
            min: 1,
            max:
              section.key === AUTHORS_SECTION
                ? (configuration.maxAuthors ?? DEFAULT_MAX_AUTHORS)
                : DEFAULT_MAX_AUTHORS,
            itemLabel: section.repeat.itemLabel,
            addLabel: section.repeat.addLabel,
            removeLabel: section.repeat.removeLabel,
            noticeFrom:
              configuration.authorNoticeFrom === undefined
                ? DEFAULT_AUTHOR_NOTICE_FROM
                : configuration.authorNoticeFrom,
            notice:
              configuration.authorNotice === undefined
                ? DEFAULT_AUTHOR_NOTICE
                : configuration.authorNotice,
          };
    return {
      key: section.key,
      label,
      repeat,
      visibleWhen: section.visibleWhen ?? null,
      fields,
    };
  });
  const used = new Set(
    sections.flatMap((section) => section.fields.map((field) => field.rules.pattern)),
  );
  const patterns = Object.fromEntries(
    (Object.keys(PATTERNS) as PatternName[])
      .filter((name) => used.has(name))
      .map((name) => [name, PATTERNS[name]]),
  );
  return { schemaVersion: DEFINITION_SCHEMA_VERSION, type, texts, patterns, sections };
}

/** Every field of a definition with its section, in order. */
export function fieldsOf(
  definition: FormDefinition,
): { section: SectionDefinition; field: FieldDefinition }[] {
  return definition.sections.flatMap((section) =>
    section.fields.map((field) => ({ section, field })),
  );
}

/** The file fields of a definition: how many uploads a form token allows (ADR-08). */
export function fileFieldsOf(definition: FormDefinition): FieldDefinition[] {
  return fieldsOf(definition)
    .map(({ field }) => field)
    .filter((field) => field.kind === 'file');
}

// ---------------------------------------------------------------------------
// The schema of a definition, for the contract and for the check of a stored one.
// ---------------------------------------------------------------------------

const localisedSchema = z.strictObject({ en: z.string(), sr: z.string() });
const conditionSchema = z.strictObject({
  field: z.string(),
  in: z.array(z.string()).min(1),
});

export const fieldDefinitionSchema = z.strictObject({
  key: z.string().regex(/^[a-z][A-Za-z]*$/),
  kind: z.enum(FIELD_KINDS),
  required: z.boolean(),
  label: localisedSchema,
  help: localisedSchema.nullable(),
  options: z.array(z.strictObject({ value: z.string(), label: localisedSchema })).nullable(),
  rules: z.strictObject({
    maxLength: z.int().min(1).max(ABSOLUTE_LIMITS.maxLength).nullable(),
    maxWords: z.int().min(1).max(ABSOLUTE_LIMITS.maxWords).nullable(),
    pattern: z.enum(Object.keys(PATTERNS) as [PatternName, ...PatternName[]]).nullable(),
    noUrl: z.boolean(),
    file: z
      .strictObject({
        accept: z.array(z.enum(FILE_TYPES)).min(1),
        maxBytes: z.int().min(1),
      })
      .nullable(),
  }),
  visibleWhen: conditionSchema.nullable(),
  onlyFirstInRepeat: z.boolean(),
  autocomplete: z.string().nullable(),
});

export const formDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(DEFINITION_SCHEMA_VERSION),
  type: z.enum(FORM_TYPES),
  texts: z.strictObject(
    Object.fromEntries(TEXT_KEYS.map((key) => [key, localisedSchema])) as Record<
      TextKey,
      typeof localisedSchema
    >,
  ),
  patterns: z.partialRecord(
    z.enum(Object.keys(PATTERNS) as [PatternName, ...PatternName[]]),
    z.string(),
  ),
  sections: z.array(
    z.strictObject({
      key: z.string(),
      label: localisedSchema,
      repeat: z
        .strictObject({
          min: z.int().min(1),
          max: z.int().min(1).max(ABSOLUTE_LIMITS.maxAuthors),
          itemLabel: localisedSchema,
          addLabel: localisedSchema,
          removeLabel: localisedSchema,
          noticeFrom: z.int().min(1).nullable(),
          notice: localisedSchema.nullable(),
        })
        .nullable(),
      visibleWhen: conditionSchema.nullable(),
      fields: z.array(fieldDefinitionSchema),
    }),
  ),
});

/** A stored definition, checked again when it is read (a row planted past the API is refused). */
export function parseDefinition(value: unknown): FormDefinition {
  return formDefinitionSchema.parse(value);
}
