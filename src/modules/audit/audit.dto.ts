import { isMoment } from '../../common/validation/presence';
import { Satisfies } from '../../common/validation/satisfies';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { AUDIT_ACTIONS } from './audit-recorder';

export class AuditChangeDto {
  old!: string | null;
  new!: string | null;
}

export class AuditActorDto {
  id!: string;
  displayName!: string;
}

export class AuditEntryDto {
  id!: string;
  occurredAt!: string;
  /** Who did it; null for the system (a summary). */
  actor!: AuditActorDto | null;
  /** One of the actions of the audit log, for example `user.role_changed`. */
  action!: string;
  subjectType!: string;
  subjectId!: string | null;
  /** The names of the fields that changed. */
  fields!: string[];
  /** Old and new value, only for the fields whose values the log keeps (settings that are not personal). */
  changes!: Record<string, AuditChangeDto>;
  /** Counts and periods of a summary. */
  detail!: Record<string, string | number | boolean>;
  traceId!: string | null;
}

export class AuditPageDto {
  items!: AuditEntryDto[];
  total!: number;
  page!: number;
  pageSize!: number;
}

export class AuditQueryDto {
  @IsOptional()
  @IsIn(AUDIT_ACTIONS)
  action?: string;

  @IsOptional()
  @IsUUID('4')
  actorUserId?: string;

  @IsOptional()
  @IsUUID('4')
  subjectId?: string;

  /** Entries from this moment on. */
  @IsOptional()
  @Satisfies('isMoment', isMoment)
  from?: string;

  /** Entries before this moment. */
  @IsOptional()
  @Satisfies('isMoment', isMoment)
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
