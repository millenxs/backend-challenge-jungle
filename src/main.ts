import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { JsonLogger, log } from "./infrastructure/observability";

const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
app.enableShutdownHooks(); // SIGTERM → workers terminam o lote em andamento antes de fechar
const port = Number(process.env.PORT ?? 3000);
await app.listen(port);
log("info", "application listening", { port });
