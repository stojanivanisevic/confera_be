/** The longest chain of resends that is followed back to the first request. */
const MAX_RESEND_DEPTH = 100;

/** The reasons a message that carried a link failed as no longer true (E2-04, SEC-M2-01). */
export const STALE_REASONS: readonly string[] = [
  'superseded',
  'account_changed',
  'address_changed',
  'account_gone',
];

/**
 * When the link of a message was asked for (SEC-M4-02): its own `createdAt`, or, for a
 * resend from the mail log, that of the first message of the chain it repeats. A resend
 * is a new row of now, so judging it by its own time would bring a request back to life
 * that a later change of the password or the address had ended. Null when the chain is
 * broken (the first message is gone): then the request is judged stale. `find` reads one
 * message's `createdAt` and `resendOf` by its id.
 */
export async function linkRequestedAt(
  find: (id: string) => Promise<{ createdAt: Date; resendOf: string | null } | null>,
  message: { readonly createdAt: Date; readonly resendOf: string | null },
): Promise<Date | null> {
  let at = message.createdAt;
  let previous = message.resendOf;
  for (let depth = 0; previous !== null; depth += 1) {
    if (depth === MAX_RESEND_DEPTH) {
      return null;
    }
    const original = await find(previous);
    if (original === null) {
      return null;
    }
    at = original.createdAt;
    previous = original.resendOf;
  }
  return at;
}

/** True when the password or the address of the account changed after the link was asked for. */
export function changedSince(
  user: { readonly passwordChangedAt: Date | null; readonly emailChangedAt: Date | null },
  requestedAt: Date | null,
): boolean {
  if (requestedAt === null) {
    return true;
  }
  return [user.passwordChangedAt, user.emailChangedAt].some(
    (changed) => changed !== null && requestedAt.getTime() < changed.getTime(),
  );
}
