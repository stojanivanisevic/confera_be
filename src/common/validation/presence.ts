import { registerDecorator, ValidateIf, type ValidationOptions } from 'class-validator';

/**
 * Optional, but never null: a field that may be left out of a change and that has no
 * "empty" value. `@IsOptional()` lets null pass too, and the service would hand it to the
 * database (E2-08); with this, null meets the field's other rules and is refused.
 */
export function IsOptionalNotNull(): PropertyDecorator {
  return ValidateIf((_object: object, value: unknown) => value !== undefined);
}

/**
 * Required, but may be null: a field that a request must give, null to clear it (the
 * payment details: "each field is given; null clears it"). Use with
 * `@ValidateIf((_, value) => value !== null)` before the field's own rules.
 */
export function IsGiven(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isGiven',
      target: target.constructor,
      propertyName: String(propertyName),
      options,
      validator: { validate: (value: unknown) => value !== undefined },
    });
  };
}

/** Nullable: skips the other rules for null, and only for null. */
export function NullOr(): PropertyDecorator {
  return ValidateIf((_object: object, value: unknown) => value !== null);
}

/**
 * A moment as the API takes it in a query: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM[:SS[.fff]]`
 * with `Z` or an offset, between the years 2000 and 9999. Week dates, ordinal dates and
 * other ISO 8601 forms are refused, and so is a date that does not exist (E2-08).
 */
export function isMoment(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
      value,
    )
  ) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const time = new Date(value).getTime();
  if (year < 2000 || Number.isNaN(time)) {
    return false;
  }
  // 2026-02-30 is not a day: the date part must survive the round trip.
  return value.length > 10 || new Date(time).toISOString().slice(0, 10) === value;
}
