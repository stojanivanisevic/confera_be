import { HttpException } from '@nestjs/common';
import type { Response } from 'express';
import type { FieldErrorDto, ProblemDto } from './problem.dto';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Code of every error the API did not expect. Its body is this code and a trace id, nothing else. */
export const INTERNAL_ERROR = 'internal_error';

/** The statuses the API uses, with their code and title. Anything else is reported as its class. */
const KNOWN_STATUS: Readonly<Record<number, readonly [code: string, title: string]>> = {
  400: ['bad_request', 'Bad Request'],
  401: ['unauthenticated', 'Unauthorized'],
  403: ['forbidden', 'Forbidden'],
  404: ['not_found', 'Not Found'],
  405: ['method_not_allowed', 'Method Not Allowed'],
  406: ['not_acceptable', 'Not Acceptable'],
  408: ['request_timeout', 'Request Timeout'],
  409: ['conflict', 'Conflict'],
  410: ['gone', 'Gone'],
  413: ['payload_too_large', 'Content Too Large'],
  415: ['unsupported_media_type', 'Unsupported Media Type'],
  422: ['unprocessable', 'Unprocessable Content'],
  429: ['too_many_requests', 'Too Many Requests'],
  503: ['service_unavailable', 'Service Unavailable'],
};

function known(status: number): readonly [string, string] {
  return (
    KNOWN_STATUS[status] ??
    (status >= 500 ? ['error', 'Server Error'] : ['request_refused', 'Request Refused'])
  );
}

/**
 * An error the application raises on purpose, with a stable code.
 * `new ProblemException(409, 'conference_code_taken')`
 */
export class ProblemException extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly errors?: readonly FieldErrorDto[],
  ) {
    super(code);
    this.name = 'ProblemException';
  }
}

export interface Problem {
  readonly status: number;
  readonly body: ProblemDto;
  /** True when the error was not expected and must be logged in full. */
  readonly unexpected: boolean;
}

function expected(
  status: number,
  traceId: string,
  code?: string,
  errors?: readonly FieldErrorDto[],
): Problem {
  const [defaultCode, title] = known(status);
  const body: ProblemDto = { code: code ?? defaultCode, traceId, status, title };
  if (errors !== undefined && errors.length > 0) {
    body.errors = errors.map(({ path, code: fieldCode }) => ({ path, code: fieldCode }));
  }
  return { status, body, unexpected: false };
}

function statusOfHttpError(error: object): number | undefined {
  // Errors of the body parser and of other Express middleware (package http-errors).
  const { status, statusCode, expose } = error as {
    status?: unknown;
    statusCode?: unknown;
    expose?: unknown;
  };
  const value = typeof status === 'number' ? status : statusCode;
  if (typeof value === 'number' && value >= 400 && value < 500 && expose === true) {
    return value;
  }
  return undefined;
}

/**
 * Turns anything that was thrown into the answer the client gets.
 *
 * Only the status and a fixed code and title leave the server. The message of the
 * exception never does: it can hold a path, a SQL statement or a value. Anything that is
 * not a deliberate HTTP error becomes status 500 with `code` and `traceId` only (ST-10).
 */
export function toProblem(exception: unknown, traceId: string): Problem {
  if (exception instanceof ProblemException) {
    return expected(exception.status, traceId, exception.code, exception.errors);
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    if (status >= 400 && status < 500) {
      return expected(status, traceId);
    }
    if (status === 503) {
      return expected(status, traceId);
    }
  } else if (exception !== null && typeof exception === 'object') {
    const status = statusOfHttpError(exception);
    if (status !== undefined) {
      return expected(status, traceId);
    }
  }
  return { status: 500, body: { code: INTERNAL_ERROR, traceId }, unexpected: true };
}

/** Writes a problem as the response. Used by the exception filter and by plain middleware. */
export function sendProblem(res: Response, problem: Problem): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(JSON.stringify(problem.body));
}
