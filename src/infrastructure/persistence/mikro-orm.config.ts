import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import {
  InboxMessageRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletLedgerEntryRecord,
  WalletRecord,
} from "./records";
import { Migration20261001180000 } from "./migrations/Migration20261001180000";

export function createMikroOrmConfig() {
  return defineConfig({
    host: process.env.DATABASE_HOST ?? "localhost",
    port: Number(process.env.DATABASE_PORT ?? 5432),
    user: process.env.DATABASE_USER ?? "wager",
    password: process.env.DATABASE_PASSWORD ?? "wager",
    dbName: process.env.DATABASE_NAME ?? "wager",
    entities: [
      WalletRecord,
      WagerTransactionRecord,
      WalletLedgerEntryRecord,
      InboxMessageRecord,
      OutboxMessageRecord,
    ],
    extensions: [Migrator],
    migrations: {
      migrationsList: [
        {
          name: "Migration20261001180000",
          class: Migration20261001180000,
        },
      ],
    },
  });
}

export default createMikroOrmConfig();
