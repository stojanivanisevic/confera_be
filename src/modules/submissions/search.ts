/**
 * The search of the submissions table (M4-BE-04, FR-SUB-03): "Zivkovic" finds "Živković"
 * and the reverse, "Djordjevic" finds "Đorđević", a query in Serbian Cyrillic finds the
 * Latin spelling. Text and query are folded the same way and compared as plain text:
 *
 * - NFKC, lower case;
 * - Serbian Cyrillic to Latin letters (љ lj, њ nj, џ dž, ђ đ, ћ ć ...);
 * - đ to dj (the spelling Serbian uses without diacritics), then every other diacritic
 *   dropped (š s, č c, ć c, ž z, dž dz, é e ...), and a few letters that do not decompose
 *   (ł l, ø o, æ ae, ß ss);
 * - a text with đ is indexed twice, with đ as dj and as d (Q4-01): people without a Serbian
 *   keyboard type "Dordevic" as often as "Djordjevic", and both find "Đorđević". A query is
 *   folded with dj, so "Đorđević" typed with its letters finds both forms. A text written
 *   with a plain "dj" (Djurić) is found by "dj" only: nothing says that it was a đ;
 * - anything that is not a letter, a digit, `@`, `.` or `-` becomes a space.
 *
 * The folded text of a submission is its column `search_text`, written with every submit
 * and correction; the migration of 0.4.0 filled the rows of 0.3.0 with the same rules.
 * A query is cut into terms, and each term must occur (AND). A term never holds a
 * character that LIKE reads as a wildcard.
 */
const CYRILLIC: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  ђ: 'đ',
  е: 'e',
  ж: 'ž',
  з: 'z',
  и: 'i',
  ј: 'j',
  к: 'k',
  л: 'l',
  љ: 'lj',
  м: 'm',
  н: 'n',
  њ: 'nj',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  ћ: 'ć',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'č',
  џ: 'dž',
  ш: 'š',
};

const OTHER: Readonly<Record<string, string>> = { ł: 'l', ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss' };

/** The longest query that is searched; the rest is ignored. */
export const MAX_QUERY_LENGTH = 200;
/** The most terms of one query. */
export const MAX_TERMS = 8;

/** Folds a text; `dj` is what đ becomes (dj by default, d for the second form of the index). */
export function fold(text: string, dj: 'dj' | 'd' = 'dj'): string {
  const lower = text.normalize('NFKC').toLowerCase();
  let latin = '';
  for (const character of lower) {
    latin += CYRILLIC[character] ?? OTHER[character] ?? character;
  }
  return latin
    .replace(/đ/gu, dj)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9@.-]+/gu, ' ')
    .trim();
}

export interface SearchableAuthor {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly institution: string | null;
}

/** The text a submission is found by: reference, title, and every author. */
export function searchTextOf(
  reference: string,
  title: string | null,
  authors: readonly SearchableAuthor[],
): string {
  const parts = [
    reference,
    title ?? '',
    ...authors.map((author) =>
      [author.firstName, author.lastName, author.email, author.institution ?? ''].join(' '),
    ),
  ];
  // The bar keeps the parts apart: a folded term never holds one, so none matches across two.
  // A part with đ follows with its second form, đ as d (Q4-01).
  return parts
    .flatMap((part) => {
      const folded = fold(part).replace(/\s+/gu, ' ');
      const plain = fold(part, 'd').replace(/\s+/gu, ' ');
      return plain === folded ? [folded] : [folded, plain];
    })
    .join(' | ');
}

/** The terms of a query, folded; none when the query holds nothing to search for. */
export function searchTerms(query: string): string[] {
  const folded = fold(query.slice(0, MAX_QUERY_LENGTH));
  const terms = folded.split(' ').filter((term) => term !== '');
  return [...new Set(terms)].slice(0, MAX_TERMS);
}
