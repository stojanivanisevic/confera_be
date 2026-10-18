import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export const HELD_REASONS = [
  'send_breaker_form',
  'send_breaker_organisation',
  'recipient_domain',
] as const;

export class HeldNumbersDto {
  count!: number;
  limit!: number;
  @ApiProperty({ enum: [1, 24] })
  windowHours!: 1 | 24;
}

export class HeldMailDto {
  id!: string;
  kind!: string;
  recipient!: string;
  @ApiProperty({ enum: HELD_REASONS })
  heldReason!: (typeof HELD_REASONS)[number];
  /**
   * The numbers of the hold (UX3-06): `count` confirmations in the last `windowHours` hours,
   * this one included, above `limit` (for `recipient_domain`: submissions to that domain in
   * 24 hours, limit 100). Null for an email held before the numbers were kept.
   */
  heldBy!: HeldNumbersDto | null;
  conference!: { id: string; code: string; name: string } | null;
  formId!: string | null;
  submission!: { id: string; reference: string } | null;
  createdAt!: string;
}

export class HeldMailPageDto {
  items!: HeldMailDto[];
  total!: number;
  page!: number;
  pageSize!: number;
  /** The send breaker of the organisation (ADR-08). */
  breaker!: { perHour: number; perDay: number; version: number };
}

export class HeldMailQueryDto {
  @IsOptional()
  @IsUUID('4')
  formId?: string;

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

/** Releases the held emails named, or every one (of a form, when `formId` is given). */
export class ReleaseHeldMailDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsUUID('4', { each: true })
  ids?: string[];

  @IsOptional()
  @IsBoolean()
  all?: boolean;

  @IsOptional()
  @IsUUID('4')
  formId?: string;
}

export class ReleasedDto {
  released!: number;
}

export class OrganisationBreakerDto {
  @IsInt()
  @Min(1)
  @Max(10_000)
  perHour!: number;

  @IsInt()
  @Min(1)
  @Max(100_000)
  perDay!: number;

  /** The version of the organisation profile. */
  @IsInt()
  @Min(1)
  version!: number;
}
