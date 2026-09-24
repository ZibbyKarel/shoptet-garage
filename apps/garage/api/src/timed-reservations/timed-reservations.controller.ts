/**
 * The two `admin.timedReservation.*` procedures. Both admin-only, per the
 * contract's own comment on why the whole subtree is: booking a guest into a
 * half-hour block is an admin action, never a self-service one.
 */

import { Controller } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Roles } from '../auth/roles.decorator';
import { implementer } from '../orpc/implementer';
import { RpcRouteHandler } from '../orpc/rpc-route-handler';
import { RPC_ROUTE_PREFIX } from '../orpc/rpc-route';
import { RpcRoute } from '../orpc/rpc-route.decorator';
import { TimedReservationsService } from './timed-reservations.service';

@Controller(RPC_ROUTE_PREFIX)
export class TimedReservationsController {
  private readonly rpc: RpcRouteHandler;

  constructor(
    timedReservations: TimedReservationsService,
    @InjectPinoLogger(TimedReservationsController.name) logger: PinoLogger
  ) {
    this.rpc = new RpcRouteHandler(
      {
        admin: {
          timedReservation: {
            create: implementer.admin.timedReservation.create.handler(({ input, context }) =>
              timedReservations.create(input, context.user)
            ),
            cancel: implementer.admin.timedReservation.cancel.handler(({ input, context }) =>
              timedReservations.cancel(input, context.user)
            ),
          },
        },
      },
      logger
    );
  }

  @Roles('ADMIN')
  @RpcRoute('admin', 'timedReservation', 'create')
  createTimedReservation(): Promise<void> {
    throw new Error('replaced by @RpcRoute');
  }

  @Roles('ADMIN')
  @RpcRoute('admin', 'timedReservation', 'cancel')
  cancelTimedReservation(): Promise<void> {
    throw new Error('replaced by @RpcRoute');
  }
}
