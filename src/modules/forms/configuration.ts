import { z } from 'zod';
import {
  ABSOLUTE_LIMITS,
  CATALOGUE,
  catalogueFields,
  FILE_TYPES,
  type FileType,
  type FormType,
  LABEL_LIMITS,
  type Localised,
  MAX_FILE_BYTES,
  TEXT_KEYS,
  TEXT_LIMITS,
  type TextKey,
} from './catalogue';
import { safeTextProblem } from './safe-text';

/**
 * The configuration of a form (FR-FORM-02): what an admin sets over the catalogue, and the
 * draft of a form. Everything is optional; what is left out keeps the catalogue's default.
 * In the MVP "configure" means: switch optional fields on or off, edit labels, help texts and
 * options in both languages, set required, word limits, file types and size limits, the
 * texts of the form (title, intro, submit, thank-you, closed, consent), the most authors and
 * the notice from the fourth one. Its JSON schema is contracts/form-configuration.schema.json.
 */
export interface FieldConfiguration {
  readonly enabled?: boolean;
  readonly required?: boolean;
  readonly label?: Localised;
  /** null removes the catalogue's help text. */
  readonly help?: Localised | null;
  /** New labels of the catalogue's options, by option value. */
  readonly options?: Readonly<Record<string, Localised>>;
  readonly maxLength?: number;
  readonly maxWords?: number;
  readonly file?: { readonly accept?: readonly FileType[]; readonly maxBytes?: number };
}

export interface FormConfiguration {
  readonly texts?: Readonly<Partial<Record<TextKey, Localised>>>;
  /** The most authors a submission may have (D7): 1 to 50, default 10. */
  readonly maxAuthors?: number;
  /** From which author on the notice is shown; null: never. Default 4. */
  readonly authorNoticeFrom?: number | null;
  readonly authorNotice?: Localised | null;
  readonly sections?: Readonly<Record<string, { readonly label?: Localised }>>;
  readonly fields?: Readonly<Record<string, FieldConfiguration>>;
}

/** A refusal of a configuration: where, and which rule. */
export interface ConfigurationProblem {
  readonly path: string;
  readonly code: string;
}

const localised = (max: number) =>
  z.strictObject({ en: z.string().min(1).max(max), sr: z.string().max(max) });

const fieldConfigurationSchema = z.strictObject({
  enabled: z.boolean().optional(),
  required: z.boolean().optional(),
  label: localised(LABEL_LIMITS.label).optional(),
  help: localised(LABEL_LIMITS.help).nullable().optional(),
  options: z.record(z.string().max(40), localised(LABEL_LIMITS.option)).optional(),
  maxLength: z.int().min(1).max(ABSOLUTE_LIMITS.maxLength).optional(),
  maxWords: z.int().min(1).max(ABSOLUTE_LIMITS.maxWords).optional(),
  file: z
    .strictObject({
      accept: z.array(z.enum(FILE_TYPES)).min(1).max(FILE_TYPES.length).optional(),
      maxBytes: z.int().min(1).max(MAX_FILE_BYTES).optional(),
    })
    .optional(),
});

/** The schema of a configuration of a form of a type: keys outside the catalogue are refused. */
export function configurationSchema(type: FormType) {
  const fieldKeys = [...catalogueFields(type).keys()] as [string, ...string[]];
  const sectionKeys = CATALOGUE[type].map((section) => section.key) as [string, ...string[]];
  return z.strictObject({
    texts: z
      .partialRecord(z.enum(TEXT_KEYS), localised(Math.max(...Object.values(TEXT_LIMITS))))
      .optional(),
    maxAuthors: z.int().min(1).max(ABSOLUTE_LIMITS.maxAuthors).optional(),
    authorNoticeFrom: z.int().min(2).max(ABSOLUTE_LIMITS.maxAuthors).nullable().optional(),
    authorNotice: localised(LABEL_LIMITS.notice).nullable().optional(),
    sections: z
      .partialRecord(
        z.enum(sectionKeys),
        z.strictObject({ label: localised(LABEL_LIMITS.label).optional() }),
      )
      .optional(),
    fields: z.partialRecord(z.enum(fieldKeys), fieldConfigurationSchema).optional(),
  });
}

function zodProblems(error: z.ZodError): ConfigurationProblem[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    code:
      issue.code === 'unrecognized_keys'
        ? 'unknownKey'
        : issue.code === 'too_big'
          ? 'tooBig'
          : issue.code === 'too_small'
            ? 'tooSmall'
            : issue.code === 'invalid_value' || issue.code === 'invalid_key'
              ? 'notAllowed'
              : 'invalid',
  }));
}

function textProblems(path: string, text: Localised, max: number, multiline: boolean) {
  const problems: ConfigurationProblem[] = [];
  for (const language of ['en', 'sr'] as const) {
    const problem = safeTextProblem(text[language], max, {
      required: language === 'en',
      multiline,
    });
    if (problem !== null) {
      problems.push({ path: `${path}.${language}`, code: problem });
    }
  }
  return problems;
}

/**
 * Checks a configuration of a form of a type, and gives it back typed, or the list of what
 * is wrong with it. Besides the shape: a mandatory field cannot be switched off or made
 * optional; a limit beyond the catalogue's cap, an option the field does not have, a word
 * limit or a file rule on a field that has none, and a file type the field may not accept
 * are refused; every text is plain text with the safe link syntax (safe-text.ts).
 */
export function checkConfiguration(
  type: FormType,
  input: unknown,
):
  { ok: true; configuration: FormConfiguration } | { ok: false; problems: ConfigurationProblem[] } {
  const parsed = configurationSchema(type).safeParse(input);
  if (!parsed.success) {
    return { ok: false, problems: zodProblems(parsed.error) };
  }
  const configuration = parsed.data as FormConfiguration;
  const problems: ConfigurationProblem[] = [];
  const catalogue = catalogueFields(type);

  for (const [key, text] of Object.entries(configuration.texts ?? {}) as [
    TextKey,
    Localised | undefined,
  ][]) {
    if (text !== undefined) {
      problems.push(
        ...textProblems(
          `texts.${key}`,
          text,
          TEXT_LIMITS[key],
          key !== 'title' && key !== 'submit',
        ),
      );
    }
  }
  if (configuration.authorNotice !== undefined && configuration.authorNotice !== null) {
    problems.push(
      ...textProblems('authorNotice', configuration.authorNotice, LABEL_LIMITS.notice, false),
    );
  }
  for (const [key, section] of Object.entries(configuration.sections ?? {}) as [
    string,
    { label?: Localised } | undefined,
  ][]) {
    if (section?.label !== undefined) {
      problems.push(
        ...textProblems(`sections.${key}.label`, section.label, LABEL_LIMITS.label, false),
      );
    }
  }
  for (const [key, own] of Object.entries(configuration.fields ?? {}) as [
    string,
    FieldConfiguration | undefined,
  ][]) {
    const field = catalogue.get(key);
    if (field === undefined || own === undefined) {
      continue;
    }
    const at = (name: string) => `fields.${key}.${name}`;
    if (
      field.mandatory &&
      (own.enabled === false || (own.required !== undefined && own.required !== field.required))
    ) {
      problems.push({
        path: at(own.enabled === false ? 'enabled' : 'required'),
        code: 'mandatoryField',
      });
    }
    if (own.label !== undefined) {
      problems.push(...textProblems(at('label'), own.label, LABEL_LIMITS.label, false));
    }
    if (own.help !== undefined && own.help !== null) {
      problems.push(...textProblems(at('help'), own.help, LABEL_LIMITS.help, false));
    }
    for (const [value, label] of Object.entries(own.options ?? {}) as [
      string,
      Localised | undefined,
    ][]) {
      if (!(field.options ?? []).some((option) => option.value === value)) {
        problems.push({ path: at(`options.${value}`), code: 'unknownOption' });
      } else if (label !== undefined) {
        problems.push(...textProblems(at(`options.${value}`), label, LABEL_LIMITS.option, false));
      }
    }
    if (own.maxLength !== undefined) {
      if (field.maxLength === undefined) {
        problems.push({ path: at('maxLength'), code: 'notApplicable' });
      } else if (own.maxLength > field.maxLength.cap) {
        problems.push({ path: at('maxLength'), code: 'aboveCap' });
      }
    }
    if (own.maxWords !== undefined) {
      if (field.maxWords === undefined) {
        problems.push({ path: at('maxWords'), code: 'notApplicable' });
      } else if (own.maxWords > field.maxWords.cap) {
        problems.push({ path: at('maxWords'), code: 'aboveCap' });
      }
    }
    if (own.file !== undefined) {
      if (field.file === undefined) {
        problems.push({ path: at('file'), code: 'notApplicable' });
      } else {
        for (const type of own.file.accept ?? []) {
          if (!field.file.allowed.includes(type)) {
            problems.push({ path: at('file.accept'), code: 'typeNotAllowed' });
          }
        }
      }
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, configuration };
}
