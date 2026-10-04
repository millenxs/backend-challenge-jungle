import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { WageringService } from "./application/wagering.service";
import { WalletService } from "./application/wallet.service";
import { OpsController, WageringController, WalletController } from "./http/controllers";
import { ErrorFilter } from "./http/error.filter";
import { NoopAuthGuard } from "./infrastructure/auth/noop-auth.guard";
import { createMikroOrmConfig } from "./infrastructure/persistence/mikro-orm.config";
import { Workers } from "./infrastructure/workers";

@Module({
  imports: [MikroOrmModule.forRoot({ ...createMikroOrmConfig(), registerRequestContext: false })],
  controllers: [WalletController, WageringController, OpsController],
  providers: [
    WalletService,
    WageringService,
    Workers,
    { provide: APP_GUARD, useClass: NoopAuthGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule {}
