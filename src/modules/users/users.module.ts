import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/** User administration (FR-USR-01, FR-USR-02, FR-USR-04). */
@Module({ controllers: [UsersController], providers: [UsersService] })
export class UsersModule {}
