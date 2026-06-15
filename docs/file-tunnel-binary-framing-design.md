# WS File-Tunnel Binary Framing Design (P1-12)

> Status: **Implemented**. Steps 1-7 of the file-by-file change list below are live:
> `packages/shared/src/file-tunnel-codec.ts` provides `encodeFileChunkFrame`/
> `decodeFileChunkFrame`, the desktop sender (`apps/desktop/src/main/ws-client/file-tunnel.ts`)
> sends non-empty chunks as binary WS frames via `RelayClient.sendRaw()`
> (`apps/desktop/src/main/ws-client/client.ts`), and the relay
> (`apps/server/src/ws/handler.ts` + `ws/file-tunnel.ts` + `routes/proxy.ts`) decodes them
> via `resolveFileTunnelBinaryFrame` alongside the unchanged legacy JSON path — see
> "Backward/forward compatibility" below. The formalized result is documented in
> `docs/adr/ADR-004-file-tunnel-framing.md`. Covered by
> `packages/shared/test/file-tunnel-codec.test.ts` (7 unit tests) and three new
> `apps/server/test/session-flows.test.ts` cases (full download / Range download / preview
> over the binary path). Step 8's large-payload CPU/allocation timing benchmark was not
> added — the functional-correctness tests above substitute for it.
>
> Originally scoped from the P1-12 finding in `.full-review/05-final-report.md` ("WS file
> tunnel's base64 chunking costs ~2.3x allocations per 256KB chunk — for a 500MB transfer,
> ~1s of blocking CPU on the Electron main process (plus symmetric cost on the relay).
> Memory stays bounded (4MB backpressure design is correct); this is a CPU/allocation
> finding only."), evolving the design previously documented inline in CLAUDE.md as
> "ADR-004". Feasibility was confirmed against the installed `ws@^8.17.0` on both
> `apps/desktop` and `apps/server`, which supports `(data, isBinary)` on the `message` event
> and binary `send()` for `Buffer` payloads.

## Problem

`apps/desktop/src/main/ws-client/file-tunnel.ts` (the `CMD_FETCH_FILE` handler) currently
sends each 256KB chunk as:

```ts
client.send({
  type: 'RESP_FILE_CHUNK',
  payload: { transferId, seq, data: chunk.toString('base64'), eof, ...meta },
});
```

i.e. `Buffer (256KB) → base64 string (~341KB) → JSON.stringify` (the whole envelope, another
string/copy). On receive, `apps/server/src/ws/handler.ts` does `JSON.parse`, then
`apps/server/src/routes/proxy.ts::tunnelFromHost`'s `onChunk` does
`Buffer.from(chunk.data, 'base64')` to write into the HTTP response. That's
encode → stringify → parse → decode per chunk — ~2.3x allocation overhead, ~1s cumulative
blocking CPU for a 500MB transfer (≈1953 chunks at 256KB), on **both** the desktop main
process and the relay.

## Design: self-describing binary WS frames

Each non-empty chunk becomes a single **binary** WS frame: a small fixed-format header
(transferId, seq, eof flag, and — only on `seq===0` — the existing first-frame metadata:
totalSize/rangeStart/rangeEnd/contentType/fileName) immediately followed by the raw chunk
bytes. One `Buffer.concat([header, chunk])`, one `ws.send(buffer)` (binary auto-detected for
`Buffer` payloads in `ws`).

### Why self-describing, not "JSON header frame + binary payload frame" pair

A single Host connection can have **multiple concurrent file transfers** in flight (e.g.
two simultaneous proxy downloads from the same Host). `file-tunnel.ts`'s per-transfer loop
awaits backpressure (`sleep(BACKPRESSURE_POLL_MS)`) and stream reads — both are yield points
where another transfer's handler can interleave its own sends. A "send a JSON metadata
frame, then send the raw binary payload as the very next message" scheme breaks under that
interleaving (transfer B's frames could land between transfer A's pair, and the receiver
would pair them wrongly). Embedding `transferId`+`seq`+`eof`(+optional meta) directly in
*every* binary frame's header makes each frame independently routable regardless of
interleaving — no ordering assumption beyond what TCP/WS already guarantees per-frame.

### Wire format (new shared codec)

New module `packages/shared/src/file-tunnel-codec.ts`, imported by both `apps/desktop`
(encode) and `apps/server` (decode):

```
[0]       version (uint8)        = 1
[1]       flags (uint8)          bit0 = eof, bit1 = hasMeta (true iff seq === 0)
[2-3]     transferIdLen (uint16 BE)
[...]     transferId              (ASCII, length = transferIdLen)
[+0..3]   seq (uint32 BE)
-- if hasMeta:
[+0..7]   totalSize  (uint64 BE)
[+8..15]  rangeStart (uint64 BE)
[+16..23] rangeEnd   (uint64 BE)
[+24-25]  contentTypeLen (uint16 BE) + contentType bytes (UTF-8)
[+.. -..] fileNameLen (uint16 BE)    + fileName bytes (UTF-8)
-- remaining bytes: chunk payload
```

`encodeFileChunkFrame(meta, chunk: Buffer): Buffer` /
`decodeFileChunkFrame(buf: Buffer): DecodedFileChunkFrame` — both pure functions,
unit-testable in `packages/shared` without a live WS connection.

The existing **empty-file case** (`totalSize === 0`, single JSON `RESP_FILE_CHUNK` with
`data: '', eof: true`) is unchanged — no binary frame needed for a zero-byte transfer.

## Backward/forward compatibility (important given P1-23: no desktop auto-update)

Because `ws`'s `message` event reports `isBinary`, the relay can support **both** formats
simultaneously with no version negotiation:

- `isBinary === true` → new codec → `resolveFileTunnelBinaryFrame(decoded)`
- `isBinary === false` → existing `JSON.parse` → existing `resolveFileTunnelMessage`
  (legacy base64 `RESP_FILE_CHUNK`)

Both paths normalize into the same internal shape (`data: Buffer` always — the legacy path
still does one `Buffer.from(base64)`, same as today) so
`routes/proxy.ts::tunnelFromHost` needs **no branching**: `raw.write(chunk.data)` either
way.

**Rollout**: ship the relay change first (adds binary support, keeps the JSON path
indefinitely as the fallback for not-yet-updated Hosts). Desktop builds can update on
whatever cadence; old Hosts keep working via the legacy path with no forced cutover date.
If the legacy path is ever removed, document it as a deliberate major-version change in
`CHANGELOG.md`, not a silent drop — tunnel frames are relay↔host only (never forwarded to
clients), so this is entirely an operator-facing compatibility concern, not a client-facing
one.

## File-by-file change list

1. `packages/shared/src/file-tunnel-codec.ts` (new) — `encodeFileChunkFrame` /
   `decodeFileChunkFrame` + `DecodedFileChunkFrame` type.
2. `packages/shared/src/ws-types.ts` — document the binary wire format alongside
   `RespFileChunkPayload` (which remains the legacy/JSON type, unchanged).
3. `apps/desktop/src/main/ws-client/client.ts` — add
   `sendRaw(buffer: Buffer): boolean` (mirrors `send()`'s `readyState` check,
   `this.ws.send(buffer)`).
4. `apps/desktop/src/main/ws-client/file-tunnel.ts` — for non-empty chunks,
   `client.sendRaw(encodeFileChunkFrame(meta, chunk))` instead of the JSON+base64
   `client.send(...)`. Remove `.toString('base64')` (line 116) and the
   "256KB 原始数据 → base64 后约 341KB/帧" comment (line 14).
5. `apps/server/src/ws/handler.ts` — `socket.on('message', (data, isBinary) => { if
   (isBinary) { ...decode, resolveFileTunnelBinaryFrame...; return; } /* existing
   JSON.parse path */ })`.
6. `apps/server/src/ws/file-tunnel.ts` — add `resolveFileTunnelBinaryFrame(decoded)`,
   sharing the `transfers` registry/timer logic with the existing
   `resolveFileTunnelMessage`; both normalize to `data: Buffer`.
7. `apps/server/src/routes/proxy.ts` — `tunnelFromHost`'s `onChunk`: `raw.write(chunk.data)`
   (already a `Buffer` after step 6) instead of `Buffer.from(chunk.data, 'base64')`.
8. Tests: extend `apps/server/test/manual-file-tunnel.mjs` (and/or its vitest equivalent in
   `relay-roundtrip.test.ts`) with a binary-frame case; add a large-payload (e.g. 20-50MB)
   timing assertion to demonstrate the CPU/allocation improvement.

## Out of scope

Every other WS message type (CMD_*, MSG_TEXT, PING/PONG, etc.) stays JSON — this only
touches `RESP_FILE_CHUNK`'s wire representation. `RESP_FILE_ERROR` stays JSON (rare, no
perf concern).

## Effort estimate

Medium — steps 1-7 are one cohesive change (≈ a day of implementation). Step 8 (testing/
benchmarking) is where most of the "needs research" time goes: needs a real multi-MB test
fixture and a way to measure CPU time before/after to substantiate the report's "~1s for
500MB" estimate against this fix.
