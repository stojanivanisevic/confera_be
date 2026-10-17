import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsISO8601, IsOptional, Matches, Min } from 'class-validator';

export const DEADLINE_KINDS = ['abstract_submission', 'fee_payment', 'full_paper'] as const;
export type DeadlineKind = (typeof DEADLINE_KINDS)[number];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class DeadlineDto {
  // The order of the values is fixed here, not left to the compiler (a stable contract).
  @ApiProperty({ enum: DEADLINE_KINDS })
  kind!: DeadlineKind;
  /** The last day, YYYY-MM-DD, in the conference's time zone. */
  endsOn!: string;
  /** The instant it ends: the start of the next day in the conference's time zone. */
  endsAt!: string;
  /** Whether it has passed now. */
  passed!: boolean;
  version!: number;
}

export class DeadlineChangeDto {
  @ApiProperty({ enum: DEADLINE_KINDS })
  kind!: DeadlineKind;
  oldEndsOn!: string | null;
  newEndsOn!: string;
  changedAt!: string;
  changedBy!: { id: string; displayName: string } | null;
}

export class DeadlinesDto {
  timeZone!: string;
  items!: DeadlineDto[];
  /** Newest first. */
  history!: DeadlineChangeDto[];
}

/** A new last day. `version` is required to change an existing deadline (two admins at once). */
export class SetDeadlineDto {
  @Matches(DAY)
  @IsISO8601({ strict: true })
  endsOn!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}
