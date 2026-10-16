import { isMailAddress } from '../../src/common/validation/mail-address';
import { runNode } from '../support/run-node';

/**
 * E2-14: the scripts (the first-admin command) use the address rule of the application.
 * Their copy, scripts/lib/mail-address.mjs, gives the same answer for every address here.
 */
const ADDRESSES = [
  'ana.admin@prva.example.test',
  'a+b@sub.example.test',
  "o'neil@example.test",
  'x@xn--80ak6aa92e.test',
  'ana..admin@prva.example.test',
  'ana\\admin@prva.example.test',
  'ana(admin)@prva.example.test',
  'šima.admin@prva.example.test',
  '.ana@prva.example.test',
  'ana.@prva.example.test',
  'two@example.test, three@example.test',
  'Mila <mila@example.test>',
  'mila@example.test\r\nBcc: x@example.test',
  'a\u0000b@example.test',
  `${'a'.repeat(65)}@example.test`,
  `a@${'b'.repeat(250)}.test`,
  'no-at.example.test',
  'a@b@example.test',
  'a@localhost',
  'a@example.t',
  'a@-example.test',
  '',
];

describe('the address rule of the scripts (E2-14)', () => {
  it('is the rule of the application', async () => {
    const program = `
      import { isMailAddress } from './scripts/lib/mail-address.mjs';
      const addresses = JSON.parse(process.argv[1]);
      process.stdout.write(JSON.stringify(addresses.map((address) => isMailAddress(address))));
    `;
    const run = await runNode([
      '--input-type=module',
      '--eval',
      program,
      JSON.stringify(ADDRESSES),
    ]);
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(ADDRESSES.map((address) => isMailAddress(address)));
    expect(ADDRESSES.filter((address) => isMailAddress(address)).length).toBe(4);
  });
});
