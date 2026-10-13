import { inspect } from 'node:util';
import { Secret } from './secret';

describe('Secret', () => {
  const secret = new Secret('canary-3f9a1c');

  it('hands the value out only through reveal()', () => {
    expect(secret.reveal()).toBe('canary-3f9a1c');
  });

  it.each([
    ['String()', () => String(secret)],
    ['string concatenation', () => 'value: ' + secret.toString()],
    ['JSON.stringify', () => JSON.stringify({ secret })],
    ['util.inspect', () => inspect(secret)],
    ['util.inspect of a parent object', () => inspect({ nested: { secret } }, { depth: 5 })],
    ['Object.entries', () => JSON.stringify(Object.entries(secret))],
  ])('does not show the value through %s', (_name, render) => {
    expect(render()).not.toContain('canary-3f9a1c');
  });
});
