import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const pricingSaves = sqliteTable("pricing_saves", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  datasetFingerprint: text("dataset_fingerprint").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  stateJson: text("state_json").notNull(),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_pricing_saves_name").on(sql`${table.name} COLLATE NOCASE`),
  index("idx_pricing_saves_updated_at").on(table.updatedAt),
]);
