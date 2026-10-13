import { compare, formatDrift, serialise } from './files';

/** The drift check of ADR-19: a committed OpenAPI file that differs from the code fails. */
describe('OpenAPI drift check', () => {
  const document = {
    openapi: '3.0.0',
    paths: { '/api/v1/meta': { get: { responses: { '200': { schema: { type: 'string' } } } } } },
  };
  const generated = serialise(document);

  it('serialises with two spaces, LF and one final line break', () => {
    expect(generated.startsWith('{\n  "openapi": "3.0.0",\n')).toBe(true);
    expect(generated.endsWith('}\n')).toBe(true);
    expect(generated).not.toContain('\r');
  });

  it('finds no drift when the committed file equals the generated text', () => {
    expect(compare('openapi.json', generated, generated)).toBeUndefined();
  });

  it('treats a checkout with CRLF line ends as the same document', () => {
    expect(compare('openapi.json', generated, generated.replace(/\n/g, '\r\n'))).toBeUndefined();
  });

  it('reports a missing file', () => {
    expect(compare('openapi.json', generated, undefined)).toEqual({
      file: 'openapi.json',
      reason: 'missing',
    });
  });

  it('reports a changed response type with the first line that differs', () => {
    const committed = serialise({
      ...document,
      paths: { '/api/v1/meta': { get: { responses: { '200': { schema: { type: 'number' } } } } } },
    });
    const drift = compare('openapi.json', generated, committed);
    expect(drift).toEqual(
      expect.objectContaining({
        file: 'openapi.json',
        reason: 'different',
        committed: expect.stringContaining('"number"'),
        generated: expect.stringContaining('"string"'),
      }),
    );
    expect(formatDrift([drift!])).toContain('openapi.json: differs from the code at line');
  });

  it.each([
    ['an added property', (text: string) => text.replace('"paths"', '"extra": 1,\n  "paths"')],
    ['a removed line', (text: string) => text.split('\n').slice(1).join('\n')],
    ['a missing final line break', (text: string) => text.slice(0, -1)],
    ['an extra blank line at the end', (text: string) => `${text}\n`],
    ['other indentation', (text: string) => text.replace(/^ {2}/gm, '    ')],
    ['an empty file', () => ''],
  ])('reports %s', (_name, change) => {
    expect(compare('openapi.json', generated, change(generated))).toEqual(
      expect.objectContaining({ reason: 'different' }),
    );
  });
});
