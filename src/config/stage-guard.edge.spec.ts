import { type ConfigProblem, parseEnvironment } from './config';
import { validEnvironment, validProductionEnvironment } from './testing/valid-environment';

/**
 * Edge cases of the STAGE guard found by the edge-case hunter (M1-REV-01).
 *
 * ADR-24: "Non-production stages run only on the developer's machine." The disposition of
 * SEC-A-03 in the register says the same in three words: "non-production only on
 * loopback". The guard checks the two configured ORIGINS, but not the address the API
 * LISTENS on, which is what decides who can reach it. With STAGE=dev and
 * LISTEN_HOST=0.0.0.0 on a server, the origins can stay `http://localhost:3001` and
 * `http://127.0.0.1:3001` and the guard is satisfied; anyone on the network then reaches
 * the admin surface by sending `Host: localhost` (the host check compares a header the
 * client writes), together with every development convenience of that stage.
 */

type Env = Record<string, string | undefined>;

function problemsOf(env: Env): readonly ConfigProblem[] {
  const result = parseEnvironment(env);
  return result.ok ? [] : result.problems;
}

const refused = (env: Env): string[] => problemsOf(env).map((problem) => problem.variable);

describe('edge cases of the STAGE guard (M1-REV-01)', () => {
  describe.each(['local', 'dev', 'test'])(
    'STAGE=%s listens on the developer machine only (ADR-24, SEC-A-03)',
    (stage) => {
      const onDeveloperMachine = (listenHost: string): Env =>
        validEnvironment({
          STAGE: stage,
          ADMIN_ORIGIN: 'http://localhost:3001',
          PUBLIC_ORIGIN: 'http://127.0.0.1:3001',
          LISTEN_HOST: listenHost,
        });

      it.each([
        ['every IPv4 address', '0.0.0.0'],
        ['every IPv6 address', '::'],
        ['an address of the local network', '192.168.1.20'],
        ['a private address of a server', '10.0.0.5'],
        ['a public host name', 'confera.example.org'],
      ])('refuses LISTEN_HOST set to %s', (_what, listenHost) => {
        expect(refused(onDeveloperMachine(listenHost))).toEqual(['LISTEN_HOST']);
      });

      it.each(['127.0.0.1', '127.0.0.2', '::1', 'localhost'])(
        'accepts the loopback address %s',
        (listenHost) => {
          expect(problemsOf(onDeveloperMachine(listenHost))).toEqual([]);
        },
      );
    },
  );

  it('leaves prod alone: inside its container it listens on every address', () => {
    expect(problemsOf(validProductionEnvironment({ LISTEN_HOST: '0.0.0.0' }))).toEqual([]);
  });
});
