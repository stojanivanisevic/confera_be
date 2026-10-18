import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsISO8601, IsOptional, Matches, Min } from 'class-validator';

export const DEADLINE_KINDS = ['abstract_submission', 'fee_payment', 'full_paper'] as const;
export type DeadlineKind = (typeof DEADLINE_KINDS)[number];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class DeadlineDto {
  // The order of the values is fixed here, not left to the compiler (a stable contract).
  @ApiProperty({ enum: DEADLINE_KINDS })
  kind!: DeadlineKind;
  /**
   * The last day, inclusive, YYYY-MM-DD, in the conference's time zone: what a person reads
   * ("Ends 31 Dec 2099", UX3-08). It is what an admin sets and what is stored.
   */
  endsOn!: string;
  /**
   * The exclusive end: the instant it closes, the start of the day after `endsOn` in the
   * conference's time zone (`endsOn` 2099-12-31 in Europe/Belgrade: 2099-12-31T23:00:00.000Z).
   * For comparisons and countdowns, not to show as the last day.
   */
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
