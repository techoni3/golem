import { z } from "zod";

/** JSON-only payload boundary: rejects Date, Map, Set, functions, bigint, and NaN. */
export const JsonValueSchema = z.json();
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

export type JsonValue = z.infer<typeof JsonValueSchema>;
export type JsonObject = z.infer<typeof JsonObjectSchema>;
