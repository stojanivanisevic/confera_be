import { registerDecorator, type ValidationOptions } from 'class-validator';

/**
 * A short text a person types into one field (a name): no control character, no line
 * break, no invisible formatting character (a direction override, a zero-width space),
 * not empty and not only white space. Letters of every script are welcome (š č ć ž đ,
 * Cyrillic).
 */
export function isPlainText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value === value.trim() &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
  );
}

/** The rule above as a validation of a DTO; the field error code is `isPlainText`. */
export function IsPlainText(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isPlainText',
      target: target.constructor,
      propertyName: String(propertyName),
      options,
      validator: { validate: (value: unknown) => isPlainText(value) },
    });
  };
}
