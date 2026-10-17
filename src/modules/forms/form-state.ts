import { deadlineEnd, deadlinePassed } from '../deadlines/deadline-time';
import type { FormType } from './catalogue';
import type { ClosedReason, PublicFormState } from './forms.dto';

/**
 * Whether a form takes submissions now (FR-DL-01, FR-DL-02, FR-CONF-04): its conference is
 * open for submissions, it has a published version, and the deadline of its kind has not
 * passed in the conference's time zone. A draft conference's form is not public at all.
 * Judged at the moment a request arrives, so an extension opens the form again at once.
 */
export const DEADLINE_OF_FORM: Readonly<Record<FormType, 'abstract_submission'>> = {
  abstract: 'abstract_submission',
};

export interface FormSituation {
  readonly conferenceState: string;
  readonly timeZone: string;
  readonly published: boolean;
  /** The last day, as stored (a date at 00:00 UTC), or null without a deadline. */
  readonly deadline: Date | null;
}

export interface FormStateResult {
  /** Whether the public form may be shown at all. */
  readonly visible: boolean;
  readonly state: PublicFormState;
  readonly closedReason: ClosedReason | null;
  readonly deadline: string | null;
  readonly closesAt: Date | null;
}

export function dayText(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function formState(situation: FormSituation, now: Date): FormStateResult {
  const deadline = situation.deadline === null ? null : dayText(situation.deadline);
  const closesAt = deadline === null ? null : deadlineEnd(deadline, situation.timeZone);
  const visible = situation.published && situation.conferenceState !== 'draft';
  const closed = (closedReason: ClosedReason): FormStateResult => ({
    visible,
    state: 'closed',
    closedReason,
    deadline,
    closesAt,
  });
  if (!situation.published) {
    return closed('not_published');
  }
  if (situation.conferenceState !== 'open') {
    return closed('conference_closed');
  }
  if (deadline !== null && deadlinePassed(deadline, situation.timeZone, now)) {
    return closed('deadline_passed');
  }
  return { visible, state: 'open', closedReason: null, deadline, closesAt };
}
