import { PrismaPg } from '@prisma/adapter-pg';
import { type Prisma, PrismaClient } from '../../generated/prisma/client';

/**
 * The tenant client (ADR-05): a Prisma client in which every operation runs in a
 * transaction that first sets the organisation for row-level security.
 *
 *   SELECT set_config('app.org_id', <organisation>, true)   -- local to the transaction
 *   <the operation>
 *
 * The setting ends with the transaction, so a pooled connection carries nothing over to
 * whoever uses it next. The policies of the database do the filtering; this client only
 * makes sure that no statement runs without an organisation.
 */

/** Receives every statement when the development convenience DEV_LOG_QUERIES is on. */
export type QueryObserver = (event: {
  readonly query: string;
  readonly durationMs: number;
}) => void;

export interface ClientOptions {
  /** Largest number of connections in the pool. */
  readonly poolSize?: number;
  readonly onQuery?: QueryObserver;
}

/**
 * Every operation is a transaction, so under load operations queue for a connection.
 * maxWait: how long one may wait for a connection before it fails (Prisma's default of
 * 2 s is too short for a burst on a small pool). timeout: how long a transaction may
 * run; the database stops a single statement at 15 s as well (statement_timeout).
 */
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;

/**
 * How long a new connection may take, from the first byte to an authenticated session.
 * A database that accepts the connection and never answers fails here instead of
 * holding the caller for ever (edge case E5 of M1-REV-01).
 */
export const CONNECT_TIMEOUT_MS = 10_000;

/** The start-up role check: connect and query together. Past it the API exits with 77. */
export const START_CHECK_TIMEOUT_MS = 20_000;

/** Readiness answers 503 when the database has not answered within this. */
export const READINESS_TIMEOUT_MS = 5_000;

export class DatabaseTimeout extends Error {
  constructor(
    readonly what: string,
    readonly ms: number,
  ) {
    super(`The database did not answer ${what} within ${String(ms / 1000)} s.`);
    this.name = 'DatabaseTimeout';
  }
}

/**
 * Waits for `work` at most `ms`. A query whose answer never comes is left to finish
 * on its own when the database answers again; the caller goes on. For the paths that must
 * answer in time whatever the database does: the start-up check and readiness.
 */
export function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DatabaseTimeout(what, ms));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/** A plain client for one database role. It has no tenant behaviour of its own. */
export function createBaseClient(
  connectionString: string,
  options: ClientOptions = {},
): PrismaClient {
  const adapter = new PrismaPg({
    connectionString,
    max: options.poolSize ?? 10,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  const { onQuery } = options;
  if (onQuery === undefined) {
    return new PrismaClient({ adapter, transactionOptions: TRANSACTION_OPTIONS });
  }
  const client = new PrismaClient({
    adapter,
    transactionOptions: TRANSACTION_OPTIONS,
    log: [{ emit: 'event', level: 'query' }],
  });
  client.$on('query', (event) => {
    // The statement text with placeholders; never the parameter values.
    onQuery({ query: event.query, durationMs: event.duration });
  });
  return client;
}

function setOrganisation(client: PrismaClient | Prisma.TransactionClient, organisationId: string) {
  return client.$queryRaw`SELECT set_config('app.org_id', ${organisationId}, true)`;
}

/**
 * Wraps a base client so that each single operation, raw queries included, runs with the
 * organisation that `organisationId()` returns at that moment.
 */
export function createTenantClient(base: PrismaClient, organisationId: () => string) {
  return base.$extends({
    name: 'tenant',
    query: {
      async $allOperations({ args, query }) {
        const results = await base.$transaction([
          setOrganisation(base, organisationId()),
          query(args) as Prisma.PrismaPromise<unknown>,
        ]);
        return results[1];
      },
    },
  });
}

export type ExtendedTenantClient = ReturnType<typeof createTenantClient>;

/**
 * What application code gets: models and tagged-template raw queries. The transaction
 * and connection methods are taken away, because a transaction opened on this client
 * would run each of its statements in a transaction of its own. Use
 * `TenantDatabase.transaction()` for several statements that belong together.
 */
export type TenantClient = Omit<
  ExtendedTenantClient,
  '$transaction' | '$connect' | '$disconnect' | '$on' | '$extends'
>;

const WITHHELD = new Set<PropertyKey>([
  '$transaction',
  '$connect',
  '$disconnect',
  '$on',
  '$extends',
]);

export function restrict(client: ExtendedTenantClient): TenantClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (WITHHELD.has(property)) {
        throw new Error(
          `${String(property)} is not available on the tenant client. Use TenantDatabase.transaction().`,
        );
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

/**
 * Several statements in one transaction, all inside the organisation. `tx` is bound by
 * row-level security exactly like the tenant client.
 */
export function tenantTransaction<T>(
  base: PrismaClient,
  organisationId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return base.$transaction(async (tx) => {
    await setOrganisation(tx, organisationId);
    return work(tx);
  });
}
