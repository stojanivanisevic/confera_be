import { IsBoolean, IsInt, IsOptional, MaxLength, Min } from 'class-validator';
import {
  isBic,
  isIban,
  isSerbianAccount,
  isSerbianRegistrationNumber,
  isSerbianTaxNumber,
} from '../../common/validation/bank';
import { IsMailAddress } from '../../common/validation/mail-address';
import { IsPlainText } from '../../common/validation/plain-text';
import { isMultilineText, Satisfies } from '../../common/validation/satisfies';

export class UserReferenceDto {
  id!: string;
  displayName!: string;
}

/**
 * The organisation profile (FR-ORG-03): the issuer data printed on documents. Entered by
 * an admin, never seeded and never taken from the repository.
 */
export class OrganisationDto {
  id!: string;
  /** The short name shown in the application. */
  name!: string;
  legalName!: string | null;
  address!: string | null;
  /** Matični broj: 8 digits. */
  registrationNumber!: string | null;
  /** PIB: 9 digits. */
  taxNumber!: string | null;
  contactEmail!: string | null;
  /** The note on documents that the association is exempt from VAT, in Serbian. */
  vatNoteSr!: string | null;
  /** The same note in English. */
  vatNoteEn!: string | null;
  /** The account for payments in RSD. */
  rsdAccount!: string | null;
  eurIban!: string | null;
  eurSwift!: string | null;
  eurBankName!: string | null;
  /** The PayPal account that receives payments. */
  paypalPayee!: string | null;
  /** When the payment details were changed last; the issue screen shows it for 14 days. */
  paymentDetailsChangedAt!: string | null;
  /** Who changed them. */
  paymentDetailsChangedBy!: UserReferenceDto | null;
  /** Whether the mail log keeps the subject and body of what was sent (FR-SMTP-04). */
  mailLogContent!: boolean;
  /** Sent back with a change: a change made on an older version is refused (409). */
  version!: number;
}

/** A change of the profile. A field left out stays as it is; null clears it. */
export class UpdateOrganisationDto {
  @IsOptional()
  @IsPlainText()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsPlainText()
  @MaxLength(300)
  legalName?: string | null;

  @IsOptional()
  @Satisfies('isMultilineText', isMultilineText)
  @MaxLength(500)
  address?: string | null;

  @IsOptional()
  @Satisfies('isRegistrationNumber', isSerbianRegistrationNumber)
  registrationNumber?: string | null;

  @IsOptional()
  @Satisfies('isTaxNumber', isSerbianTaxNumber)
  taxNumber?: string | null;

  @IsOptional()
  @IsMailAddress()
  contactEmail?: string | null;

  @IsOptional()
  @Satisfies('isMultilineText', isMultilineText)
  @MaxLength(1000)
  vatNoteSr?: string | null;

  @IsOptional()
  @Satisfies('isMultilineText', isMultilineText)
  @MaxLength(1000)
  vatNoteEn?: string | null;

  /** Whether the mail log keeps the content of what was sent (FR-SMTP-04). */
  @IsOptional()
  @IsBoolean()
  mailLogContent?: boolean;

  @IsInt()
  @Min(1)
  version!: number;
}

/**
 * The payment details (FR-ORG-03): changed only with the password asked again, and
 * announced to every active admin (ADR-03, ST-19). Each field is given; null clears it.
 */
export class PaymentDetailsDto {
  @IsOptional()
  @Satisfies('isSerbianAccount', isSerbianAccount)
  rsdAccount!: string | null;

  @IsOptional()
  @Satisfies('isIban', isIban)
  eurIban!: string | null;

  @IsOptional()
  @Satisfies('isBic', isBic)
  eurSwift!: string | null;

  @IsOptional()
  @IsPlainText()
  @MaxLength(200)
  eurBankName!: string | null;

  @IsOptional()
  @IsMailAddress()
  paypalPayee!: string | null;

  @IsInt()
  @Min(1)
  version!: number;
}
