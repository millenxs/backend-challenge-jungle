import { MikroORM } from "@mikro-orm/postgresql";
import { createMikroOrmConfig } from "./mikro-orm.config";

// Uso: bun run migration:up | bun run migration:down
const direction = process.argv[2] === "down" ? "down" : "up";
const orm = await MikroORM.init(createMikroOrmConfig());
await orm.getMigrator()[direction]();
await orm.close(true);
console.log(`migrations ${direction} applied`);
