import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../../config/config';
import { APP_CONFIG } from '../../config/config.module';
import { ProblemException } from '../../common/http/problem';
import type { Prisma } from '../../generated/prisma/client';
import { TenantDatabase } from '../../platform/prisma/tenant-database';
import { TenantContext } from '../../platform/tenancy/tenant-context';
import type { Access } from '../access/access';
import { AuditRecorder, type FieldChange } from '../audit/audit-recorder';
import { MailQueue } from '../mail/mail-queue';
import { MailSender } from '../mail/mail-sender';
import type { DeliveryError } from '../mail/mail-transport';
import { SecretBox } from '../mail/secret-box';
import { targetProblem, type TlsMode } from './mail-server-policy';
import { TEST_FAILURE_CAUSES } from './mail-servers.dto';

/** Test messages an organisation may send in an hour (M3-ISS-02, SEC-M2-05; P). */
export const TEST_MESSAGES_PER_HOUR = 10;

/** The cause of a failed test message, coarse on purpose: a timeout is no connection. */
function causeOf(error: DeliveryError | undefined): (typeof TEST_FAILURE_CAUSES)[number] {
  switch (error) {
    case 'timeout':
    case 'connection_failed':
      return 'connection_failed';
    case 'certificate_refused':
    case 'authentication_failed':
    case 'recipient_refused':
      return error;
    default:
      return 'send_failed';
  }
}
import type {
  CreateMailServerDto,
  MailServerDto,
  TestMessageResultDto,
  UpdateMailServerDto,
} from './mail-servers.dto';

type ServerRow = Prisma.MailServerGetPayload<object>;

/** The fields whose change points the server elsewhere: the stored password goes (ADR-11). */
const TARGET_FIELDS = ['host', 'port', 'username', 'tlsMode'] as const;

const SETTING_FIELDS = [
  'name',
  'host',
  'port',
  'tlsMode',
  'username',
  'fromAddress',
  'fromName',
  'isDefault',
  'isFallback',
  'enabled',
  'sendRatePerMinute',
] as const;

function toDto(server: ServerRow): MailServerDto {
  return {
    id: server.id,
    name: server.name,
    host: server.host,
    port: server.port,
    tlsMode: server.tlsMode as TlsMode,
    username: server.username,
    credentialSet: server.passwordSealed !== null,
    credentialSetAt: server.passwordSetAt?.toISOString() ?? null,
    fromAddress: server.fromAddress,
    fromName: server.fromName,
    isDefault: server.isDefault,
    isFallback: server.isFallback,
    enabled: server.enabled,
    sendRatePerMinute: server.sendRatePerMinute,
    version: server.version,
  };
}

/**
 * Mail servers of the organisation (FR-SMTP-01 to 03, ADR-11; ST-19, ST-20). Every change
 * asks for the password again (the controller's `@FreshPassword`), is recorded in the audit
 * log and told to every active admin. The password is sealed bound to its row and never
 * returned; a change of the target without a new password clears it.
 */
@Injectable()
export class MailServersService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: TenantDatabase,
    private readonly context: TenantContext,
    private readonly box: SecretBox,
    private readonly audit: AuditRecorder,
    private readonly mail: MailQueue,
    private readonly sender: MailSender,
  ) {}

  async list(): Promise<MailServerDto[]> {
    const servers = await this.database.db.mailServer.findMany({
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return servers.map(toDto);
  }

  async get(id: string): Promise<MailServerDto> {
    return toDto(await this.database.transaction((tx) => this.load(tx, id)));
  }

  async create(actor: Access, input: CreateMailServerDto): Promise<MailServerDto> {
    this.checkTarget({ host: input.host, port: input.port, tlsMode: input.tlsMode });
    return this.database.transaction(async (tx) => {
      if (input.isDefault === true || input.isFallback === true) {
        await this.unmark(tx, null, input.isDefault === true, input.isFallback === true);
      }
      let server = await tx.mailServer.create({
        data: {
          organisationId: actor.organisationId,
          name: input.name,
          host: input.host.toLowerCase(),
          port: input.port,
          tlsMode: input.tlsMode,
          username: input.username ?? null,
          fromAddress: input.fromAddress,
          fromName: input.fromName,
          isDefault: input.isDefault ?? false,
          isFallback: input.isFallback ?? false,
          enabled: input.enabled ?? true,
          sendRatePerMinute: input.sendRatePerMinute ?? 30,
        },
      });
      if (input.password !== undefined) {
        server = await tx.mailServer.update({
          where: { id: server.id },
          data: { passwordSealed: this.seal(server.id, input.password), passwordSetAt: new Date() },
        });
      }
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'mail_server.created',
        subjectType: 'mail_server',
        subjectId: server.id,
        changes: this.changes(null, server, input.password !== undefined),
      });
      await this.wakeWaiting(tx);
      await this.mail.noticeToAdmins(tx, actor.organisationId, 'mail_server_created', {
        actorUserId: actor.userId,
      });
      return toDto(server);
    });
  }

  async update(actor: Access, id: string, input: UpdateMailServerDto): Promise<MailServerDto> {
    return this.database.transaction(async (tx) => {
      const before = await this.load(tx, id);
      const next = {
        host: input.host?.toLowerCase() ?? before.host,
        port: input.port ?? before.port,
        username: input.username === undefined ? before.username : input.username,
        tlsMode: (input.tlsMode ?? before.tlsMode) as TlsMode,
      };
      this.checkTarget(next);
      const targetChanged = TARGET_FIELDS.some((field) => next[field] !== before[field]);
      const data: Prisma.MailServerUpdateManyMutationInput = {
        ...next,
        name: input.name ?? before.name,
        fromAddress: input.fromAddress ?? before.fromAddress,
        fromName: input.fromName ?? before.fromName,
        isDefault: input.isDefault ?? before.isDefault,
        isFallback: input.isFallback ?? before.isFallback,
        enabled: input.enabled ?? before.enabled,
        sendRatePerMinute: input.sendRatePerMinute ?? before.sendRatePerMinute,
      };
      let passwordChanged = false;
      if (typeof input.password === 'string') {
        data.passwordSealed = this.seal(id, input.password);
        data.passwordSetAt = new Date();
        passwordChanged = true;
      } else if (input.password === null || (targetChanged && before.passwordSealed !== null)) {
        // A new target without a new password: the old one is not sent there (ST-20).
        data.passwordSealed = null;
        data.passwordSetAt = null;
        passwordChanged = before.passwordSealed !== null;
      }
      if (input.isDefault === true || input.isFallback === true) {
        await this.unmark(tx, id, input.isDefault === true, input.isFallback === true);
      }
      const changed = await tx.mailServer.updateMany({
        where: { id, version: input.version },
        data: { ...data, version: { increment: 1 }, updatedAt: new Date() },
      });
      if (changed.count !== 1) {
        throw new ProblemException(409, 'version_conflict');
      }
      const after = await this.load(tx, id);
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'mail_server.updated',
        subjectType: 'mail_server',
        subjectId: id,
        changes: this.changes(before, after, passwordChanged),
      });
      await this.wakeWaiting(tx);
      await this.mail.noticeToAdmins(tx, actor.organisationId, 'mail_server_changed', {
        actorUserId: actor.userId,
      });
      return toDto(after);
    });
  }

  async remove(actor: Access, id: string, version: number): Promise<void> {
    await this.database.transaction(async (tx) => {
      const before = await this.load(tx, id);
      const inUse =
        (await tx.conference.count({ where: { mailServerId: id } })) +
        (await tx.mailTemplate.count({ where: { mailServerId: id } }));
      if (inUse > 0) {
        throw new ProblemException(409, 'mail_server_in_use');
      }
      const removed = await tx.mailServer.deleteMany({ where: { id, version } });
      if (removed.count !== 1) {
        throw new ProblemException(409, 'version_conflict');
      }
      await this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'mail_server.deleted',
        subjectType: 'mail_server',
        subjectId: id,
        changes: { name: { old: before.name, new: null } },
      });
      await this.mail.noticeToAdmins(tx, actor.organisationId, 'mail_server_deleted', {
        actorUserId: actor.userId,
      });
    });
  }

  /**
   * Sends the test message (FR-SMTP-01; ADR-11): the rules of the target first, then one
   * delivery through this server. The answer is generic.
   */
  async test(
    actor: Access,
    id: string,
    to: string,
    language: 'en' | 'sr',
  ): Promise<TestMessageResultDto> {
    const server = await this.database.transaction((tx) => this.load(tx, id));
    // A cap of the organisation's test messages (M3-ISS-02, SEC-M2-05), and the send rate of
    // the server, which a test message counts against like any other (M2-ISS-12).
    const now = Date.now();
    const [tests, sentThisMinute] = await this.database.transaction((tx) =>
      Promise.all([
        tx.mailMessage.count({
          where: { kind: 'test_message', createdAt: { gt: new Date(now - 60 * 60_000) } },
        }),
        tx.mailLogEntry.count({
          where: { mailServerId: id, sentAt: { gt: new Date(now - 60_000) } },
        }),
      ]),
    );
    if (tests >= TEST_MESSAGES_PER_HOUR) {
      throw new ProblemException(429, 'test_message_limit');
    }
    if (sentThisMinute >= server.sendRatePerMinute) {
      throw new ProblemException(429, 'send_rate_reached');
    }
    const problem = targetProblem(
      { host: server.host, port: server.port, tlsMode: server.tlsMode as TlsMode },
      this.config.stage,
    );
    const outcome =
      problem === null ? await this.sender.sendTest(id, to, language, actor.userId) : null;
    const result: TestMessageResultDto =
      problem !== null
        ? { result: 'refused', reason: problem, cause: null }
        : outcome?.ok === true
          ? { result: 'sent', reason: null, cause: null }
          : outcome?.error === 'address_not_allowed' || outcome?.error === 'tls_required'
            ? { result: 'refused', reason: outcome.error, cause: null }
            : { result: 'failed', reason: null, cause: causeOf(outcome?.error) };
    await this.database.transaction((tx) =>
      this.audit.record(tx, {
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        action: 'mail_server.tested',
        subjectType: 'mail_server',
        subjectId: id,
      }),
    );
    return result;
  }

  /**
   * The messages that waited for a server are due again (UXUI-M2-01): the worker sends them
   * through the servers as they are now, or they wait again when none of them fits.
   */
  private async wakeWaiting(tx: Prisma.TransactionClient): Promise<void> {
    await tx.mailMessage.updateMany({
      where: { status: 'waiting_for_server' },
      data: { status: 'queued', nextAttemptAt: new Date(), lastErrorCode: null },
    });
  }

  private checkTarget(target: { host: string; port: number; tlsMode: TlsMode }): void {
    const problem = targetProblem(target, this.config.stage);
    if (problem !== null) {
      // The field that breaks the rule, so that the form can say it there (UXUI-M2-10).
      const path = {
        tls_required: 'tlsMode',
        port_not_allowed: 'port',
        address_not_allowed: 'host',
      }[problem];
      throw new ProblemException(422, problem, [{ path, code: problem }]);
    }
  }

  private seal(id: string, password: string): string {
    return this.box.seal(password, { table: 'mail_servers', rowId: id, field: 'password' });
  }

  /** One default and one fallback per organisation: marking a server takes the mark from the others. */
  private async unmark(
    tx: Prisma.TransactionClient,
    except: string | null,
    isDefault: boolean,
    isFallback: boolean,
  ): Promise<void> {
    // Two admins who mark at once are taken one after the other (E2-09); a unique index
    // of the migration holds the rule as well.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`confera mail server marks ${this.context.requireOrganisationId()}`}, 0))`;
    const others = except === null ? {} : { id: { not: except } };
    if (isDefault) {
      await tx.mailServer.updateMany({
        where: { ...others, isDefault: true },
        data: { isDefault: false },
      });
    }
    if (isFallback) {
      await tx.mailServer.updateMany({
        where: { ...others, isFallback: true },
        data: { isFallback: false },
      });
    }
  }

  private async load(tx: Prisma.TransactionClient, id: string): Promise<ServerRow> {
    const server = await tx.mailServer.findUnique({ where: { id } });
    if (server === null) {
      throw new ProblemException(404, 'not_found');
    }
    return server;
  }

  private changes(
    before: ServerRow | null,
    after: ServerRow,
    passwordChanged: boolean,
  ): Record<string, FieldChange> {
    const changes: Record<string, FieldChange> = {};
    for (const field of SETTING_FIELDS) {
      const old = before === null ? null : String(before[field] ?? '') || null;
      const next = String(after[field] ?? '') || null;
      if (old !== next) {
        changes[field] = { old, new: next };
      }
    }
    if (passwordChanged) {
      // By name only: the recorder keeps no value of a field outside its list.
      changes.password = { old: null, new: null };
    }
    return changes;
  }
}
