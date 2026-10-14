/**
 * Checks of the identifiers on an issuer's documents (FR-ORG-03). Each is the published
 * check of its kind; a value that fails it is a typing mistake that would end up on a
 * proforma.
 */

/** ISO 7064 MOD 97-10 over a string of digits and letters (letters as 10 to 35). */
function mod97(text: string): number {
  let remainder = 0;
  for (const character of text) {
    const value = /[0-9]/.test(character)
      ? character
      : String(character.toUpperCase().charCodeAt(0) - 55);
    for (const digit of value) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder;
}

/** An IBAN: two letters, two check digits, up to 30 letters and digits, and MOD 97 = 1. Spaces allowed. */
export function isIban(value: string): boolean {
  const iban = value.replace(/ /g, '').toUpperCase();
  return (
    /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban) &&
    mod97(`${iban.slice(4)}${iban.slice(0, 4)}`) === 1
  );
}

/** A BIC (SWIFT code): 4 letters of the bank, 2 of the country, 2 of the place, 3 of a branch or none. */
export function isBic(value: string): boolean {
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(value);
}

/**
 * A Serbian bank account: 3 digits of the bank, up to 13 of the account, 2 control digits
 * (written with or without dashes), whose 18 digits (the account padded with zeros) give
 * MOD 97 = 1.
 */
export function isSerbianAccount(value: string): boolean {
  const parts = /^([0-9]{3})-?([0-9]{1,13})-?([0-9]{2})$/.exec(value);
  if (parts === null) {
    return false;
  }
  const [, bank = '', account = '', control = ''] = parts;
  const digits = `${bank}${account.padStart(13, '0')}${control}`;
  return digits.length === 18 && mod97(digits) === 1;
}

/** A Serbian tax number (PIB): 9 digits, the last one checks the eight before it (ISO 7064 MOD 11,10). */
export function isSerbianTaxNumber(value: string): boolean {
  if (!/^[0-9]{9}$/.test(value)) {
    return false;
  }
  let product = 10;
  for (const digit of value.slice(0, 8)) {
    let sum = (Number(digit) + product) % 10;
    if (sum === 0) {
      sum = 10;
    }
    product = (sum * 2) % 11;
  }
  const check = (11 - product) % 10;
  return check === Number(value[8]);
}

/** A Serbian registration number (matični broj) of a legal entity: 8 digits. */
export function isSerbianRegistrationNumber(value: string): boolean {
  return /^[0-9]{8}$/.test(value);
}
