/**
 * The five spot procedures, each on its own Nest route.
 *
 * The route is where authorization lives — `@Roles('ADMIN')` on the four
 * `admin.spot.*` procedures, nothing on `spot.list`, which any authenticated
 * user needs for the preferred-spot picker. See `rpc-route-handler.ts` for why
 * the transport is mounted per procedure rather than once behind a catch-all.
 *
 * Every method body is the same delegation. The interesting part is the router
 * built in the constructor: those handlers are what oRPC validates the input and
 * output of against `libs/garage/contract`.
 */

import { Controller } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Roles } from '../auth/roles.decorator';
import { implementer } from '../orpc/implementer';
import { RpcRouteHandler } from '../orpc/rpc-route-handler';
import { RPC_ROUTE_PREFIX } from '../orpc/rpc-route';
import { RpcRoute } from '../orpc/rpc-route.decorator';
import { SpotsService } from './spots.service';

@Controller(RPC_ROUTE_PREFIX)
export class SpotsController {
  private readonly rpc: RpcRouteHandler;

  constructor(spots: SpotsService, @InjectPinoLogger(SpotsController.name) logger: PinoLogger) {
    this.rpc = new RpcRouteHandler(
      {
        spot: {
          list: implementer.spot.list.handler(async () => ({ spots: await spots.listVisible() })),
        },
        admin: {
          spot: {
            list: implementer.admin.spot.list.handler(async ({ input }) => ({
              spots: await spots.adminList(input),
            })),
            create: implementer.admin.spot.create.handler(({ input, context }) =>
              spots.create(input, context.user.id)
            ),
            update: implementer.admin.spot.update.handler(({ input, context }) =>
              spots.update(input, context.user.id)
            ),
            deactivate: implementer.admin.spot.deactivate.handler(({ input, context }) =>
              spots.deactivate(input, context.user.id)
            ),
          },
        },
      },
      logger
    );
  }

  /** Active, non-hidden spots. Any authenticated user. */
  @RpcRoute('spot', 'list')
  listSpots(): Promise<void> {
    throw new Error('replaced by @RpcRoute');
  }

  @Roles('ADMIN')
  @RpcRoute('admin', 'spot', 'list')
  adminListSpots(): Promise<void> {
    throw new Error('replaced by @RpcRoute');
  }

  @Roles('ADMIN')
  @RpcRoute('admin', 'spot', 'create')
  createSpot(): Promise<void> {
    throw new Error('replaced by @RpcRoute');
  }

  @Roles('ADMIN')
  @RpcRoute('admin', 'spot', 'update')
  updateSpot(): Promise<void> {
    throw new Error('replaced by @RpcRoute');
  }

  @Roles('ADMIN')
  @RpcRoute('admin', 'spot', 'deactivate')
  deactivateSpot(): Promise<void> {
    throw new Error('replaced by @RpcRoute');
  }
}
