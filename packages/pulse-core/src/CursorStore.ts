/**
 * Pluggable cursor persistence interface for Orbital event sources.
 *
 * @module CursorStore
 *
 * @description
 *
 * The `CursorStore` interface enables resumable event streams by persisting
 * the cursor position across process restarts. Each event source (Horizon, Soroban RPC)
 * maintains an independent cursor.
 *
 * **Key concepts:**
 *
 * - **Cursor formats are source-specific and opaque.** Horizon cursors are numeric strings
 *   (paging_tokens); Soroban RPC cursors are base64-encoded. See {@link ../docs/cursor-format.md}
 *   for the full specification and worked examples.
 *
 * - **Cursors are comparable only within a source.** Do not compare Horizon cursors to
 *   Soroban cursors; they use different numbering schemes and advance independently.
 *   See {@link ../docs/cursor-format.md#cross-source-comparability} for details.
 *
 * - **Storage is opaque.** Implementations (Redis, Postgres, S3, file, in-memory) are
 *   free to store cursors however they choose, as long as retrieval is accurate.
 *
 * - **Atomicity is not required.** Each `get()` and `set()` is independent; however,
 *   implementations may choose to provide atomic swaps for audit correctness.
 *
 * @example
 *
 * **In-memory implementation (default):**
 *
 * ```typescript
 * const defaultStore: CursorStore = {
 *   async get(source: "horizon" | "soroban", identifier: string) {
 *     // Returns undefined on first run
 *     return cursors.get(`${source}:${identifier}`);
 *   },
 *   async set(source: "horizon" | "soroban", identifier: string, cursor: string) {
 *     cursors.set(`${source}:${identifier}`, cursor);
 *   },
 * };
 * ```
 *
 * **Postgres implementation:**
 *
 * ```typescript
 * const postgresStore: CursorStore = {
 *   async get(source, identifier) {
 *     const row = await pool.query(
 *       "SELECT cursor FROM orbital_cursors WHERE source = $1 AND identifier = $2",
 *       [source, identifier]
 *     );
 *     return row.rows[0]?.cursor;
 *   },
 *   async set(source, identifier, cursor) {
 *     await pool.query(
 *       `INSERT INTO orbital_cursors (source, identifier, cursor)
 *        VALUES ($1, $2, $3)
 *        ON CONFLICT (source, identifier) DO UPDATE SET cursor = $3`,
 *       [source, identifier, cursor]
 *     );
 *   },
 * };
 * ```
 *
 * **Redis implementation:**
 *
 * ```typescript
 * const redisStore: CursorStore = {
 *   async get(source, identifier) {
 *     return redis.get(`orbital:cursor:${source}:${identifier}`);
 *   },
 *   async set(source, identifier, cursor) {
 *     await redis.set(`orbital:cursor:${source}:${identifier}`, cursor);
 *   },
 * };
 * ```
 *
 * @see {@link ../docs/cursor-format.md} — Complete cursor format specification with examples
 * @see {@link ../docs/ARCHITECTURE.md#10-phase-1-evolution} — Cursor persistence design rationale
 * @see {@link ../README.md#current-limitations} — Cursor roadmap (Phase 1)
 *
 */

/**
 * Pluggable interface for storing and retrieving cursor positions.
 *
 * Implementations must handle two distinct cursor sources:
 *
 * - **"horizon"**: Numeric string paging_tokens from Horizon operations API.
 *   Example: `"123456789012345"` (see {@link ../docs/cursor-format.md#horizon-cursor-format})
 *
 * - **"soroban"**: Base64-encoded opaque cursors from Stellar RPC for contract events.
 *   Example: `"AAABgEAAABg="` (see {@link ../docs/cursor-format.md#soroban-rpc-cursor-format})
 *
 * **Atomicity guarantee:** Not required. Each get/set is independent. If your persistence
 * layer supports transactions, you may choose to use them for audit correctness, but it
 * is not a strict requirement for the interface contract.
 *
 * **Error handling:** Implementations should throw on persistent errors (network timeout,
 * disk full) but may return `undefined` for "not found" cases (first run). The engine
 * gracefully handles `undefined` by starting from `"now"`.
 *
 */
export interface CursorStore {
  /**
   * Retrieve the cursor for a given source and identifier.
   *
   * @param source - Event source type: `"horizon"` or `"soroban"`
   * @param identifier - Address (for Horizon) or contract ID (for Soroban)
   * @returns The cursor string, or `undefined` if no prior cursor exists (first run)
   *
   * @remarks
   *
   * - **Horizon example:** `get("horizon", "GABC...1234")` returns `"123456789012345"` or `undefined`
   * - **Soroban example:** `get("soroban", "CA...")` returns `"AAABgEAAABg="` or `undefined`
   *
   * Do not attempt to parse or interpret the cursor value. Return it exactly as stored.
   *
   * See {@link ../docs/cursor-format.md} for the complete format specification.
   *
   */
  get(source: "horizon" | "soroban", identifier: string): Promise<string | undefined>;

  /**
   * Store the cursor for a given source and identifier.
   *
   * @param source - Event source type: `"horizon"` or `"soroban"`
   * @param identifier - Address (for Horizon) or contract ID (for Soroban)
   * @param cursor - The cursor string from the event source
   *
   * @remarks
   *
   * - **Horizon example:** `set("horizon", "GABC...1234", "123456789012346")`
   * - **Soroban example:** `set("soroban", "CA...", "AAABgEAABA==")`
   *
   * Do not parse, mutate, or normalize the cursor. Store it exactly as received.
   * Implementations may validate format (e.g., reject obviously invalid strings),
   * but the engine is responsible for correctness.
   *
   * If a cursor already exists for this source/identifier pair, overwrite it.
   * Implementations may use an upsert pattern or a separate insert/update.
   *
   * See {@link ../docs/cursor-format.md#adapter-implementation-checklist}
   * for validation and auditing patterns.
   *
   */
  set(
    source: "horizon" | "soroban",
    identifier: string,
    cursor: string
  ): Promise<void>;
}

/**
 * Configuration for attaching a cursor store to the EventEngine (Phase 1 feature).
 *
 * @example
 *
 * ```typescript
 * import { EventEngine } from "@orbital/pulse-core";
 *
 * const engine = new EventEngine({
 *   network: "mainnet",
 *   cursorStore: postgresStore, // Implements CursorStore
 * });
 *
 * engine.start(); // Resumes from stored cursor; starts from "now" if not found
 * ```
 *
 * When `cursorStore` is provided, the engine automatically:
 *
 * 1. Calls `get("horizon", address)` on subscribe to retrieve the last cursor
 * 2. Resumes the Horizon stream from that cursor
 * 3. On each event, calls `set("horizon", address, cursor)` to persist
 * 4. Repeats for Soroban subscriptions with `get/set("soroban", contractId)`
 *
 * This enables crash-resilient streams and webhook replay without duplicates.
 *
 */
export type CursorStoreConfig = {
  /**
   * The cursor store implementation.
   *
   * If omitted, the engine uses an in-memory store (current behavior),
   * so cursors are lost on process restart. For production, supply a durable
   * implementation: Redis, Postgres, S3, or custom.
   *
   */
  cursorStore?: CursorStore;
};
