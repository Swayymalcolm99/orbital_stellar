# Cursor Formats

Each event source in Orbital uses a cursor mechanism to track position within its event stream, enabling resume-from-cursor functionality after process restarts. While cursors are **opaque to end consumers**, this document specifies the format for adapter authors, migration tooling, and auditing scenarios.

## Horizon Cursor Format

### Format Specification

Horizon cursors are called **`paging_token`** and represent a position in the classic operations stream. The format is a **numeric string** representing a 64-bit ledger-sequence-derived index.

**Canonical form:** A decimal integer as a string, e.g., `"123456789012345"`.

**Characteristics:**
- Pure ASCII digits (0–9)
- No leading zeros (except for `"0"`)
- Derived from ledger sequence and operation index within that ledger
- Increases monotonically across the stream

### Worked Example

Suppose you subscribe to account `GABC...1234` on testnet starting from `"now"`:

```typescript
import { EventEngine } from "@orbital/pulse-core";

const engine = new EventEngine({ network: "testnet" });
const watcher = engine.subscribe("GABC...1234");

watcher.on("payment.received", (event) => {
  // event.cursor (a Horizon paging_token) is opaque but safe to persist.
  console.log("Payment received", event.cursor); // Output: "123456789012345"
});

engine.start();
```

When Horizon returns a stream of operations for this address, each record carries a paging_token in its response headers. For example:

```json
{
  "id": "123456789012345",
  "paging_token": "123456789012345",
  "type_i": 1,
  "type": "payment",
  "created_at": "2026-05-31T10:30:00Z",
  "transaction_hash": "abc...",
  "from": "GABC...1234",
  "to": "GXYZ...5678",
  "amount": "100.0000000",
  "asset_type": "native"
}
```

The `paging_token` value (`"123456789012345"`) is the cursor. On reconnect with a saved cursor:

```typescript
// Resume from saved cursor instead of "now"
const engine = new EventEngine({
  network: "testnet",
  cursorStore: myPersistenceAdapter, // Phase 1 feature
});
engine.start(); // Resumes from the saved paging_token
```

### Lexical Ordering

Horizon paging_tokens are **lexically ordered**: if you sort two tokens as strings, their order matches their position in the stream.

```typescript
const token1 = "123456789012344";
const token2 = "123456789012345";

// Lexical comparison works:
console.log(token1 < token2); // true — token1 comes before token2 in the stream
```

This property holds because paging_tokens are zero-padded decimal numbers.

## Soroban RPC Cursor Format

### Format Specification

Soroban RPC cursors are returned by the Stellar RPC server for contract event subscriptions. The format is a **base64-encoded opaque string** with no guaranteed internal structure.

**Canonical form:** A base64 string, e.g., `"AAABgEAAABg="` or `"AAAAHgAAA..."` (length varies).

**Characteristics:**
- Valid base64 (RFC 4648)
- May decode to binary data; consumers should treat decoded form as an implementation detail
- Provided by the RPC server; do not construct or mutate
- Increases monotonically across the event stream

### Worked Example

Suppose you subscribe to contract events via Soroban RPC (Phase 1 feature, planned for `v1.0`):

```typescript
import { EventEngine } from "@orbital/pulse-core";

const engine = new EventEngine({
  network: "mainnet",
  soroban: {
    rpcUrl: "https://soroban-rpc.your-node.example.com",
  },
});

const watcher = engine.subscribeContract({
  contractId: "CA...",
  topics: ["transfer"],
});

watcher.on("contract.emitted", (event) => {
  // event.cursor is a Soroban RPC cursor (opaque).
  console.log("Contract event", event.cursor); // Output: "AAABgEAAABg="
});

engine.start();
```

When the Soroban RPC server streams contract events, it includes a cursor in each response:

```json
{
  "id": "ca...",
  "type": "contract",
  "contractId": "CA...",
  "topic": ["transfer"],
  "ledger": 50000000,
  "cursor": "AAABgEAAABg=",
  "txHash": "abc...",
  "data": "..."
}
```

The `cursor` value (`"AAABgEAAABg="`) is the Soroban RPC cursor. On reconnect:

```typescript
// Resume from saved Soroban cursor (Phase 1 feature)
const engine = new EventEngine({
  network: "mainnet",
  soroban: {
    rpcUrl: "https://soroban-rpc.your-node.example.com",
  },
  cursorStore: myPersistenceAdapter, // Stores per-source cursors
});
engine.start(); // Resumes from the saved Soroban RPC cursor
```

### Lexical Ordering

Soroban RPC cursors are **also lexically ordered** for convenience, but this is an implementation detail. Do not rely on it for correctness; always use the cursor returned by the server.

```typescript
// Lexical ordering may work but is not guaranteed:
const token1 = "AAABgEAAABg=";
const token2 = "AAABgEAABA==";

// Comparison may work but is not part of the contract
console.log(token1 < token2); // Implementation-dependent
```

## Cross-Source Comparability

### Key Guarantee

**Cursors are comparable only within a single source.** Comparing a Horizon cursor to a Soroban RPC cursor is meaningless.

```typescript
// ❌ DO NOT DO THIS
const horizonCursor = "123456789012345";
const sorobanCursor = "AAABgEAAABg=";

if (horizonCursor < sorobanCursor) {
  // This comparison is nonsensical
}
```

### Why?

- **Horizon** uses a numeric ledger-sequence-derived format
- **Soroban RPC** uses a base64-encoded opaque format
- Each source advances independently; they may progress at different rates
- Ledger numbers and RPC cursors do not have a fixed relationship

### Correct Usage

If you manage multiple sources, store cursors **separately by source**:

```typescript
type SourceCursors = {
  horizon?: string;
  soroban?: string;
};

const cursors: SourceCursors = {};

// From Horizon
watcher.on("payment.received", (event) => {
  cursors.horizon = event.cursor; // Store Horizon cursor separately
});

// From Soroban
sorobanWatcher.on("contract.emitted", (event) => {
  cursors.soroban = event.cursor; // Store Soroban cursor separately
});

// On reconnect, restore from the appropriate source
if (cursors.horizon) {
  horizonEngine.resume(cursors.horizon); // ✅
}
if (cursors.soroban) {
  sorobanEngine.resume(cursors.soroban); // ✅
}
```

## Adapter Implementation Checklist

For authors implementing cursor persistence (Redis, Postgres, S3, etc.):

- [ ] **Accept both formats:** Horizon (numeric string) and Soroban RPC (base64)
- [ ] **Store as-is:** Do not parse, mutate, or normalize cursors
- [ ] **Preserve type:** Use a `source` field to track which source each cursor came from
- [ ] **Validate format:** Reject cursors that don't match the expected pattern for their source
- [ ] **Document source field:** Clearly state that cursor values are only comparable within the same source
- [ ] **Test round-trip:** Verify that a saved cursor can be used to resume without duplication or loss

### Example: Postgres Adapter

```sql
-- Schema for cursor persistence
CREATE TABLE orbital_cursors (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL,        -- 'horizon' or 'soroban'
  address_or_contract TEXT NOT NULL,
  cursor TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ON orbital_cursors(source, address_or_contract);
```

```typescript
// Implementation pattern
async function saveCursor(
  source: "horizon" | "soroban",
  identifier: string, // address for Horizon, contractId for Soroban
  cursor: string
): Promise<void> {
  // Validate format before storing
  if (source === "horizon" && !/^\d+$/.test(cursor)) {
    throw new Error(`Invalid Horizon cursor format: ${cursor}`);
  }
  if (source === "soroban" && !/^[A-Za-z0-9+/=]+$/.test(cursor)) {
    throw new Error(`Invalid Soroban cursor format: ${cursor}`);
  }

  await db.query(
    `INSERT INTO orbital_cursors (source, address_or_contract, cursor)
     VALUES ($1, $2, $3)
     ON CONFLICT (source, address_or_contract)
     DO UPDATE SET cursor = $3, updated_at = NOW()`,
    [source, identifier, cursor]
  );
}
```

## Migration and Auditing

### Migrating Between Adapters

When moving from one cursor store to another (e.g., file → Postgres):

1. Export all cursors from the old store, including source metadata
2. Validate each cursor against its source format
3. Import into the new store, preserving source field
4. Test resume-from-cursor to verify no duplication or loss

### Auditing Cursor Chains

To audit whether a cursor chain is valid:

1. Query the persistence store for all cursors for a given source + address/contract
2. Verify each is a valid cursor string for that source
3. Spot-check by replaying from a mid-stream cursor and comparing event ordering

### Cross-Source Audit Pattern

```typescript
async function auditCursors(store: CursorStore): Promise<AuditReport> {
  const horizonCursors = await store.getAllBySource("horizon");
  const sorobanCursors = await store.getAllBySource("soroban");

  const report = {
    horizon: {
      count: horizonCursors.length,
      valid: horizonCursors.every(c => /^\d+$/.test(c.cursor)),
      issues: [] as string[],
    },
    soroban: {
      count: sorobanCursors.length,
      valid: sorobanCursors.every(c => /^[A-Za-z0-9+/=]+$/.test(c.cursor)),
      issues: [] as string[],
    },
  };

  // Additional checks...
  return report;
}
```

## Related Documents

- [`docs/ARCHITECTURE.md` § 10 Phase 1 evolution](./ARCHITECTURE.md#10-phase-1-evolution) — cursor persistence design
- [`packages/pulse-core/src/CursorStore.ts`](../packages/pulse-core/src/CursorStore.ts) — pluggable interface (Phase 1)
- [`packages/pulse-core/README.md` § Current limitations](../packages/pulse-core/README.md#current-limitations) — cursor roadmap
