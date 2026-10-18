import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ProblemException } from '../../common/http/problem';
import { VALIDATION_FAILED } from '../../common/http/validation';
import type { AppConfig } from '../../config/config';
import { APP_CONFIG } from '../../config/config.module';
import type { Prisma } from '../../generated/prisma/client';
import { type ResolvedForm, SystemResolvers } from '../../platform/prisma/system/resolvers';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import { TenantContext } from '../../platform/tenancy/tenant-context';
import { frameSites } from '../conferences/listed-sites';
import { SendBreaker } from '../held-mail/send-breaker';
import { MailQueue } from '../mail/mail-queue';
import { AUTHORS_SECTION, type FormLanguage, type Localised } from './catalogue';
import { type FormDefinition, fileFieldsOf, parseDefinition } from './definition';
import { DEADLINE_OF_FORM, formState, type FormStateResult } from './form-state';
import type { FormTokenDto, PublicFormDto, SubmittedDto } from './forms.dto';
import { newChallenge, PROOF_OF_WORK_DIFFICULTY, proofOfWorkHolds } from './proof-of-work';
import { LIMITS, PublicLimits } from './public-limits';
import { type AnswerValue, checkAnswers } from './rules';

/**
 * The public intake of a form (ADR-08, M3-BE-03; FR-FORM-07, 12, 13, 14, FR-SUB-01): read
 * the published form, fetch a single-use token, submit once. The organisation is found by
 * the form's public key (a resolver); everything after that runs inside it, under
 * row-level security. Nothing here reads a session.
 */

/** How long a form token lives: an author may take an afternoon over an abstract (P). */
export const FORM_TOKEN_LIFETIME_MS = 6 * 60 * 60_000;
/** A submit sooner than this after its token is a script: a fake success (ADR-08, item 7). */
export const MINIMUM_FILL_MS = 3_000;
/** How long a refused token may be renewed after it was issued (Q3-01). */
export const RENEWAL_WINDOW_MS = 24 * 60 * 60_000;
/** Fake successes remembered for their repeats, at most. */
const MAX_DECOYS = 10_000;
/** Uploads a token allows beyond the file fields of its form (ADR-08: "a small margin"). */
export const UPLOAD_MARGIN = 2;

export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

type TokenRow = Prisma.FormTokenGetPayload<object>;

interface LoadedForm {
  readonly form: Prisma.FormGetPayload<{
    include: { currentVersion: true; conference: true };
  }>;
  readonly state: FormStateResult;
}

function localisedIn(text: Localised, language: FormLanguage): string {
  return language === 'sr' && text.sr.trim() !== '' ? text.sr : text.en;
}

function asText(value: AnswerValue | Record<string, AnswerValue>[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

@Injectable()
export class IntakeService {
  /** The fake successes given, by form and idempotency key, so that a repeat answers the same. */
  readonly #decoys = new Map<string, SubmittedDto>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly resolvers: SystemResolvers,
    private readonly context: TenantContext,
    private readonly database: TenantDatabase,
    private readonly limits: PublicLimits,
    private readonly breaker: SendBreaker,
    private readonly mail: MailQueue,
  ) {}

  /** The organisation and the form of a public key, or 404. */
  async resolve(slug: string): Promise<ResolvedForm> {
    const resolved = await this.resolvers.formByPublicKey(slug);
    if (resolved === null) {
      throw new ProblemException(404, 'not_found');
    }
    return resolved;
  }

  /** Runs `work` inside the organisation of the form. */
  async inForm<T>(slug: string, work: (resolved: ResolvedForm) => Promise<T>): Promise<T> {
    const resolved = await this.resolve(slug);
    return this.context.run(resolved.organisationId, () => work(resolved));
  }

  async load(tx: Prisma.TransactionClient, formId: string, now: Date): Promise<LoadedForm> {
    const form = await tx.form.findUniqueOrThrow({
      where: { id: formId },
      include: { currentVersion: true, conference: true },
    });
    const deadline = await tx.conferenceDeadline.findFirst({
      where: { conferenceId: form.conferenceId, kind: DEADLINE_OF_FORM.abstract },
      select: { endsOn: true },
    });
    const state = formState(
      {
        conferenceState: form.conference.state,
        timeZone: form.conference.timeZone,
        published: form.currentVersion !== null,
        deadline: deadline?.endsOn ?? null,
      },
      now,
    );
    return { form, state };
  }

  /** The published form (FR-FORM-06, FR-DL-02): its definition, and whether it is open. */
  publicForm(slug: string): Promise<PublicFormDto> {
    return this.inForm(slug, (resolved) =>
      this.database.transaction(async (tx) => {
        const { form, state } = await this.load(tx, resolved.formId, new Date());
        if (!state.visible || form.currentVersion === null) {
          throw new ProblemException(404, 'not_found');
        }
        return {
          slug: form.publicKey,
          state: state.state,
          closedReason: state.closedReason,
          deadline: state.deadline,
          closesAt: state.closesAt?.toISOString() ?? null,
          conference: {
            code: form.conference.code,
            name: form.conference.name,
            timeZone: form.conference.timeZone,
            languages: form.conference.languages,
          },
          consentLinks: {
            terms: form.conference.publicationTermsUrl,
            privacy: form.conference.privacyNoticeUrl,
          },
          contactEmail:
            (
              await tx.organisation.findUniqueOrThrow({
                where: { id: resolved.organisationId },
                select: { contactEmail: true },
              })
            ).contactEmail ?? null,
          versionNumber: form.currentVersion.number,
          definition: parseDefinition(form.currentVersion.definition) as unknown as Record<
            string,
            unknown
          >,
        };
      }),
    );
  }

  /**
   * The sites that may frame the form (ADR-07, SEC-M2-12): the stored list of its
   * conference, each entry checked again, and nothing unless the conference is open for
   * submissions and the form is published. An unknown form is 404 (`'none'` for the page).
   */
  frameSites(slug: string): Promise<string[]> {
    return this.inForm(slug, (resolved) =>
      this.database.transaction(async (tx) => {
        const { form } = await this.load(tx, resolved.formId, new Date());
        if (form.conference.state !== 'open' || form.currentVersion === null) {
          return [];
        }
        return frameSites(form.conference.listedSites, this.config.stage);
      }),
    );
  }

  /** Whether the form is busy now: more than 20 submissions in 10 minutes (ADR-08, item 2). */
  private async formBusy(
    tx: Prisma.TransactionClient,
    formId: string,
    now: Date,
  ): Promise<boolean> {
    const recent = await tx.submission.count({
      where: {
        formId,
        receivedAt: { gt: new Date(now.getTime() - LIMITS.powSubmissionsPerForm.windowMs) },
      },
    });
    return recent > LIMITS.powSubmissionsPerForm.count;
  }

  /**
   * The token a renewal names (Q3-01): of this form, issued within 24 hours, expired or used
   * or not, and not renewed before (Q3-14: one chain, not two); otherwise none, and the new
   * token starts a chain of its own. Its row is locked, so that two renewals of one token at
   * once cannot both take it over.
   */
  private async renewable(
    tx: Prisma.TransactionClient,
    formId: string,
    previous: string | undefined,
    now: Date,
  ): Promise<TokenRow | null> {
    if (previous === undefined || !TOKEN_SHAPE.test(previous)) {
      return null;
    }
    const row = await tx.formToken.findFirst({ where: { tokenHash: tokenHash(previous) } });
    if (row?.formId !== formId || now.getTime() - row.issuedAt.getTime() > RENEWAL_WINDOW_MS) {
      return null;
    }
    await tx.$queryRaw`SELECT id FROM form_tokens WHERE id = ${row.id}::uuid FOR UPDATE`;
    const successor = await tx.formToken.findFirst({
      where: { renewedFrom: row.id },
      select: { id: true },
    });
    return successor === null ? row : null;
  }

  /**
   * A single-use token for one form (ADR-08, item 1). Under load it carries a proof-of-work:
   * more than 20 submissions in 10 minutes on the form, or a client that behaved like a
   * script. With `previousFormToken` (Q3-01) it renews a refused token of the same form: it
   * keeps the moment the author began (the minimum fill time counts from there), takes over
   * the files uploaded with the old one and its count of uploads, and the old one is used up.
   */
  async issueToken(slug: string, address: string, previous?: string): Promise<FormTokenDto> {
    if (!this.limits.takeToken(address)) {
      throw new ProblemException(429, 'too_many_requests');
    }
    return this.inForm(slug, (resolved) =>
      this.database.transaction(async (tx) => {
        const now = new Date();
        const { form, state } = await this.load(tx, resolved.formId, now);
        if (!state.visible || form.currentVersion === null) {
          throw new ProblemException(404, 'not_found');
        }
        if (state.state !== 'open') {
          throw new ProblemException(409, 'form_closed');
        }
        const underLoad =
          (await this.formBusy(tx, form.id, now)) || this.limits.addressUnderLoad(address);
        const renewed = await this.renewable(tx, form.id, previous, now);
        const token = randomBytes(32).toString('base64url');
        const expiresAt = new Date(now.getTime() + FORM_TOKEN_LIFETIME_MS);
        const challenge = underLoad ? newChallenge() : null;
        const created = await tx.formToken.create({
          data: {
            organisationId: resolved.organisationId,
            formId: form.id,
            formVersionId: form.currentVersion.id,
            tokenHash: tokenHash(token),
            issuedAt: now,
            expiresAt,
            // A first token: its issue is the start (null); a renewal keeps the chain's start.
            fillStartedAt: renewed === null ? null : (renewed.fillStartedAt ?? renewed.issuedAt),
            renewedFrom: renewed?.id ?? null,
            uploads: renewed?.uploads ?? 0,
            powChallenge: challenge,
            powDifficulty: challenge === null ? null : PROOF_OF_WORK_DIFFICULTY,
          },
        });
        if (renewed !== null) {
          await tx.formToken.updateMany({
            where: { id: renewed.id, usedAt: null },
            data: { usedAt: now },
          });
          await tx.storedFile.updateMany({
            where: { formTokenId: renewed.id, submissionId: null },
            data: { formTokenId: created.id },
          });
        }
        return {
          formToken: token,
          expiresAt: expiresAt.toISOString(),
          proofOfWork:
            challenge === null ? null : { challenge, difficulty: PROOF_OF_WORK_DIFFICULTY },
        };
      }),
    );
  }

  /**
   * The token of a request, inside the organisation of the form: of this form, not expired.
   * Every refusal is 403 `form_token_invalid` (one that was used: 409 `form_token_used`).
   */
  async validToken(
    tx: Prisma.TransactionClient,
    formId: string,
    token: string | undefined,
    now: Date,
  ): Promise<TokenRow> {
    if (token === undefined || !TOKEN_SHAPE.test(token)) {
      throw new ProblemException(403, 'form_token_invalid');
    }
    const row = await tx.formToken.findFirst({ where: { tokenHash: tokenHash(token) } });
    if (row?.formId !== formId || row.expiresAt.getTime() <= now.getTime()) {
      throw new ProblemException(403, 'form_token_invalid');
    }
    if (row.usedAt !== null) {
      throw new ProblemException(409, 'form_token_used');
    }
    return row;
  }

  /** How many uploads a token of a form version allows: its file fields and a margin. */
  uploadAllowance(definition: FormDefinition): number {
    return fileFieldsOf(definition).length + UPLOAD_MARGIN;
  }

  /**
   * The submit (ADR-08, FR-FORM-14): processed once. A repeat with the same idempotency key
   * and the same body returns the first result; with another body 409. One transaction writes
   * the submission, its authors, its files, its first status, the consent and the confirmation.
   */
  async submit(input: {
    readonly slug: string;
    readonly address: string;
    readonly token: string | undefined;
    readonly idempotencyKey: string;
    readonly language: FormLanguage;
    readonly answers: unknown;
    readonly trap: string | undefined;
    readonly proofOfWork: string | undefined;
  }): Promise<SubmittedDto> {
    const payloadHash = createHash('sha256')
      .update(JSON.stringify({ language: input.language, answers: input.answers }), 'utf8')
      .digest('hex');
    return this.inForm(input.slug, async (resolved) => {
      const repeated = await this.repeated(resolved.formId, input.idempotencyKey, payloadHash);
      if (repeated !== null) {
        return repeated;
      }
      // A repeat of a key that was answered with a fake success gets the same answer (Q3-07).
      const decoy = this.#decoys.get(`${resolved.formId}:${input.idempotencyKey}`);
      if (decoy !== undefined) {
        return decoy;
      }
      if (!this.limits.takeSubmit(input.address)) {
        throw new ProblemException(429, 'too_many_requests');
      }
      const now = new Date();
      try {
        return await this.database.transaction((tx) =>
          this.write(tx, resolved, input, payloadHash, now),
        );
      } catch (error) {
        if (error instanceof ProblemException && error.code === 'form_token_invalid') {
          this.limits.suspicious(input.address);
        }
        // Two submits of one key at once: the second one lost the token to the first.
        if (error instanceof ProblemException && error.code === 'form_token_used') {
          const first = await this.repeated(resolved.formId, input.idempotencyKey, payloadHash);
          if (first !== null) {
            return first;
          }
        }
        if ((error as { code?: unknown }).code === 'P2002') {
          const first = await this.repeated(resolved.formId, input.idempotencyKey, payloadHash);
          if (first !== null) {
            return first;
          }
        }
        throw error;
      }
    });
  }

  private async repeated(
    formId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<SubmittedDto | null> {
    const first = await this.database.db.submission.findFirst({
      where: { formId, idempotencyKey },
      select: { reference: true, receivedAt: true, language: true, payloadHash: true },
    });
    if (first === null) {
      return null;
    }
    if (first.payloadHash !== payloadHash) {
      throw new ProblemException(409, 'idempotency_key_reused');
    }
    return {
      reference: first.reference,
      receivedAt: first.receivedAt.toISOString(),
      language: first.language === 'sr' ? 'sr' : 'en',
    };
  }

  private async write(
    tx: Prisma.TransactionClient,
    resolved: ResolvedForm,
    input: Parameters<IntakeService['submit']>[0],
    payloadHash: string,
    now: Date,
  ): Promise<SubmittedDto> {
    const token = await this.validToken(tx, resolved.formId, input.token, now);
    const used = await tx.formToken.updateMany({
      where: { id: token.id, usedAt: null },
      data: { usedAt: now },
    });
    if (used.count !== 1) {
      throw new ProblemException(409, 'form_token_used');
    }
    const { form, state } = await this.load(tx, resolved.formId, now);

    // The trap and the minimum fill time (ADR-08, item 7): a fake success, nothing stored.
    // The fill time counts from the first token of a chain of renewals (Q3-01, Q3-14): the
    // page renews a refused token and submits at once, and that is a person when the chain
    // began 3 s ago or more; a renewal never skips the rule.
    const started = token.fillStartedAt ?? token.issuedAt;
    if (
      (input.trap !== undefined && input.trap !== '') ||
      now.getTime() - started.getTime() < MINIMUM_FILL_MS
    ) {
      this.limits.suspicious(input.address);
      return this.decoy(
        resolved.formId,
        input.idempotencyKey,
        form.conference,
        input.language,
        now,
      );
    }
    // The proof-of-work is decided at the submit as well (Q3-02): a token fetched while the
    // form was quiet is renewed by the page and then carries a challenge.
    const required =
      token.powChallenge !== null ||
      (await this.formBusy(tx, form.id, now)) ||
      this.limits.addressUnderLoad(input.address);
    if (
      required &&
      (token.powChallenge === null ||
        !proofOfWorkHolds(
          token.powChallenge,
          token.powDifficulty ?? PROOF_OF_WORK_DIFFICULTY,
          input.proofOfWork,
        ))
    ) {
      if (token.powChallenge !== null) {
        this.limits.suspicious(input.address);
      }
      throw new ProblemException(403, 'proof_of_work_failed');
    }
    if (state.state !== 'open') {
      throw new ProblemException(409, 'form_closed');
    }
    const version = await tx.formVersion.findUniqueOrThrow({ where: { id: token.formVersionId } });
    const definition = parseDefinition(version.definition);
    const checked = checkAnswers(definition, input.answers);
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
    const answers = checked.answers;

    // The files: each uploaded with this token for its field, and not attached before.
    const fileFields = fileFieldsOf(definition).map((field) => field.key);
    const fileIds: { key: string; id: string }[] = [];
    for (const key of fileFields) {
      const id = asText(answers[key]);
      if (id !== null) {
        fileIds.push({ key, id });
      }
    }
    for (const { key, id } of fileIds) {
      const file = await tx.storedFile.findFirst({
        where: { id, formTokenId: token.id, fieldKey: key, submissionId: null },
        select: { id: true },
      });
      if (file === null) {
        throw new ProblemException(400, VALIDATION_FAILED, [
          { path: `answers.${key}`, code: 'fileUnknown' },
        ]);
      }
    }

    const authors = (answers[AUTHORS_SECTION] ?? []) as Record<string, AnswerValue>[];
    const first = authors[0] ?? {};
    const email = asText(first.email ?? undefined) ?? '';
    const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
    const reference = await this.nextReference(tx, form.conferenceId, now);
    const language = input.language;
    const consentText = localisedIn(definition.texts.consent, language);
    const consentLinks = {
      terms: form.conference.publicationTermsUrl,
      privacy: form.conference.privacyNoticeUrl,
    };

    const submission = await tx.submission.create({
      data: {
        organisationId: resolved.organisationId,
        conferenceId: form.conferenceId,
        formId: form.id,
        formVersionId: version.id,
        reference,
        language,
        answers: answers,
        title: asText(answers.title),
        participationType: asText(answers.participationType),
        firstAuthorName:
          `${asText(first.firstName ?? undefined) ?? ''} ${asText(first.lastName ?? undefined) ?? ''}`.trim(),
        firstAuthorInstitution: asText(first.institution ?? undefined),
        correspondingEmail: email,
        correspondingDomain: domain,
        authorCount: authors.length,
        consentText,
        consentLinks,
        consentVersion: createHash('sha256')
          .update(JSON.stringify({ text: consentText, links: consentLinks }), 'utf8')
          .digest('hex'),
        consentedAt: now,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        receivedAt: now,
      },
    });
    await tx.submissionAuthor.createMany({
      data: authors.map((author, index) => ({
        organisationId: resolved.organisationId,
        submissionId: submission.id,
        position: index + 1,
        firstName: asText(author.firstName ?? undefined) ?? '',
        lastName: asText(author.lastName ?? undefined) ?? '',
        institution: asText(author.institution ?? undefined),
        institutionAddress: asText(author.institutionAddress ?? undefined),
        orcid: asText(author.orcid ?? undefined),
        email: asText(author.email ?? undefined) ?? '',
        phone: asText(author.phone ?? undefined),
        isCorresponding: index === 0,
      })),
    });
    await tx.submissionStatusChange.create({
      data: {
        organisationId: resolved.organisationId,
        submissionId: submission.id,
        status: 'received',
        changedAt: now,
      },
    });
    for (const { id } of fileIds) {
      await tx.storedFile.update({
        where: { id },
        data: { submissionId: submission.id, attachedAt: now, nextScanAt: now },
      });
    }

    // The confirmation (FR-FORM-15, FR-MAIL-04): queued in this transaction, or held.
    const organisation = await tx.organisation.findUniqueOrThrow({
      where: { id: resolved.organisationId },
      select: { breakerPerHour: true, breakerPerDay: true },
    });
    const held = await this.breaker.decide(tx, {
      formId: form.id,
      form: { perHour: form.breakerPerHour, perDay: form.breakerPerDay },
      organisation: { perHour: organisation.breakerPerHour, perDay: organisation.breakerPerDay },
      domain,
      now,
    });
    await this.mail.enqueue(tx, {
      organisationId: resolved.organisationId,
      kind: 'submission_confirmation',
      recipientAddress: email,
      uniqueKey: `submission_confirmation:${submission.id}`,
      language,
      conferenceId: form.conferenceId,
      formId: form.id,
      submissionId: submission.id,
      parameters: { submissionId: submission.id },
      held,
    });
    if (held !== null) {
      const hour = now.toISOString().slice(0, 13);
      await this.mail.noticeToAdmins(
        tx,
        resolved.organisationId,
        'mail_held',
        { formId: form.id },
        `mail_held:${form.id}:${hour}`,
      );
    }
    return { reference, receivedAt: now.toISOString(), language };
  }

  /**
   * A fake success (ADR-08, item 7; Q3-07): shaped like the next real reference of the
   * conference (its code, its edition, the next number), and the same for a repeat of the key.
   */
  private decoy(
    formId: string,
    idempotencyKey: string,
    conference: { code: string; editionYear: number | null; submissionCounter: number },
    language: FormLanguage,
    now: Date,
  ): SubmittedDto {
    const year = String((conference.editionYear ?? now.getUTCFullYear()) % 100).padStart(2, '0');
    const answer: SubmittedDto = {
      reference: `${conference.code}${year}-${String(conference.submissionCounter + 1).padStart(4, '0')}`,
      receivedAt: now.toISOString(),
      language,
    };
    if (this.#decoys.size >= MAX_DECOYS) {
      const oldest = this.#decoys.keys().next().value;
      if (oldest !== undefined) {
        this.#decoys.delete(oldest);
      }
    }
    this.#decoys.set(`${formId}:${idempotencyKey}`, answer);
    return answer;
  }

  /** The next reference of a conference: code, two digits of the edition, a number (IT27-0001). */
  private async nextReference(
    tx: Prisma.TransactionClient,
    conferenceId: string,
    now: Date,
  ): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const conference = await tx.conference.update({
        where: { id: conferenceId },
        data: { submissionCounter: { increment: 1 } },
        select: { code: true, editionYear: true, submissionCounter: true },
      });
      const year = String((conference.editionYear ?? now.getUTCFullYear()) % 100).padStart(2, '0');
      const reference = `${conference.code}${year}-${String(conference.submissionCounter).padStart(4, '0')}`;
      // Another edition of the same code without a year may have given it already.
      const taken = await tx.submission.findFirst({ where: { reference }, select: { id: true } });
      if (taken === null) {
        return reference;
      }
    }
    throw new ProblemException(409, 'reference_unavailable');
  }
}
