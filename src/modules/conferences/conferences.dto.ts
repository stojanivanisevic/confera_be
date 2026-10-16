import { IsOptionalNotNull } from '../../common/validation/presence';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsPlainText } from '../../common/validation/plain-text';
import { Satisfies } from '../../common/validation/satisfies';
import { isTimeZone } from './listed-sites';

export const CONFERENCE_STATES = ['draft', 'open', 'closed', 'archived'] as const;
export type ConferenceState = (typeof CONFERENCE_STATES)[number];

export const CONFERENCE_LANGUAGES = ['en', 'sr'] as const;

const CODE = /^[A-Z]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A conference, one edition (FR-CONF-01 to 04). Forms, fees, deadlines and numbering
 * arrive with their modules. `listedSites` are origins (scheme, host, port) as stored
 * after the check of ST-30.
 */
export class ConferenceDto {
  id!: string;
  name!: string;
  /** Two capital letters: IT, ER, EM, LI, AI. */
  code!: string;
  editionYear!: number | null;
  /** YYYY-MM-DD. */
  startsOn!: string | null;
  endsOn!: string | null;
  venue!: string | null;
  listedSites!: string[];
  languages!: string[];
  /** An IANA time zone, for example Europe/Belgrade. */
  timeZone!: string;
  state!: ConferenceState;
  mailServerId!: string | null;
  version!: number;
}

export class ConferenceListDto {
  items!: ConferenceDto[];
}

export class ConferenceQueryDto {
  @IsOptional()
  @IsIn(CONFERENCE_STATES)
  state?: ConferenceState;
}

class ConferenceFields {
  @IsOptional()
  @IsInt()
  @Min(2000)
  @Max(2100)
  editionYear?: number | null;

  @IsOptional()
  @Matches(DATE)
  @IsISO8601({ strict: true })
  startsOn?: string | null;

  @IsOptional()
  @Matches(DATE)
  @IsISO8601({ strict: true })
  endsOn?: string | null;

  @IsOptional()
  @IsPlainText()
  @MaxLength(300)
  venue?: string | null;

  /** At most 20; each is checked and kept as an origin (ST-30). */
  @IsOptionalNotNull()
  @IsArray()
  @ArrayMaxSize(21)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  listedSites?: string[];

  @IsOptionalNotNull()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(CONFERENCE_LANGUAGES, { each: true })
  languages?: string[];

  @IsOptionalNotNull()
  @IsString()
  @Satisfies('isTimeZone', isTimeZone)
  timeZone?: string;

  @IsOptional()
  @IsUUID('4')
  mailServerId?: string | null;
}

/** A new conference; it starts as a draft. */
export class CreateConferenceDto extends ConferenceFields {
  @IsPlainText()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @Matches(CODE)
  code!: string;
}

/** A change of a conference. A field left out stays; null clears it. Refused when archived. */
export class UpdateConferenceDto extends ConferenceFields {
  @IsOptionalNotNull()
  @IsPlainText()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptionalNotNull()
  @Matches(CODE)
  code?: string;

  @IsInt()
  @Min(1)
  version!: number;
}

/** A change of state (FR-CONF-04): draft, open, closed, archived. Archived is final. */
export class ConferenceStateDto {
  @IsIn(CONFERENCE_STATES)
  state!: ConferenceState;

  @IsInt()
  @Min(1)
  version!: number;
}

/**
 * A new conference as a copy of another (FR-CONF-03): its settings, templates and mail
 * server choice; not its dates, which belong to the new edition.
 */
export class CopyConferenceDto {
  @IsPlainText()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @Matches(CODE)
  code?: string;

  @IsOptional()
  @IsInt()
  @Min(2000)
  @Max(2100)
  editionYear?: number | null;
}
