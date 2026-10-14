import { registerDecorator, type ValidationOptions } from 'class-validator';

/**
 * A validation of a DTO by a check function. The field error code is `name`, so that the
 * web application can say which rule failed, never what the value was.
 */
export function Satisfies(
  name: string,
  check: (value: string) => boolean,
  options?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name,
      target: target.constructor,
      propertyName: String(propertyName),
      options,
      validator: {
        validate: (value: unknown) => typeof value === 'string' && check(value),
      },
    });
  };
}

/** Text of several lines (an address, a note): no control character but the line break. */
export function isMultilineText(value: string): boolean {
  return (
    value.trim() !== '' &&
    !/[\p{Cf}\p{Zl}\p{Zp}]/u.test(value) &&
    // Control characters but the line break (U+000A); written as escapes, as the README asks.
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/u.test(value)
  );
}
