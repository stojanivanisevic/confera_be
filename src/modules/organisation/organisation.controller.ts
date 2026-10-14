import { Body, Get, Patch, Put } from '@nestjs/common';
import { AdminController } from '../../common/http/surface';
import type { Access } from '../access/access';
import { CurrentAccess, FreshPassword, Permission } from '../access/access.decorators';
import { OrganisationDto, PaymentDetailsDto, UpdateOrganisationDto } from './organisation.dto';
import { OrganisationService } from './organisation.service';

/** The profile of the signed-in admin's organisation (FR-ORG-03; ST-19). */
@AdminController('organisation')
export class OrganisationController {
  constructor(private readonly organisations: OrganisationService) {}

  @Get()
  @Permission('organisation.read')
  getOrganisation(@CurrentAccess() access: Access): Promise<OrganisationDto> {
    return this.organisations.get(access.organisationId);
  }

  /** Changes the issuer data. 409 `version_conflict` when another admin changed it first. */
  @Patch()
  @Permission('organisation.manage')
  updateOrganisation(
    @CurrentAccess() access: Access,
    @Body() body: UpdateOrganisationDto,
  ): Promise<OrganisationDto> {
    return this.organisations.update(access, body);
  }

  /**
   * Changes the bank accounts and the PayPal payee: needs the password asked again
   * (403 `password_confirmation_required` without it), and every active admin is told.
   */
  @Put('payment-details')
  @Permission('organisation.manage')
  @FreshPassword()
  changePaymentDetails(
    @CurrentAccess() access: Access,
    @Body() body: PaymentDetailsDto,
  ): Promise<OrganisationDto> {
    return this.organisations.changePaymentDetails(access, body);
  }
}
