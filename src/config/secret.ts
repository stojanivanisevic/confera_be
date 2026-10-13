import { inspect } from 'node:util';

const MASK = '[secret]';

/**
 * A configuration value that must never reach a log, an error message or a response.
 *
 * The value is only handed out by `reveal()`. Printing, string conversion, JSON
 * serialisation and `util.inspect` all give the mask, so a careless
 * `logger.log(config)` cannot leak a credential (NFR-SEC-04, test ST-03).
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return MASK;
  }

  toJSON(): string {
    return MASK;
  }

  [inspect.custom](): string {
    return MASK;
  }
}
