import { Satisfies } from '../../common/validation/satisfies';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { IsMailAddress } from '../../common/validation/mail-address';
import { IsPlainText } from '../../common/validation/plain-text';
import { ROLES } from '../access/permissions';

export const USER_STATES = ['invited', 'active', 'deactivated', 'removed'] as const;

export class UserDto {
  id!: string;
  email!: string;
  displayName!: string;
  /** admin or reviewer. */
  role!: string;
  /** invited (no password yet), active, deactivated or removed. */
  status!: string;
  createdAt!: string;
  /** Sent back with a change: a change made on an older version is refused (409). */
  version!: number;
}

export class UserPageDto {
  items!: UserDto[];
  /** How many users match, over all pages. */
  total!: number;
  page!: number;
  pageSize!: number;
}

export class UserQueryDto {
  /** Part of the name or the address, in any letter case. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Satisfies('noControlCharacter', (value: string) => !/\p{Cc}/u.test(value))
  search?: string;

  /** One state; without it every user but the removed ones. */
  @IsOptional()
  @IsIn(USER_STATES)
  status?: string;

  @IsOptional()
  @IsIn(ROLES)
  role?: string;

  /** The page, from 1. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page?: number;

  /** Rows per page, at most 100. Default 25. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class InviteUserDto {
  /** The address the invitation goes to; the user signs in with it. */
  @IsMailAddress()
  email!: string;

  @IsPlainText()
  @MaxLength(200)
  displayName!: string;

  @IsIn(ROLES)
  role!: string;
}

export class UpdateUserDto {
  @IsPlainText()
  @MaxLength(200)
  displayName!: string;

  @IsInt()
  @Min(1)
  version!: number;
}

export class ChangeRoleDto {
  @IsIn(ROLES)
  role!: string;

  @IsInt()
  @Min(1)
  version!: number;
}

export class VersionDto {
  /** The version the change is made on. */
  @IsInt()
  @Min(1)
  version!: number;
}

/** The version a removal is made on, in the query of DELETE /users/{id}. */
export class RemoveUserQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}
