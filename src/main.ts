import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { JsonLogger, log } from "./infrastructure/observability";

const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
const port = Number(process.env.PORT ?? 3000);
await app.listen(port);
log("info", "application listening", { port });

// Shutdown gracioso: app.close() roda os hooks (workers terminam o lote em andamento, depois o ORM fecha).
// Saída 0 = encerrou limpo; o enableShutdownHooks do Nest re-emitiria o sinal e sairia com 143.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    log("info", "shutdown requested", { signal });
    await app.close();
    log("info", "shutdown complete", { signal });
    process.exit(0);
  });
}
