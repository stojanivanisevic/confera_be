import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

const ORGANISATION_KEY = 'organisationId';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown when tenant data is asked for and no organisation is set. A programming error. */
export class NoOrganisationError extends Error {
  constructor() {
    super('No organisation is set for this operation.');
    this.name = 'NoOrganisationError';
  }
}

/**
 * The organisation that the current request or job works in (ADR-05).
 *
 * It lives in the request context, next to the trace id. Whoever knows the organisation
 * sets it: the session guard for a signed-in request, a resolver's caller for a public
 * request, the worker for each job. The tenant database client reads it for every
 * statement and hands it to row-level security.
 */
@Injectable()
export class TenantContext {
  constructor(private readonly cls: ClsService) {}

  /**
   * Runs `work` inside the given organisation. The organisation is set for `work` and
   * for everything it awaits, and for nothing else.
   *
   * Changing to another organisation from inside one is refused: a job that spans
   * organisations loops over them, one after another.
   */
  async run<T>(organisationId: string, work: () => Promise<T>): Promise<T> {
    if (!UUID.test(organisationId)) {
      throw new TypeError('An organisation id must be a UUID.');
    }
    const current = this.organisationId();
    if (current !== undefined && current !== organisationId.toLowerCase()) {
      throw new Error('Already inside another organisation; a nested change is not allowed.');
    }
    return this.cls.run({ ifNested: 'inherit' }, async () => {
      this.cls.set(ORGANISATION_KEY, organisationId.toLowerCase());
      return work();
    });
  }

  /**
   * Sets the organisation for the rest of the current request: what the access guard does
   * once it has found the session, since a guard cannot wrap the handler in `run`. Refused
   * outside a request context, and when another organisation is set already.
   */
  enter(organisationId: string): void {
    if (!UUID.test(organisationId)) {
      throw new TypeError('An organisation id must be a UUID.');
    }
    if (!this.cls.isActive()) {
      throw new Error('There is no request context to enter an organisation in.');
    }
    const current = this.organisationId();
    if (current !== undefined && current !== organisationId.toLowerCase()) {
      throw new Error('Already inside another organisation; a nested change is not allowed.');
    }
    this.cls.set(ORGANISATION_KEY, organisationId.toLowerCase());
  }

  organisationId(): string | undefined {
    return this.cls.isActive() ? this.cls.get<string | undefined>(ORGANISATION_KEY) : undefined;
  }

  requireOrganisationId(): string {
    const id = this.organisationId();
    if (id === undefined) {
      throw new NoOrganisationError();
    }
    return id;
  }
}
