import {
  actionsFrom,
  STATUS_ACTIONS,
  STATUS_TEMPLATE_TYPES,
  SUBMISSION_STATUSES,
  textErrors,
  TRANSITIONS,
  transitionOf,
} from './status-machine';

/**
 * The state table of Spec section 5 (M4-BE-01, FR-SUB-05): every transition it lists works,
 * and every other pair of a status and an action is refused.
 */
const TABLE: readonly [string, string, string, number][] = [
  // [action, from, to, row of the table]
  ['open', 'new', 'open', 2],
  ['return', 'open', 'returned_for_revision', 4],
  ['resume', 'returned_for_revision', 'open', 5],
  ['accept', 'open', 'accepted', 6],
  ['accept', 'returned_for_revision', 'accepted', 6],
  ['reject', 'open', 'rejected', 7],
  ['reject', 'returned_for_revision', 'rejected', 7],
  ['withdraw', 'new', 'withdrawn', 8],
  ['withdraw', 'open', 'withdrawn', 8],
  ['withdraw', 'returned_for_revision', 'withdrawn', 8],
  ['withdraw', 'accepted', 'withdrawn', 8],
  ['reopen', 'accepted', 'open', 9],
  ['reopen', 'rejected', 'open', 9],
];

describe('the status machine (Spec section 5)', () => {
  it.each(TABLE)('%s from %s goes to %s (row %i)', (action, from, to, row) => {
    const result = transitionOf(action, from);
    expect(result).toEqual({
      ok: true,
      transition: expect.objectContaining({ to, number: row }) as unknown,
    });
  });

  const allowed = new Set(TABLE.map(([action, from]) => `${action}:${from}`));
  const refused = SUBMISSION_STATUSES.flatMap((from) =>
    STATUS_ACTIONS.filter((action) => !allowed.has(`${action}:${from}`)).map(
      (action) => [action, from] as const,
    ),
  );

  it('refuses every other pair, and there are as many as the table leaves', () => {
    expect(refused.length).toBe(SUBMISSION_STATUSES.length * STATUS_ACTIONS.length - TABLE.length);
  });

  it.each(refused)('refuses %s from %s', (action, from) => {
    expect(transitionOf(action, from)).toEqual({ ok: false, refusal: 'transition_refused' });
  });

  it('a withdrawn submission can do nothing', () => {
    expect(actionsFrom('withdrawn')).toEqual([]);
  });

  it('knows no other action, and no status outside the model', () => {
    expect(transitionOf('delete', 'new')).toEqual({ ok: false, refusal: 'unknown_action' });
    expect(transitionOf('__proto__', 'new')).toEqual({ ok: false, refusal: 'unknown_action' });
    expect(transitionOf('open', 'received')).toEqual({ ok: false, refusal: 'transition_refused' });
  });

  it('gives each status-changing transition its own template (FR-MAIL-03)', () => {
    const templates = STATUS_ACTIONS.map((action) => TRANSITIONS[action].template);
    expect([...new Set(templates)].sort()).toEqual([...STATUS_TEMPLATE_TYPES].sort());
  });

  it('asks for the note of a return, and for the reason of a withdrawal and a reopening', () => {
    expect(textErrors(TRANSITIONS.return, {})).toEqual([{ path: 'message', code: 'required' }]);
    expect(textErrors(TRANSITIONS.return, { message: '  ' })).toEqual([
      { path: 'message', code: 'required' },
    ]);
    expect(textErrors(TRANSITIONS.withdraw, { message: 'x' })).toEqual([
      { path: 'reason', code: 'required' },
    ]);
    expect(textErrors(TRANSITIONS.reopen, { reason: 'x' })).toEqual([]);
    expect(textErrors(TRANSITIONS.open, { message: 'x', reason: 'y' })).toEqual([
      { path: 'reason', code: 'notAllowed' },
      { path: 'message', code: 'notAllowed' },
    ]);
    expect(textErrors(TRANSITIONS.accept, { message: 'x' })).toEqual([
      { path: 'message', code: 'notAllowed' },
    ]);
    expect(textErrors(TRANSITIONS.reject, {})).toEqual([]);
  });
});
