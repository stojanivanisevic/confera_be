/**
 * Answers that must not tell anything by their time (ADR-03, SEC-A-15, ST-16): sign-in and
 * a request for a password reset answer an unknown, a known, a braked, a deactivated and an
 * invited account alike in status and body, and none of them sooner than a floor. The work
 * of each path (a hash, a query, a row in the outbox) takes far less than the floor, so the
 * answers fall into one band of time.
 */
export const SIGN_IN_FLOOR_MS = 300;
export const RESET_REQUEST_FLOOR_MS = 300;

export function startClock(): number {
  return performance.now();
}

/** Waits until `floorMs` have passed since `started`. */
export async function notBefore(started: number, floorMs: number): Promise<void> {
  const left = floorMs - (performance.now() - started);
  if (left > 0) {
    await new Promise((resolve) => setTimeout(resolve, left));
  }
}
