import { ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import type { FieldErrorDto } from './problem.dto';
import { ProblemException } from './problem';

export const VALIDATION_FAILED = 'validation_failed';

/** Flattens the tree of class-validator into field path and rule code. Values are never copied. */
export function fieldErrors(errors: readonly ValidationError[], parent = ''): FieldErrorDto[] {
  return errors.flatMap((error) => {
    const path = parent === '' ? error.property : `${parent}.${error.property}`;
    const own = Object.keys(error.constraints ?? {}).map((code) => ({ path, code }));
    return [...own, ...fieldErrors(error.children ?? [], path)];
  });
}

/**
 * The validation of every request body, query and parameter that has a DTO class:
 * unknown properties are refused, and a refusal is a problem with field paths and codes.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    validationError: { target: false, value: false },
    exceptionFactory: (errors) => new ProblemException(400, VALIDATION_FAILED, fieldErrors(errors)),
  });
}
