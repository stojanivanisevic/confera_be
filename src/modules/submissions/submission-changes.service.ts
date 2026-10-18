import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ProblemException } from '../../common/http/problem';
import { VALIDATION_FAILED } from '../../common/http/validation';
import type { Prisma } from '../../generated/prisma/client';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import type { Access } from '../access/access';
import { AuditRecorder } from '../audit/audit-recorder';
import { FileStorage } from '../files/storage';
import { fileFieldsOf, parseDefinition } from '../forms/definition';
import { checkAnswers } from '../forms/rules';
import { composeMessage, type ComposeInput } from '../mail/mail-composer';
import { MailQueue } from '../mail/mail-queue';
import type { Rendered } from '../templates/render';
import { textErrors, type Transition, transitionOf } from './status-machine';
import { columnsOf, searchTextOfColumns } from './submission-columns';
import type {
  NoteDto,
  StatusChangeDto,
  StatusEmailPreviewDto,
  StatusTextsDto,
  SubmissionEditDto,
  SubmissionNoteDto,
} from './submissions.dto';

/** The hash of an email as it will be sent: what a preview and its confirmation share. */
export function previewDigestOf(rendered: Rendered): string {
  return createHash('sha256')
    .update(rendered.subject)
    .update('\u0000')
    .update(rendered.html)
    .update('\u0000')
    .update(rendered.text)
    .digest('hex');
}

type SubmissionRow = Prisma.SubmissionGetPayload<{
  include: { conference: { select: { statusMailOff: true } } };
}>;

/** A text as stored: its lines kept, trimmed. Undefined stays undefined. */
function cleaned(text: string | undefined): string | undefined {
  return text?.replace(/\r\n?/g, '\n').trim();
}

/**
 * The changes an admin makes to a submission (M4-BE-01, M4-BE-02; FR-SUB-05 to 08,
 * FR-MAIL-05, 07, 08): a change of status by the state table, its email queued in the same
 * transaction and rendered there, the preview of that email before anything changes, notes,
 * and corrections on the author's behalf with the old answers kept.
 *
 * Every change names the version of the submission it was made on: a second admin, a
 * double click or a repeated request meets 409 `version_conflict`, and sends no email.
 */
@Injectable()
export class SubmissionChangesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly mail: MailQueue,
    private readonly audit: AuditRecorder,
    private readonly storage: FileStorage,
  ) {}

  /** The email a change of status would send, rendered by the server, and nothing changes (FR-MAIL-08). */
  async preview(id: string, input: StatusTextsDto): Promise<StatusEmailPreviewDto> {
    return this.database.transaction(async (tx) => {
      const submission = await this.load(tx, id);
      const transition = this.check(submission, input);
      if (submission.conference.statusMailOff.includes(transition.template)) {
        return {
          sends: false,
          to: null,
          language: null,
          subject: null,
          html: null,
          text: null,
          previewDigest: null,
        };
      }
      const draft = this.messageOf(submission, transition, randomUUID());
      const message = cleaned(input.message) ?? null;
      const sent = await composeMessage(tx, draft, { message });
      if (sent === null) {
        return {
          sends: true,
          to: submission.correspondingEmail,
          language: submission.language,
          subject: null,
          html: null,
          text: null,
          previewDigest: null,
        };
      }
      // Shown with its images embedded, in a sandboxed frame; the hash is of what is sent.
      const shown = await composeMessage(tx, draft, {
        message,
        images: { kind: 'data', read: (key) => this.bytesOf(key) },
      });
      return {
        sends: true,
        to: submission.correspondingEmail,
        language: submission.language,
        subject: sent.subject,
        html: shown?.html ?? sent.html,
        text: sent.text,
        previewDigest: previewDigestOf(sent),
      };
    });
  }

  /** A change of status by the state table, with its email (Spec section 5, FR-MAIL-05). */
  async change(actor: Access, id: string, input: StatusChangeDto): Promise<void> {
    await this.database.transaction(async (tx) => {
      const submission = await this.load(tx, id);
      const transition = this.check(submission, input);
      if (submission.version !== input.version) {
        throw new ProblemException(409, 'version_conflict');
      }
      const changed = await tx.submission.updateMany({
        where: { id, version: input.version, status: submission.status },
        data: { status: transition.to, version: { increment: 1 }, updatedAt: new Date() },
      });
      if (changed.count !== 1) {
        throw new ProblemException(409, 'version_conflict');
      }
      const off = submission.conference.statusMailOff.includes(transition.template);
      const historyId = randomUUID();
      const messageId = off ? null : randomUUID();
      const message = cleaned(input.message) ?? null;
      await tx.submissionStatusChange.create({
        data: {
          id: historyId,
          organisationId: actor.organisationId,
          submissionId: id,
          status: transition.to,
          fromStatus: submission.status,
          transition: transition.number,
          actorUserId: actor.userId,
          reason: cleaned(input.reason) ?? null,
          message,
          mailState: off ? 'template_off' : 'queued',
          messageId,
        },
      });
      if (messageId !== null) {
        await this.mail.enqueue(tx, {
          ...this.queuedOf(submission, transition, historyId),
          id: messageId,
        });
        // What the admin was shown is what goes out (FR-MAIL-08): the rendering made in
        // this transaction must be the one of the preview, or nothing changes.
        if (message !== null || input.previewDigest !== undefined) {
          const queued = await tx.mailMessage.findUniqueOrThrow({
            where: { id: messageId },
            select: { renderedSubject: true, renderedHtml: true, renderedText: true },
          });
          const hash =
            queued.renderedSubject === null ||
            queued.renderedHtml === null ||
            queued.renderedText === null
              ? null
              : previewDigestOf({
                  subject: queued.renderedSubject,
                  html: queued.renderedHtml,
                  text: queued.renderedText,
                });
          if (input.previewDigest === undefined) {
            throw new ProblemException(400, VALIDATION_FAILED, [
              { path: 'previewDigest', code: 'required' },
            ]);
          }
          if (hash !== input.previewDigest) {
            throw new ProblemException(409, 'preview_outdated');
          }
        }
      }
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'submission.status_changed',
        subjectType: 'submission',
        subjectId: id,
        changes: { status: { old: submission.status, new: transition.to } },
      });
    });
  }

  async addNote(actor: Access, id: string, input: NoteDto): Promise<SubmissionNoteDto> {
    return this.database.transaction(async (tx) => {
      await this.load(tx, id);
      const note = await tx.submissionNote.create({
        data: {
          organisationId: actor.organisationId,
          submissionId: id,
          authorUserId: actor.userId,
          body: input.body.replace(/\r\n?/g, '\n').trim(),
        },
        include: { author: { select: { id: true, displayName: true } } },
      });
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'submission.note_added',
        subjectType: 'submission',
        subjectId: id,
      });
      return {
        id: note.id,
        body: note.body,
        author: note.author,
        createdAt: note.createdAt.toISOString(),
      };
    });
  }

  /**
   * A correction on the author's behalf (FR-SUB-06): the changed answers merged over the
   * stored ones and checked by the rules of the submission's form version, as a submit is;
   * the typed columns, the authors and the search text follow; a revision keeps the old
   * answers, who and when. A file field cannot be changed here; a withdrawn submission
   * cannot be corrected.
   */
  async edit(actor: Access, id: string, input: SubmissionEditDto): Promise<void> {
    await this.database.transaction(async (tx) => {
      const submission = await this.load(tx, id);
      if (submission.version !== input.version) {
        throw new ProblemException(409, 'version_conflict');
      }
      if (submission.status === 'withdrawn') {
        throw new ProblemException(409, 'submission_withdrawn');
      }
      const version = await tx.formVersion.findUniqueOrThrow({
        where: { id: submission.formVersionId },
        select: { definition: true },
      });
      const definition = parseDefinition(version.definition);
      const stored = submission.answers as Record<string, unknown>;
      const fileFields = new Set(fileFieldsOf(definition).map((field) => field.key));
      const errors: { path: string; code: string }[] = [];
      for (const key of Object.keys(input.answers)) {
        if (
          fileFields.has(key) &&
          JSON.stringify(input.answers[key]) !== JSON.stringify(stored[key])
        ) {
          errors.push({ path: `answers.${key}`, code: 'fileNotEditable' });
        }
      }
      if (errors.length > 0) {
        throw new ProblemException(400, VALIDATION_FAILED, errors);
      }
      const merged = { ...stored, ...input.answers };
      const checked = checkAnswers(definition, merged);
      if (!checked.ok) {
        throw new ProblemException(
          400,
          VALIDATION_FAILED,
          checked.errors.map(({ path, code }) => ({
            path: path === '' ? 'answers' : `answers.${path}`,
            code,
          })),
        );
      }
      const after = checked.answers as Record<string, unknown>;
      const keys = [...new Set([...Object.keys(stored), ...Object.keys(after)])].sort();
      const fields = keys.filter(
        (key) => JSON.stringify(stored[key]) !== JSON.stringify(after[key]),
      );
      if (fields.length === 0) {
        return;
      }
      const columns = columnsOf(checked.answers);
      const changed = await tx.submission.updateMany({
        where: { id, version: input.version },
        data: {
          answers: checked.answers,
          title: columns.title,
          participationType: columns.participationType,
          firstAuthorName: columns.firstAuthorName,
          firstAuthorInstitution: columns.firstAuthorInstitution,
          correspondingEmail: columns.correspondingEmail,
          correspondingDomain: columns.correspondingDomain,
          authorCount: columns.authorCount,
          searchText: searchTextOfColumns(submission.reference, columns),
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (changed.count !== 1) {
        throw new ProblemException(409, 'version_conflict');
      }
      if (fields.includes('authors')) {
        await tx.submissionAuthor.deleteMany({ where: { submissionId: id } });
        await tx.submissionAuthor.createMany({
          data: columns.authors.map((author) => ({
            organisationId: actor.organisationId,
            submissionId: id,
            ...author,
          })),
        });
      }
      const last = await tx.submissionRevision.findFirst({
        where: { submissionId: id },
        orderBy: { number: 'desc' },
        select: { number: true },
      });
      const pick = (answers: Record<string, unknown>) =>
        Object.fromEntries(fields.map((field) => [field, answers[field] ?? null]));
      await tx.submissionRevision.create({
        data: {
          organisationId: actor.organisationId,
          submissionId: id,
          number: (last?.number ?? 0) + 1,
          changedBy: actor.userId,
          fields,
          before: pick(stored),
          after: pick(after),
        },
      });
      // The names of the fields only: the values are what an author typed (FR-AUD-01).
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'submission.edited',
        subjectType: 'submission',
        subjectId: id,
        changes: Object.fromEntries(fields.map((field) => [field, { old: null, new: null }])),
      });
    });
  }

  private async load(tx: Prisma.TransactionClient, id: string): Promise<SubmissionRow> {
    const submission = await tx.submission.findUnique({
      where: { id },
      include: { conference: { select: { statusMailOff: true } } },
    });
    if (submission === null) {
      throw new ProblemException(404, 'not_found');
    }
    return submission;
  }

  /** The transition asked for from the current status, with its texts, or a refusal. */
  private check(submission: SubmissionRow, input: StatusTextsDto): Transition {
    const result = transitionOf(input.action, submission.status);
    if (!result.ok) {
      throw new ProblemException(409, result.refusal);
    }
    const errors = textErrors(result.transition, input);
    if (errors.length > 0) {
      throw new ProblemException(400, VALIDATION_FAILED, errors);
    }
    return result.transition;
  }

  private queuedOf(submission: SubmissionRow, transition: Transition, historyId: string) {
    return {
      organisationId: submission.organisationId,
      kind: transition.template,
      recipientAddress: submission.correspondingEmail,
      // One email per change of status: its key is the history row (FR-MAIL-05).
      uniqueKey: `submission_status:${historyId}`,
      language: submission.language === 'sr' ? ('sr' as const) : ('en' as const),
      conferenceId: submission.conferenceId,
      formId: submission.formId,
      submissionId: submission.id,
      parameters: { submissionId: submission.id, historyId },
    };
  }

  private messageOf(
    submission: SubmissionRow,
    transition: Transition,
    historyId: string,
  ): ComposeInput {
    const queued = this.queuedOf(submission, transition, historyId);
    return {
      ...queued,
      recipientUserId: null,
      linkPurpose: null,
    };
  }

  private async bytesOf(key: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.storage.read(key)) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }
}
