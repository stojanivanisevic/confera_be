/**
 * The field catalogue (ADR-09, FR-FORM-01 to 05): every field a form of a type can have, in
 * code. A form is configured within it (FR-FORM-02) and never beyond it: the `key`, the
 * `kind`, the pattern, the URL rule and the conditions of a field come from here, never from
 * an admin. A free form builder is not in the MVP.
 *
 * The abstract form reproduces the current form of the conference sites (FORMS, read on
 * 2026-10-12): participation, the author blocks, the paper, the biographies file,
 * membership, attendance, publication, the discount claim, the payer with the billing data,
 * the payment method, how the author heard of the conference, comments and the consent.
 */

export const FORM_TYPES = ['abstract'] as const;
export type FormType = (typeof FORM_TYPES)[number];

export const FORM_LANGUAGES = ['en', 'sr'] as const;
export type FormLanguage = (typeof FORM_LANGUAGES)[number];

/** A text in both languages. Serbian may be empty: the form then shows the English one (ADR-FE-05). */
export interface Localised {
  readonly en: string;
  readonly sr: string;
}

/**
 * What a field holds, and so how it is rendered and checked:
 * - `text` one line; `longText` several lines; `email` one address (the address rule);
 * - `choice` one of its options; `yesNo` the options `yes` and `no`;
 * - `file` the id of a file uploaded with the form's token;
 * - `consent` true when the person agrees.
 */
export const FIELD_KINDS = [
  'text',
  'longText',
  'email',
  'choice',
  'yesNo',
  'file',
  'consent',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** The patterns a field may have: only these, never one an admin types (ADR-09). */
export const PATTERNS = {
  /** An ORCID iD: four groups of four digits, the last character may be X. */
  orcid: '^[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9X]$',
  /** A telephone number: digits, an optional leading +, spaces, brackets, dots, slashes and hyphens. */
  phone: '^\\+?[0-9][0-9 ()./-]{4,28}[0-9]$',
  /** A tax number (PIB and its kind in the region): letters and digits, with spaces, dots, slashes or hyphens. */
  taxNumber: '^[A-Za-z0-9][A-Za-z0-9 ./-]{2,28}[A-Za-z0-9]$',
  /** A registration number (matični broj and its kind): as a tax number. */
  registrationNumber: '^[A-Za-z0-9][A-Za-z0-9 ./-]{2,28}[A-Za-z0-9]$',
} as const;
export type PatternName = keyof typeof PATTERNS;

/** The file types a file field may accept, detected from the content (ADR-10). */
export const FILE_TYPES = ['pdf', 'docx', 'doc', 'jpeg', 'png'] as const;
export type FileType = (typeof FILE_TYPES)[number];

/** FR-FILE-01: the default size limit of a file field, 20 MB. */
export const DEFAULT_FILE_BYTES = 20 * 1024 * 1024;
/** The largest a file field may be configured to take. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Stated maxima (ADR-08, ST-41), whatever a form says: no string longer, no more authors.
 * The JSON body of a submit is capped by the API (64 KB).
 */
export const ABSOLUTE_LIMITS = {
  /** Characters (code points) of any one value. */
  maxLength: 20_000,
  /** Authors of one submission. */
  maxAuthors: 50,
  /** Words of a long text. */
  maxWords: 5_000,
} as const;

/** The default number of authors a form takes (owner decision D7: configurable, 10). */
export const DEFAULT_MAX_AUTHORS = 10;

/** A condition: the field shows (or a section shows) when another field has one of these values. */
export interface Condition {
  readonly field: string;
  readonly in: readonly string[];
}

export interface CatalogueOption {
  readonly value: string;
  readonly label: Localised;
}

export interface CatalogueField {
  readonly key: string;
  readonly kind: FieldKind;
  /** A mandatory field cannot be switched off, and its "required" cannot be changed. */
  readonly mandatory: boolean;
  /** Whether the field is required by default (an admin may change it unless mandatory). */
  readonly required: boolean;
  /** Whether the field is on by default (an optional field may be switched on and off). */
  readonly enabled: boolean;
  readonly label: Localised;
  readonly help?: Localised;
  readonly options?: readonly CatalogueOption[];
  /** The default maximum length in characters, and the most an admin may set. */
  readonly maxLength?: { readonly default: number; readonly cap: number };
  /** The default word limit of a long text, when it has one. */
  readonly maxWords?: { readonly default: number; readonly cap: number };
  readonly pattern?: PatternName;
  /** Refuses URLs and mail addresses in the text (ADR-08, item 5): names, titles, institutions. */
  readonly noUrl?: boolean;
  /** For a file field: the types it may accept, and those it accepts by default. */
  readonly file?: { readonly allowed: readonly FileType[]; readonly accept: readonly FileType[] };
  readonly visibleWhen?: Condition;
  /** In a repeating section: only its first block has the field (the first author's phone). */
  readonly onlyFirstInRepeat?: boolean;
  /** The browser's autofill hint, for the first block of a repeating section only. */
  readonly autocomplete?: string;
}

export interface CatalogueSection {
  readonly key: string;
  readonly label: Localised;
  readonly repeat?: {
    readonly itemLabel: Localised;
    readonly addLabel: Localised;
    readonly removeLabel: Localised;
  };
  readonly visibleWhen?: Condition;
  readonly fields: readonly CatalogueField[];
}

/** The texts of a form an admin edits (FR-FORM-02), plain text with one safe link syntax (safe-text.ts). */
export const TEXT_KEYS = ['title', 'intro', 'submit', 'thankYou', 'closed', 'consent'] as const;
export type TextKey = (typeof TEXT_KEYS)[number];

/** The longest each text may be, in characters. */
export const TEXT_LIMITS: Readonly<Record<TextKey, number>> = {
  title: 200,
  intro: 2_000,
  submit: 40,
  thankYou: 2_000,
  closed: 2_000,
  consent: 2_000,
};

/** The most a label, a help text and an option label may be, in characters. */
export const LABEL_LIMITS = { label: 200, help: 1_000, option: 200, notice: 1_000 } as const;

const YES_NO: readonly CatalogueOption[] = [
  { value: 'yes', label: { en: 'Yes', sr: 'Da' } },
  { value: 'no', label: { en: 'No', sr: 'Ne' } },
];

const name = (key: string, en: string, sr: string, autocomplete: string): CatalogueField => ({
  key,
  kind: 'text',
  mandatory: true,
  required: true,
  enabled: true,
  label: { en, sr },
  maxLength: { default: 100, cap: 100 },
  noUrl: true,
  autocomplete,
});

const WITH_PAPER: Condition = { field: 'participationType', in: ['with_paper'] };
const EMPLOYER: Condition = { field: 'payer', in: ['employer'] };

/** The sections and fields of the abstract form, in the order they are shown. */
const ABSTRACT: readonly CatalogueSection[] = [
  {
    key: 'participation',
    label: { en: 'Participation', sr: 'Učešće' },
    fields: [
      {
        key: 'participationType',
        kind: 'choice',
        mandatory: true,
        required: true,
        enabled: true,
        label: { en: 'How do you take part?', sr: 'Kako učestvujete?' },
        options: [
          {
            value: 'with_paper',
            label: { en: 'With an abstract and a paper', sr: 'Sa apstraktom i radom' },
          },
          { value: 'without_paper', label: { en: 'Without a paper', sr: 'Bez rada' } },
        ],
      },
    ],
  },
  {
    key: 'authors',
    label: { en: 'Authors', sr: 'Autori' },
    repeat: {
      itemLabel: { en: 'Author {n}', sr: 'Autor {n}' },
      addLabel: { en: 'Add an author', sr: 'Dodaj autora' },
      removeLabel: { en: 'Remove author {n}', sr: 'Ukloni autora {n}' },
    },
    fields: [
      name('firstName', 'First name', 'Ime', 'given-name'),
      name('lastName', 'Last name', 'Prezime', 'family-name'),
      {
        key: 'institution',
        kind: 'text',
        mandatory: false,
        required: true,
        enabled: true,
        label: { en: 'Institution', sr: 'Institucija' },
        maxLength: { default: 300, cap: 300 },
        noUrl: true,
        autocomplete: 'organization',
      },
      {
        key: 'institutionAddress',
        kind: 'text',
        mandatory: false,
        required: false,
        enabled: true,
        label: { en: 'Address of the institution', sr: 'Adresa institucije' },
        maxLength: { default: 300, cap: 300 },
      },
      {
        key: 'orcid',
        kind: 'text',
        mandatory: false,
        required: false,
        enabled: true,
        label: { en: 'ORCID iD', sr: 'ORCID iD' },
        help: { en: 'For example 0000-0002-1825-0097', sr: 'Na primer 0000-0002-1825-0097' },
        maxLength: { default: 19, cap: 19 },
        pattern: 'orcid',
      },
      {
        key: 'email',
        kind: 'email',
        mandatory: true,
        required: true,
        enabled: true,
        label: { en: 'Email address', sr: 'Adresa e-pošte' },
        maxLength: { default: 254, cap: 254 },
        autocomplete: 'email',
      },
      {
        key: 'phone',
        kind: 'text',
        mandatory: false,
        required: false,
        enabled: true,
        label: { en: 'Phone', sr: 'Telefon' },
        maxLength: { default: 30, cap: 30 },
        pattern: 'phone',
        onlyFirstInRepeat: true,
        autocomplete: 'tel',
      },
    ],
  },
  {
    key: 'paper',
    label: { en: 'Paper', sr: 'Rad' },
    visibleWhen: WITH_PAPER,
    fields: [
      {
        key: 'title',
        kind: 'text',
        mandatory: true,
        required: true,
        enabled: true,
        label: { en: 'Title', sr: 'Naslov' },
        maxLength: { default: 300, cap: 500 },
        noUrl: true,
      },
      {
        key: 'abstract',
        kind: 'longText',
        mandatory: true,
        required: true,
        enabled: true,
        label: { en: 'Abstract', sr: 'Apstrakt' },
        maxLength: { default: 10_000, cap: ABSOLUTE_LIMITS.maxLength },
        maxWords: { default: 500, cap: ABSOLUTE_LIMITS.maxWords },
      },
      {
        key: 'keywords',
        kind: 'text',
        mandatory: false,
        required: true,
        enabled: true,
        label: { en: 'Keywords', sr: 'Ključne reči' },
        help: { en: 'Separated by commas', sr: 'Odvojene zarezima' },
        maxLength: { default: 300, cap: 500 },
        noUrl: true,
      },
      {
        key: 'publication',
        kind: 'choice',
        mandatory: false,
        required: true,
        enabled: true,
        label: { en: 'Where should the paper be published?', sr: 'Gde da rad bude objavljen?' },
        options: [
          {
            value: 'proceedings',
            label: { en: 'Proceedings or selected papers', sr: 'Zbornik ili izabrani radovi' },
          },
          {
            value: 'partner_monograph',
            label: { en: 'A partner monograph', sr: 'Monografija partnera' },
          },
          {
            value: 'partner_journals',
            label: { en: 'The partner journals', sr: 'Časopisi partnera' },
          },
          {
            value: 'abstract_only',
            label: { en: 'The abstract only', sr: 'Samo apstrakt' },
          },
        ],
      },
    ],
  },
  {
    key: 'files',
    label: { en: 'Biographies', sr: 'Biografije' },
    fields: [
      {
        key: 'biographies',
        kind: 'file',
        mandatory: false,
        required: false,
        enabled: true,
        label: {
          en: 'Biographies with photos of all authors',
          sr: 'Biografije sa fotografijama svih autora',
        },
        file: { allowed: ['pdf', 'docx', 'doc'], accept: ['pdf', 'docx', 'doc'] },
      },
    ],
  },
  {
    key: 'presence',
    label: { en: 'Attendance', sr: 'Prisustvo' },
    fields: [
      {
        key: 'membership',
        kind: 'yesNo',
        mandatory: false,
        required: true,
        enabled: true,
        label: {
          en: 'Are you a member of UdEkoM Balkans?',
          sr: 'Da li ste član UdEkoM Balkans?',
        },
        options: YES_NO,
      },
      {
        key: 'attendance',
        kind: 'choice',
        mandatory: false,
        required: true,
        enabled: true,
        label: { en: 'How will you attend?', sr: 'Kako ćete prisustvovati?' },
        help: {
          en: 'Attendance is not required for publication.',
          sr: 'Prisustvo nije uslov za objavljivanje.',
        },
        options: [
          { value: 'in_person', label: { en: 'In person', sr: 'Uživo' } },
          { value: 'live_online', label: { en: 'Live online', sr: 'Onlajn, uživo' } },
          {
            value: 'prerecorded_video',
            label: {
              en: 'A prerecorded video (up to 7 minutes)',
              sr: 'Snimljen video (do 7 minuta)',
            },
          },
          {
            value: 'follow_online',
            label: { en: 'Follow online without presenting', sr: 'Pratim onlajn, bez izlaganja' },
          },
          { value: 'not_attending', label: { en: 'Not attending', sr: 'Ne prisustvujem' } },
        ],
      },
    ],
  },
  {
    key: 'billing',
    label: { en: 'Fee and billing', sr: 'Kotizacija i račun' },
    fields: [
      {
        key: 'discountClaim',
        kind: 'yesNo',
        mandatory: true,
        required: true,
        enabled: true,
        label: {
          en: 'Do you claim a discount or a fee waiver?',
          sr: 'Da li tražite popust ili oslobađanje od kotizacije?',
        },
        options: YES_NO,
      },
      {
        key: 'discountReason',
        kind: 'choice',
        mandatory: true,
        required: true,
        enabled: true,
        label: { en: 'On what grounds?', sr: 'Po kom osnovu?' },
        visibleWhen: { field: 'discountClaim', in: ['yes'] },
        options: [
          { value: 'award', label: { en: 'An award', sr: 'Nagrada' } },
          { value: 'peer_reviewer', label: { en: 'Peer reviewer', sr: 'Recenzent' } },
          {
            value: 'partner_institution',
            label: { en: 'A partner institution', sr: 'Partnerska institucija' },
          },
        ],
      },
      {
        key: 'payer',
        kind: 'choice',
        mandatory: true,
        required: true,
        enabled: true,
        label: { en: 'Who pays the fee?', sr: 'Ko plaća kotizaciju?' },
        options: [
          { value: 'individual', label: { en: 'I do', sr: 'Ja' } },
          { value: 'employer', label: { en: 'My employer', sr: 'Moj poslodavac' } },
        ],
      },
      {
        key: 'billingAddress',
        kind: 'text',
        mandatory: false,
        required: true,
        enabled: true,
        label: { en: 'Your address for the invoice', sr: 'Vaša adresa za račun' },
        maxLength: { default: 300, cap: 300 },
        visibleWhen: { field: 'payer', in: ['individual'] },
      },
      {
        key: 'employerName',
        kind: 'text',
        mandatory: true,
        required: true,
        enabled: true,
        label: { en: 'Name of the legal entity', sr: 'Naziv pravnog lica' },
        maxLength: { default: 300, cap: 300 },
        noUrl: true,
        visibleWhen: EMPLOYER,
      },
      {
        key: 'employerAddress',
        kind: 'text',
        mandatory: true,
        required: true,
        enabled: true,
        label: { en: 'Address of the legal entity', sr: 'Adresa pravnog lica' },
        maxLength: { default: 300, cap: 300 },
        visibleWhen: EMPLOYER,
      },
      {
        key: 'employerTaxNumber',
        kind: 'text',
        mandatory: true,
        required: true,
        enabled: true,
        label: { en: 'Tax number (PIB)', sr: 'PIB' },
        maxLength: { default: 30, cap: 30 },
        pattern: 'taxNumber',
        visibleWhen: EMPLOYER,
      },
      {
        key: 'employerRegistrationNumber',
        kind: 'text',
        mandatory: true,
        required: true,
        enabled: true,
        label: { en: 'Registration number', sr: 'Matični broj' },
        maxLength: { default: 30, cap: 30 },
        pattern: 'registrationNumber',
        visibleWhen: EMPLOYER,
      },
      {
        key: 'billingEmail',
        kind: 'email',
        mandatory: true,
        required: true,
        enabled: true,
        label: { en: 'Email address for the invoice', sr: 'Adresa e-pošte za račun' },
        maxLength: { default: 254, cap: 254 },
        visibleWhen: EMPLOYER,
      },
      {
        key: 'paymentMethod',
        kind: 'choice',
        mandatory: false,
        required: true,
        enabled: true,
        label: { en: 'How will you pay?', sr: 'Kako ćete platiti?' },
        options: [
          { value: 'bank_wire', label: { en: 'Bank wire (EUR)', sr: 'Bankovni transfer (EUR)' } },
          { value: 'card', label: { en: 'Card', sr: 'Platna kartica' } },
          { value: 'paypal', label: { en: 'PayPal', sr: 'PayPal' } },
          {
            value: 'rsd_domestic',
            label: { en: 'RSD at a bank in Serbia', sr: 'U dinarima, u banci u Srbiji' },
          },
        ],
      },
    ],
  },
  {
    key: 'other',
    label: { en: 'Other', sr: 'Ostalo' },
    fields: [
      {
        key: 'heardFrom',
        kind: 'text',
        mandatory: false,
        required: false,
        enabled: true,
        label: {
          en: 'Where did you hear about the conference?',
          sr: 'Gde ste čuli za konferenciju?',
        },
        maxLength: { default: 300, cap: 300 },
      },
      {
        key: 'comments',
        kind: 'longText',
        mandatory: false,
        required: false,
        enabled: true,
        label: { en: 'Comments', sr: 'Napomene' },
        maxLength: { default: 2_000, cap: 5_000 },
      },
    ],
  },
  {
    key: 'agreement',
    label: { en: 'Consent', sr: 'Saglasnost' },
    fields: [
      {
        key: 'consent',
        kind: 'consent',
        mandatory: true,
        required: true,
        enabled: true,
        // The label of the consent is the form's `consent` text, with its links.
        label: { en: 'I agree', sr: 'Saglasan/na sam' },
      },
    ],
  },
];

/** The default texts of the abstract form (FR-FORM-02: an admin edits them). */
export const DEFAULT_TEXTS: Readonly<Record<FormType, Readonly<Record<TextKey, Localised>>>> = {
  abstract: {
    title: { en: 'Abstract submission', sr: 'Prijava apstrakta' },
    intro: {
      en: 'Fields marked with * are required.',
      sr: 'Polja označena zvezdicom (*) su obavezna.',
    },
    submit: { en: 'Send', sr: 'Pošalji' },
    thankYou: {
      en: 'Thank you. Your submission has been received, and a confirmation with its reference is on its way to your email address.',
      sr: 'Hvala. Vaša prijava je primljena, a potvrda sa brojem prijave stiže na Vašu adresu e-pošte.',
    },
    closed: {
      en: 'Submissions for this conference are closed.',
      sr: 'Prijave za ovu konferenciju su zatvorene.',
    },
    consent: {
      en: 'I agree that the data in this form, mine and that of my co-authors, is processed for this conference as the [privacy notice](privacy) describes, and I accept the [terms of publication](terms).',
      sr: 'Saglasan/na sam da se podaci iz ovog obrasca, moji i podaci mojih koautora, obrađuju za ovu konferenciju kako to opisuje [obaveštenje o privatnosti](privacy), i prihvatam [uslove objavljivanja](terms).',
    },
  },
};

/** The notice shown from the fourth author on (FR-FORM-03, FEES: each co-author beyond three costs more). */
export const DEFAULT_AUTHOR_NOTICE: Localised = {
  en: 'Each author beyond the third adds to the fee.',
  sr: 'Svaki autor posle trećeg povećava kotizaciju.',
};
export const DEFAULT_AUTHOR_NOTICE_FROM = 4;

export const CATALOGUE: Readonly<Record<FormType, readonly CatalogueSection[]>> = {
  abstract: ABSTRACT,
};

/** The repeating section of authors: its answers are a list of blocks (FR-FORM-03). */
export const AUTHORS_SECTION = 'authors';

/** Every field of a type by its key. */
export function catalogueFields(type: FormType): ReadonlyMap<string, CatalogueField> {
  return new Map(CATALOGUE[type].flatMap((section) => section.fields.map((f) => [f.key, f])));
}

export function isFormType(value: string): value is FormType {
  return (FORM_TYPES as readonly string[]).includes(value);
}
