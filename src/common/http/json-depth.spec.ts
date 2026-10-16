import { JSON_MAX_DEPTH, nestingDepth } from './json-depth';

describe('the nesting depth of a JSON body (E2-07)', () => {
  it.each([
    ['{}', 1],
    ['{"a":[1,{"b":2}]}', 3],
    ['{"a":"[[[[{{{{"}', 1],
    ['"text"', 0],
    ['['.repeat(50) + ']'.repeat(50), 50],
  ])('%s has the depth %d', (text, depth) => {
    expect(nestingDepth(JSON.parse(text))).toBe(depth);
  });

  it('stops counting soon after the limit, without recursion', () => {
    const deep = JSON.parse('['.repeat(30_000) + ']'.repeat(30_000)) as unknown;
    expect(nestingDepth(deep)).toBe(JSON_MAX_DEPTH + 1);
  });
});
