import { ApiSchema } from '@nestjs/swagger';

/** One refused field of an input. */
@ApiSchema({ name: 'FieldError' })
export class FieldErrorDto {
  /** Path of the field in the request, for example `authors.0.email`. */
  path!: string;

  /** Stable code of the rule that failed, for example `isEmail`. Never the value. */
  code!: string;
}

/**
 * The one error format of the API (ADR-19), sent as `application/problem+json`.
 *
 * An unknown error carries `code` and `traceId` only: no status text, no stack, no SQL
 * and no path. The trace id finds the full error in the server log.
 */
@ApiSchema({ name: 'Problem' })
export class ProblemDto {
  /** Stable, machine-readable code, for example `not_found` or `validation_failed`. */
  code!: string;

  /** Identifies this request in the server log. */
  traceId!: string;

  /** HTTP status. Absent on an unknown error. */
  status?: number;

  /** Short English name of the status. Absent on an unknown error. */
  title?: string;

  /** The refused fields, when the input was not valid. */
  errors?: FieldErrorDto[];
}
