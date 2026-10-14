import type { PasswordContext, PasswordRuleId } from '../../access/password-rules';

/**
 * The shared vectors of the password rule set (ADR-03, G2-25, ST-62). They are exported with
 * the rule set (contracts/password-rules.json); the server's rules and the browser's
 * checklist must both give, for each vector, the four results written here.
 *
 * Every person here is invented and lives on example.test (NFR-PRIV-05). `candidate` and
 * `repeat` are the two entries of the form.
 */
export interface PasswordVector {
  readonly name: string;
  readonly candidate: string;
  readonly repeat: string;
  readonly context: PasswordContext;
  readonly met: Readonly<Record<PasswordRuleId, boolean>>;
}

const ZIVANA: PasswordContext = {
  email: 'zivana.djordjevic@a.example.test',
  displayName: 'Živana Đorđević',
  organisationName: 'Udruženje za probe A (izmišljeno)',
};

const ALL_MET = { length: true, not_common: true, not_personal: true, match: true } as const;

/** Twelve to 128 characters that meet every other rule: a phrase of eight different parts. */
const PHRASE_128 = Array.from(
  { length: 8 },
  (_unused, index) => `Planina${String(index)}Reka-Sto`,
).join('');

function vector(
  name: string,
  candidate: string,
  met: Partial<Record<PasswordRuleId, boolean>> = {},
  options: { repeat?: string; context?: PasswordContext } = {},
): PasswordVector {
  return {
    name,
    candidate,
    repeat: options.repeat ?? candidate,
    context: options.context ?? ZIVANA,
    met: { ...ALL_MET, ...met },
  };
}

export const PASSWORD_VECTORS: readonly PasswordVector[] = [
  // length
  vector('11 characters are too few', 'Kx9#mPq2!vL', { length: false }),
  vector('12 characters are enough', 'Kx9#mPq2!vLw'),
  vector('128 characters are the most', PHRASE_128),
  vector('129 characters are too many', `${PHRASE_128}x`, { length: false }),
  vector(
    'characters are code points: 11 of them, although JavaScript counts 13 units',
    'Ruža\u{1F339}Tri\u{1F339}Pe',
    { length: false },
  ),
  vector(
    'characters are counted in NFC: an accent typed as a mark does not count twice',
    'KaféPárk12x',
    { length: false },
  ),
  vector('Serbian letters count once each', 'Šuma-čeka-ćup', {}),
  // not_common
  vector('a common password with a year and a sign', 'Password2026!', { not_common: false }),
  vector('a common password after digits', '2026password!!', { not_common: false }),
  vector('a common password written with an at sign and a zero', 'P@ssw0rd2026', {
    not_common: false,
  }),
  vector('a line of the keyboard with digits', 'qwertyuiop12', { not_common: false }),
  vector('a part of a line of the keyboard', 'asdfghjklzxc', { not_common: false }),
  vector('a German keyboard line', 'QWERTZuiopas', { not_common: false }),
  vector('the alphabet backwards', 'zyxwvutsrqpo', { not_common: false }),
  vector('counting', '123456789012', { not_common: false }),
  vector('one character', 'aaaaaaaaaaaa', { not_common: false }),
  vector('two characters', 'abababababab', { not_common: false }),
  vector('a short unit repeated', 'abcabcabcabc', { not_common: false }),
  vector('a common word repeated', 'secretsecret', { not_common: false }),
  vector('a Serbian common password', 'lozinka12345', { not_common: false }),
  vector('a common Serbian club with digits', 'CrvenaZvezda1945', { not_common: false }),
  vector('a sentence is not common', 'Volim te, Srbijo!', {}),
  vector('four words are not common', 'korektan konj baterija spajalica', {}),
  vector('the empty password meets nothing but match', '', {
    length: false,
    not_common: false,
  }),
  // not_personal
  vector('the given name', 'Zivana!Sunce42', { not_personal: false }),
  vector('the given name with its letter ž', 'Živana-Sunce42', { not_personal: false }),
  vector('the family name as the email writes it (dj)', 'Djordjevic+Mesec1', {
    not_personal: false,
  }),
  vector('the family name with đ written as d', 'MostDordevic99', { not_personal: false }),
  vector('a word of the organisation', 'Probe-za-Sunce-77', { not_personal: false }),
  vector('another word of the organisation', 'Izmisljeno2026x', { not_personal: false }),
  vector('words shorter than four characters are not looked for', 'Za-A-Sunce-Mesec', {}),
  vector(
    'a name in Cyrillic, in Cyrillic',
    'Живана-Сунце-42',
    { not_personal: false },
    { context: { ...ZIVANA, displayName: 'Живана Ђорђевић' } },
  ),
  vector(
    'a name in Cyrillic is not found in a Latin password (no transliteration)',
    'Zivana-Sunce-42',
    {},
    {
      context: {
        email: 'z.dj@a.example.test',
        displayName: 'Живана Ђорђевић',
        organisationName: 'Удружење',
      },
    },
  ),
  vector(
    'the name of a conference',
    'MojaSava-Reka-7',
    { not_personal: false },
    { context: { ...ZIVANA, conferenceNames: ['Sava Conference 2026'] } },
  ),
  vector('without a context nothing is personal', 'Zivana!Sunce42', {}, { context: {} }),
  // match
  vector(
    'two entries that differ',
    'Planina-Reka-Sto-7',
    { match: false },
    {
      repeat: 'Planina-Reka-Sto-8',
    },
  ),
  vector(
    'two entries that look alike are compared as typed',
    'Kafé-Pàrk-Sto-12',
    { match: false },
    { repeat: 'Kafé-Pàrk-Sto-12' },
  ),
];
