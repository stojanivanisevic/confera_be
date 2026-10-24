import { fold, searchTerms, searchTextOf } from './search';

/** FR-SUB-03: the search does not care for diacritics, both ways (M4-BE-04). */
describe('the folding of the search', () => {
  it.each([
    ['Živković', 'zivkovic'],
    ['ŠĆEPANOVIĆ', 'scepanovic'],
    ['Đorđe', 'djordje'],
    ['đurđevak', 'djurdjevak'],
    ['Džajić', 'dzajic'],
    ['Čačak, Žabalj', 'cacak zabalj'],
    ['Ђорђе Шћепановић', 'djordje scepanovic'],
    ['Љиљана Његош Џамић', 'ljiljana njegos dzamic'],
    ['Müller-Lüdenscheidt', 'muller-ludenscheidt'],
    ['Łódź', 'lodz'],
    ['ﬁnance', 'finance'],
    ['zivana.djordjevic@autori.example.test', 'zivana.djordjevic@autori.example.test'],
  ])('%s is %s', (text, folded) => {
    expect(fold(text)).toBe(folded);
  });

  it('finds the same text whichever way it is typed', () => {
    const text = searchTextOf('IT27-0001', 'Učenje na daljinu', [
      {
        firstName: 'Živana',
        lastName: 'Đorđević',
        email: 'zivana@autori.example.test',
        institution: 'Univerzitet u Čačku',
      },
    ]);
    for (const query of [
      'Zivana Djordjevic',
      'zivana dordevic',
      'DORDEVIC',
      'živana đorđević',
      'ЂОРЂЕВИЋ',
      'cacku',
      'it27-0001',
      'ucenje',
      'autori.example',
    ]) {
      for (const term of searchTerms(query)) {
        expect({ query, term, found: text.includes(term) }).toEqual({ query, term, found: true });
      }
    }
  });

  it('indexes a text with đ in both forms, đ as dj and as d (Q4-01), and nothing else twice', () => {
    const text = searchTextOf('IT27-0003', 'Učenje', [
      { firstName: 'Đorđe', lastName: 'Anić', email: 'dj@x.example.test', institution: null },
    ]);
    expect(text).toBe('it27-0003 | ucenje | djordje anic dj@x.example.test | dorde anic dj@x.example.test');
    expect(fold('Đorđe', 'd')).toBe('dorde');
    // A plain dj is not a đ: "Djurić" is found by dj only.
    expect(searchTextOf('IT27-0004', null, [
      { firstName: 'Ana', lastName: 'Djurić', email: 'a@x.example.test', institution: null },
    ])).not.toContain('duric');
  });

  it('keeps the parts apart, so that no term spans a title and a name', () => {
    const text = searchTextOf('IT27-0002', 'Mala', [
      { firstName: 'Škola', lastName: 'Ana', email: 'a@x.example.test', institution: null },
    ]);
    expect(text.includes('mala skola')).toBe(false);
  });

  it('gives no term that LIKE reads as a wildcard, and no empty term', () => {
    expect(searchTerms('100% _x_ \\ %')).toEqual(['100', 'x']);
    expect(searchTerms('   ')).toEqual([]);
    expect(searchTerms('a a a b')).toEqual(['a', 'b']);
  });

  it('cuts a long query', () => {
    expect(searchTerms('x '.repeat(500)).length).toBeLessThanOrEqual(8);
    expect(searchTerms('y'.repeat(5000))[0]?.length).toBe(200);
  });
});
