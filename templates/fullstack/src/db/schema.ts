// Define the app's tables here with drizzle-orm/sqlite-core, for example:
//
//   import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
//
//   export const todos = sqliteTable("todos", {
//     id: integer("id").primaryKey({ autoIncrement: true }),
//     title: text("title").notNull(),
//     done: integer("done", { mode: "boolean" }).notNull().default(false),
//   });
//
// Rules:
// - Migrations must only ADD tables or columns. Never drop or rename:
//   user data lives in this database across versions.
// - After changing the schema, run `bun run db:generate` to create a
//   migration, then `bun run db:migrate` (or restart) to apply it.
export {};
