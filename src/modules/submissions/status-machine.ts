/**
 * The status model of a submission (Spec section 5, M4-BE-01, FR-SUB-05). The state table
 * as code: every transition an admin can ask for, from which statuses, to which, the
 * template of its email, and the texts it takes. Any change not in the table is refused.
 *
 *   #  action    from                                         to
 *   1  (submit)  none                                         new       (the form, intake.service.ts)
 *   2  open      new                                          open      (a POST by the detail screen, ST-43)
 *   3  -         reviewers assigned or removed: no change of status (0.5.0)
 *   4  return    open                                         returned_for_revision  (a note for the author)
 *   5  resume    returned_for_revision                        open
 *   6  accept    open, returned_for_revision                  accepted
 *   7  reject    open, returned_for_revision                  rejected
 *   8  withdraw  new, open, returned_for_revision, accepted   withdrawn (an internal reason)
 *   9  reopen    accepted, rejected                           open      (an internal reason)
 *
 * Each transition that changes the status sends one email, from its template, unless the
 * conference switched that template off (FR-MAIL-07). The internal reason never reaches
 * the email; the text for the author (`message`) does, and the admin sees the email first
 * (FR-MAIL-08). Transition 9 is allowed while no proforma or invoice is in force: none
 * exists before 0.6.0.
 */
export const SUBMISSION_STATUSES = [
  'new',
  'open',
  'returned_for_revision',
  'accepted',
  'rejected',
  'withdrawn',
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export const STATUS_ACTIONS = [
  'open',
  'return',
  'resume',
  'accept',
  'reject',
  'withdraw',
  'reopen',
] as const;
export type StatusAction = (typeof STATUS_ACTIONS)[number];

/** The template types of the status emails of transitions 2 and 4 to 9 (FR-MAIL-03). */
export const STATUS_TEMPLATE_TYPES = [
  'submission_opened',
  'submission_returned',
  'submission_resumed',
  'submission_accepted',
  'submission_rejected',
  'submission_withdrawn',
  'submission_reopened',
] as const;
export type StatusTemplateType = (typeof STATUS_TEMPLATE_TYPES)[number];

/** What a text of a transition must be: given, allowed, or not taken at all. */
export type TextRule = 'required' | 'optional' | 'none';

export interface Transition {
  readonly number: 2 | 4 | 5 | 6 | 7 | 8 | 9;
  readonly action: StatusAction;
  readonly from: readonly SubmissionStatus[];
  readonly to: SubmissionStatus;
  readonly template: StatusTemplateType;
  /** The internal reason (withdraw, reopen): kept in the history, never sent. */
  readonly reason: TextRule;
  /** The text for the author, carried by the email; the admin sees the email first when it is given. */
  readonly message: TextRule;
}

export const TRANSITIONS: Readonly<Record<StatusAction, Transition>> = {
  open: {
    number: 2,
    action: 'open',
    from: ['new'],
    to: 'open',
    template: 'submission_opened',
    reason: 'none',
    message: 'none',
  },
  return: {
    number: 4,
    action: 'return',
    from: ['open'],
    to: 'returned_for_revision',
    template: 'submission_returned',
    reason: 'none',
    message: 'required',
  },
  resume: {
    number: 5,
    action: 'resume',
    from: ['returned_for_revision'],
    to: 'open',
    template: 'submission_resumed',
    reason: 'none',
    message: 'none',
  },
  accept: {
    number: 6,
    action: 'accept',
    from: ['open', 'returned_for_revision'],
    to: 'accepted',
    template: 'submission_accepted',
    reason: 'none',
    message: 'none',
  },
  reject: {
    number: 7,
    action: 'reject',
    from: ['open', 'returned_for_revision'],
    to: 'rejected',
    template: 'submission_rejected',
    reason: 'none',
    message: 'optional',
  },
  withdraw: {
    number: 8,
    action: 'withdraw',
    from: ['new', 'open', 'returned_for_revision', 'accepted'],
    to: 'withdrawn',
    template: 'submission_withdrawn',
    reason: 'required',
    message: 'optional',
  },
  reopen: {
    number: 9,
    action: 'reopen',
    from: ['accepted', 'rejected'],
    to: 'open',
    template: 'submission_reopened',
    reason: 'required',
    message: 'optional',
  },
};

export type TransitionRefusal =
  /** The action does not exist. */
  | 'unknown_action'
  /** The table has no such change from the current status. */
  | 'transition_refused';

/** The transition of an action from a status, or why there is none. */
export function transitionOf(
  action: string,
  from: string,
): { ok: true; transition: Transition } | { ok: false; refusal: TransitionRefusal } {
  if (!(STATUS_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, refusal: 'unknown_action' };
  }
  const transition = TRANSITIONS[action as StatusAction];
  if (!(transition.from as readonly string[]).includes(from)) {
    return { ok: false, refusal: 'transition_refused' };
  }
  return { ok: true, transition };
}

/** The actions an admin can take on a submission of this status, in the order of the table. */
export function actionsFrom(status: string): StatusAction[] {
  return STATUS_ACTIONS.filter((action) =>
    (TRANSITIONS[action].from as readonly string[]).includes(status),
  );
}

/** The errors of the texts given with a transition: a code per path, in a stable order. */
export function textErrors(
  transition: Transition,
  texts: { reason?: string | undefined; message?: string | undefined },
): { path: 'reason' | 'message'; code: 'required' | 'notAllowed' }[] {
  const errors: { path: 'reason' | 'message'; code: 'required' | 'notAllowed' }[] = [];
  for (const path of ['reason', 'message'] as const) {
    const rule = transition[path];
    const given = texts[path] !== undefined && texts[path].trim() !== '';
    if (rule === 'required' && !given) {
      errors.push({ path, code: 'required' });
    }
    if (rule === 'none' && texts[path] !== undefined) {
      errors.push({ path, code: 'notAllowed' });
    }
  }
  return errors;
}
