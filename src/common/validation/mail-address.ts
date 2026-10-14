import { registerDecorator, type ValidationOptions } from 'class-validator';

/**
 * The address rule (ADR-09, ADR-13, SEC-A-17, ST-23): an address that Confera stores or
 * sends to is ONE plain address, and nothing a mail header could read as more:
 *
 * - at most 254 characters, a local part of at most 64;
 * - exactly one `@`; no space, no control character, no comma, no angle bracket, no
 *   quotes, no display name, no line break;
 * - a local part of the characters of RFC 5322's dot-atom (no leading, trailing or double
 *   dot); a domain of at least two labels of letters, digits and hyphens, the last of at
 *   least two letters.
 *
 * Addresses are ASCII: an international address (SMTPUTF8) is not accepted in the MVP.
 */
const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export function isMailAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 254) {
    return false;
  }
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) {
    return false;
  }
  const local = value.slice(0, at);
  const labels = value.slice(at + 1).split('.');
  return (
    local.length <= 64 &&
    LOCAL.test(local) &&
    labels.length >= 2 &&
    labels.every((label) => LABEL.test(label)) &&
    /^[A-Za-z]{2,63}$/.test(labels[labels.length - 1] ?? '')
  );
}

/** The address rule as a validation of a DTO; the field error code is `isMailAddress`. */
export function IsMailAddress(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isMailAddress',
      target: target.constructor,
      propertyName: String(propertyName),
      options,
      validator: { validate: (value: unknown) => isMailAddress(value) },
    });
  };
}
