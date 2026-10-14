import { COMMON_PASSWORDS } from './common-passwords';
import {
  codePointLength,
  foldedForms,
  isCommon,
  isPersonal,
  MAX_LENGTH,
  MIN_LENGTH,
  normalForm,
  passwordProblems,
  personalWords,
  RULE_CODES,
  ruleSet,
} from './password-rules';

/**
 * The parts of the password rule set (ADR-03, G2-25). The vectors, which the web
 * application runs too, are in src/modules/dev-tools/contracts.
 */
describe('password rules', () => {
  describe('the normal and the folded form', () => {
    it('the normal form is NFC, lower case, letters and digits only', () => {
      expect(normalForm('P@ss W0rd-2026!')).toBe('pssw0rd2026');
      expect(normalForm('Kafé')).toBe('kafé');
      expect(normalForm('ŠUMA')).toBe('šuma');
    });

    it('the folded forms write đ as dj and as d, and drop every other accent', () => {
      expect(foldedForms('Đorđević')).toEqual(['djordjevic', 'dordevic']);
      expect(foldedForms('Živana Šćepanović')).toEqual(['zivanascepanovic', 'zivanascepanovic']);
      expect(foldedForms('Ångström')).toEqual(['angstrom', 'angstrom']);
    });

    it('the length counts code points in NFC', () => {
      expect(codePointLength('\u{1F339}')).toBe(1);
      expect(codePointLength('é')).toBe(1);
    });
  });

  describe('not common', () => {
    it.each([
      'password1234',
      'Welcome2026!',
      '1q2w3e4r5t6y',
      'sifrasifra12',
      'Qwertz123456',
      '111111111111',
      '121212121212',
      '123123123123',
    ])('%s is common', (password) => {
      expect(isCommon(password)).toBe(true);
    });

    it.each(['correct horse battery staple', 'Kx9#mPq2!vLw', 'Ljubičasta-Planina-7'])(
      '%s is not',
      (password) => {
        expect(isCommon(password)).toBe(false);
      },
    );

    it('the list is written in the normal form, once each', () => {
      for (const entry of COMMON_PASSWORDS) {
        expect(normalForm(entry)).toBe(entry);
      }
      expect(new Set(COMMON_PASSWORDS).size).toBe(COMMON_PASSWORDS.length);
    });
  });

  describe('not personal', () => {
    const context = {
      email: 'caslav.scepanovic@a.example.test',
      displayName: 'Časlav Šćepanović',
      organisationName: 'Društvo istraživača (izmišljeno)',
      conferenceNames: ['Ekonomija 2026'],
    };

    it('the words are the runs of letters of at least four characters, folded', () => {
      expect(personalWords(context)).toEqual([
        'caslav',
        'drustvo',
        'ekonomija',
        'istrazivaca',
        'izmisljeno',
        'scepanovic',
      ]);
    });

    it.each(['Caslav-Sunce-77', 'ŠĆEPANOVIĆ!more1', 'drustvo-zeleno-9', 'ekonomija.sunce'])(
      '%s holds a personal word',
      (password) => {
        expect(isPersonal(password, context)).toBe(true);
      },
    );

    it('a year in a name is no word', () => {
      expect(isPersonal('Sunce-2026-Mesec', context)).toBe(false);
    });
  });

  describe('the problems a server names (FR-USR-06: "refused with that rule named")', () => {
    it('one code per rule that is not met, in the order of the checklist', () => {
      expect(passwordProblems('short', 'other', { displayName: 'Mila Petrović' })).toEqual([
        RULE_CODES.length,
        RULE_CODES.match,
      ]);
      expect(
        passwordProblems('Petrovic-2026-xyz', 'Petrovic-2026-xyz', {
          displayName: 'Mila Petrović',
        }),
      ).toEqual([RULE_CODES.not_personal]);
      expect(passwordProblems('Password2026!', 'Password2026!', {})).toEqual([
        RULE_CODES.not_common,
      ]);
      expect(passwordProblems('x'.repeat(MAX_LENGTH + 1), 'x'.repeat(MAX_LENGTH + 1), {})).toEqual([
        RULE_CODES.length,
        RULE_CODES.not_common,
      ]);
    });

    it('the codes are those of the export', () => {
      expect(ruleSet().lines.map(({ code }) => code)).toEqual(Object.values(RULE_CODES));
      expect(ruleSet().lines[0]).toEqual(
        expect.objectContaining({ minimum: MIN_LENGTH, maximum: MAX_LENGTH }),
      );
    });
  });
});
