import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsMailAddress } from '../../common/validation/mail-address';

/** The longest text accepted where a password is typed. The rule set allows 128 characters. */
const PASSWORD_FIELD_LIMIT = 1024;

export class SignInDto {
  /** The email address of the account. */
  @IsString()
  @MaxLength(320)
  email!: string;

  /** The password of the account. */
  @IsString()
  @MaxLength(PASSWORD_FIELD_LIMIT)
  password!: string;
}

export class SessionUserDto {
  id!: string;
  email!: string;
  displayName!: string;
  /** The roles of the user: admin, reviewer. */
  roles!: string[];
  /** What the user may do (src/modules/access/permissions.ts). */
  permissions!: string[];
}

export class SessionOrganisationDto {
  id!: string;
  name!: string;
}

export class SessionDto {
  user!: SessionUserDto;
  organisation!: SessionOrganisationDto;
  /**
   * The value of the `X-CSRF-Token` header that every changing request of this session
   * carries (ADR-03). Bound to the session; never in a cookie.
   */
  csrf!: string;
  /** The session ends at this moment unless it is used before (24 hours after the last use). */
  idleExpiresAt!: string;
  /** The session ends at this moment whatever happens (7 days after sign-in). */
  absoluteExpiresAt!: string;
  /** Until when the password asked again is valid in this session; null when it was not asked. */
  confirmationValidUntil!: string | null;
  /** The step of the second factor (built in 0.9.0): not_required, pending or passed. */
  secondFactor!: string;
}

export class PasswordConfirmationDto {
  /** The password of the signed-in user, asked again before a sensitive change. */
  @IsString()
  @MaxLength(PASSWORD_FIELD_LIMIT)
  password!: string;
}

export class ConfirmationDto {
  /** The password asked again is valid until this moment, in this session only. */
  confirmationValidUntil!: string;
}

export class ChangePasswordDto {
  @IsString()
  @MaxLength(PASSWORD_FIELD_LIMIT)
  currentPassword!: string;

  @IsString()
  @MaxLength(PASSWORD_FIELD_LIMIT)
  newPassword!: string;

  /** The second entry of the new password: both entries must match. */
  @IsString()
  @MaxLength(PASSWORD_FIELD_LIMIT)
  newPasswordRepeat!: string;
}

export class ChangeEmailDto {
  /** The current password: an email change needs it (ADR-03). */
  @IsString()
  @MaxLength(PASSWORD_FIELD_LIMIT)
  password!: string;

  /** The new address. The change is confirmed from it. */
  @IsMailAddress()
  newEmail!: string;
}

export class ResetRequestDto {
  /** The address of the account. The answer is the same whether it belongs to one or not. */
  @IsString()
  @MinLength(1)
  @MaxLength(320)
  email!: string;
}

export class SetPasswordDto {
  @IsString()
  @MaxLength(PASSWORD_FIELD_LIMIT)
  password!: string;

  /** The second entry: both entries must match. */
  @IsString()
  @MaxLength(PASSWORD_FIELD_LIMIT)
  passwordRepeat!: string;
}

/**
 * What the page behind an invitation or a reset link shows, and what the live password
 * checklist needs to tick "not your own name or the organisation's" (G2-25).
 */
export class LinkPersonDto {
  email!: string;
  displayName!: string;
  organisationName!: string;
  /** The link stops working at this moment. */
  expiresAt!: string;
}

export class EmailChangeLinkDto {
  /** The address the account will have once the change is confirmed. */
  newEmail!: string;
  expiresAt!: string;
}
