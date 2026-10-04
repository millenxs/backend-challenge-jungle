import { MikroORM } from "@mikro-orm/postgresql";
import { createMikroOrmConfig } from "./mikro-orm.config";

const orm = await MikroORM.init(createMikroOrmConfig());
const migrator = orm.getMigrator();
await migrator.up();
await orm.close(true);
console.log("migrations applied");
