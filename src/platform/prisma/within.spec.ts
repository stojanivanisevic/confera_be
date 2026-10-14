import { DatabaseTimeout, within } from './tenant-client';

/** The bounded wait of the start-up check and readiness (edge case E5 of M1-REV-01). */
describe('within', () => {
  it('gives the answer when it comes in time', async () => {
    await expect(within(Promise.resolve(7), 1000, 'a query')).resolves.toBe(7);
  });

  it('passes the error of the work on', async () => {
    await expect(within(Promise.reject(new Error('refused')), 1000, 'a query')).rejects.toThrow(
      'refused',
    );
  });

  it('stops waiting for an answer that never comes, and says what it waited for', async () => {
    const never = new Promise<number>(() => undefined);
    const started = Date.now();
    await expect(within(never, 50, 'the readiness check')).rejects.toThrow(DatabaseTimeout);
    await expect(within(never, 50, 'the readiness check')).rejects.toThrow(
      'The database did not answer the readiness check within 0.05 s.',
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
