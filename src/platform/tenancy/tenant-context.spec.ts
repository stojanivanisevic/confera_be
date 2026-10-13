import { ClsServiceManager } from 'nestjs-cls';
import { NoOrganisationError, TenantContext } from './tenant-context';

const A = '5a1f0c7e-3b2d-4e6f-8a9b-0c1d2e3f4a5b';
const B = '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('TenantContext', () => {
  const context = new TenantContext(ClsServiceManager.getClsService());

  it('has no organisation outside run()', () => {
    expect(context.organisationId()).toBeUndefined();
    expect(() => context.requireOrganisationId()).toThrow(NoOrganisationError);
  });

  it('sets the organisation for the work and for what it awaits', async () => {
    const seen = await context.run(A, async () => {
      const before = context.requireOrganisationId();
      await pause(2);
      return [before, context.requireOrganisationId()];
    });
    expect(seen).toEqual([A, A]);
  });

  it('ends with the work, also when the work fails', async () => {
    await context.run(A, () => Promise.resolve());
    expect(context.organisationId()).toBeUndefined();
    await expect(context.run(A, () => Promise.reject(new Error('failed')))).rejects.toThrow(
      'failed',
    );
    expect(context.organisationId()).toBeUndefined();
  });

  it('keeps interleaved work of two organisations apart', async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_unused, index) => {
        const mine = index % 2 === 0 ? A : B;
        return context.run(mine, async () => {
          await pause(index % 7);
          const first = context.requireOrganisationId();
          await pause((index * 3) % 5);
          return { mine, first, second: context.requireOrganisationId() };
        });
      }),
    );
    for (const { mine, first, second } of results) {
      expect(first).toBe(mine);
      expect(second).toBe(mine);
    }
  });

  it('stores the id in lower case', async () => {
    expect(
      await context.run(A.toUpperCase(), () => Promise.resolve(context.organisationId())),
    ).toBe(A);
  });

  it.each(['', 'not-a-uuid', "x' OR '1'='1", `${A} `, `${A};`, '5a1f0c7e3b2d4e6f8a9b0c1d2e3f4a5b'])(
    'refuses "%s" as an organisation id',
    async (id) => {
      await expect(context.run(id, () => Promise.resolve())).rejects.toThrow(TypeError);
    },
  );

  it('refuses a change to another organisation from inside one', async () => {
    await expect(context.run(A, () => context.run(B, () => Promise.resolve()))).rejects.toThrow(
      /nested change is not allowed/,
    );
  });

  it('allows the same organisation again, and the outer one is intact afterwards', async () => {
    const seen = await context.run(A, async () => {
      await context.run(A, () => Promise.resolve());
      return context.organisationId();
    });
    expect(seen).toBe(A);
  });
});
