/**
 * Thrown while the application starts, to stop the start for a reason that is safe to
 * print: `reason` is a fixed sentence written by us. It never holds an address, a
 * password or the message of a driver.
 */
export class StartupRefusal extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'StartupRefusal';
  }
}
