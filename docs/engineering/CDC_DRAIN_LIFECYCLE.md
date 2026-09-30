# CDC drain lifecycle — authoritative state machine (STEP 24)

Established from the implementation (`src/connectors/postgres/cdc-apply.js`,
`src/daemon/command-service.js`, `src/protocol/migration-state-machine.js`)
before the drain-hang fix, per execution-prompt section 13. This document is
the contract the fix and its regression tests bind to.

## 1. Migration-level lifecycle (canonical, `MIGRATION_STATES`)

CDC capture/catch-up/drain are phases of the durable migration state machine
(`src/protocol/migration-state-machine.js`), never ad-hoc flags:

```
... -> FULL_LOAD_RUNNING -> CDC_RUNNING -> CATCHING_UP -> VERIFYING
    -> READY_FOR_CUTOVER -> CUTOVER_ARMED -> FINAL_DRAIN -> FINAL_VERIFY
    -> CUTOVER_COMMITTED -> POST_CUTOVER_VERIFY -> COMPLETED
```

Conceptual drain sequence (execution-prompt section 13) maps onto these
actual names:

| Conceptual step | SPOOL actual state / event |
| --- | --- |
| CAPTURING | `CDC_RUNNING` / `CATCHING_UP` (stream attached, checkpoint advancing) |
| DRAIN_REQUESTED | `catchUpCdc(request, { untilLsn })` or cutover entering `FINAL_DRAIN` |
| STOP_ACCEPTING_NEW_SOURCE_WORK | source write-barrier `SHARE` lock held (`POSTGRES_TABLE_SHARE_LOCK`); waterline sampled from `sourceLockBarrier.finalLsn` (or `pg_current_wal_flush_lsn()`) |
| APPLY_IN_FLIGHT_TRANSACTIONS | pump dequeues, `assembler.feed` completes transactions, one fenced target commit per source transaction |
| PERSIST_DURABLE_CHECKPOINT | `checkpoint.save` (CAS, fenced) strictly BEFORE any source acknowledgement |
| ACKNOWLEDGE_SUPPORTED_SOURCE_POSITION | batched `service.acknowledge` after durability (`serverAck`) |
| VERIFY_DRAIN_WATERMARK | `idleStopReached()` / `shouldStop()` true: waterline seen, queue empty, no open transaction |
| DRAINED | `applier.run()` returns `{ finished: true, resumeLsn }`; cutover proceeds to `FINAL_VERIFY` |

Failure exits (canonical): every drain phase may fail closed to
`FAILED_RECOVERABLE` (with a `reason` naming why) or `FAILED_OPERATOR_REQUIRED`;
cutover attempts additionally exit via `ABORTED` (re-arm with fresh attempt
identity). There is intentionally no success path that bypasses the watermark
check.

## 2. Drain micro-lifecycle (pump, `subscribeAndPump`)

1. **SUBSCRIBING** — `service.subscribe(pgoutput, slot, fromLsn)`; stream must
   emit `start` within `SUBSCRIBE_START_TIMEOUT_MS` (30 s) or the drain fails
   `CDC_SUBSCRIBE_TIMEOUT`/`CDC_SUBSCRIBE_FAILED`. Never an unbounded wait.
2. **STREAMING** — `data` messages enqueue (backpressure parks the producer
   when full; messages are never dropped), `heartbeat` events (server
   keepalives) track the server WAL position, `error` breaks the loop.
3. **APPLYING** — one transaction at a time: assemble -> fenced target commit
   -> durable checkpoint (CAS) -> batched server ack. Ack never precedes
   durability.
4. **WATERLINE_WAIT** — queue empty:
   - `shouldStop(tx)`: a committed transaction reached `untilLsn` (or
     `maxTransactions` reached) -> `DRAINED`.
   - `idleStopReached()`: `maxSeenLsn >= untilLsn` (heartbeat-carried), queue
     empty, assembler closed -> `DRAINED`. A quiesced source is terminated by
     keepalives, never by a guessed timeout.
   - resume guard: if the durable resume position is already `>= untilLsn`,
     return immediately without subscribing (drain retry on an idle source).
5. **DRAINED** or **failure** (`CDC_*` transport/apply errors, or
   `DRAIN_BLOCKED` — see section 4).

Stream-end rule (added with the fix): the `subscribe()` promise settles only
when replication ENDS. A clean end without an `error` event (server closed
the connection quietly) would previously leave the pump waiting for messages
that can no longer arrive; the pump now treats it as stream failure
(`CDC_STREAM_ENDED`) so the existing reconnect/terminal classification
decides — an unbounded wait after stream end is exactly the hang class the
section-13 rules forbid. Unbounded capture therefore ends only on stream
failure, never on the stall watchdog.

Bounded vs unbounded: `untilLsn != null || maxTransactions != null` is a
**bounded drain** (must terminate). `untilLsn == null && maxTransactions ==
null` is continuous capture (waiting indefinitely for new changes is correct
behavior and is not subject to the stall watchdog).

## 3. Invariants (must remain true)

1. Ack after durable checkpoint, always (crash replays; ledger reconciles).
2. Never stop over unapplied work: idle termination requires empty queue AND
   closed assembler AND waterline seen.
3. No success without the watermark: a timeout can never convert an
   unresolved drain into `finished: true`.
4. Retry resumes from the durable watermark, never re-applies blindly.
5. Mixed-revision/impossible waterlines fail closed; no silent coercion.

## 4. Root cause of the hang class, and the explicit failure state (STEP 23/25)

The pump's wait branch (`queue.length === 0` -> `await notified`) was the
only unbounded wait in the drain path: if the stream produced **no data, no
completing transaction, and no terminating heartbeat** (silently stalled
transport, an assembler transaction that never completes, or an unreachable
waterline), the drain waited forever with no error, no state change, and no
explanation. (The scratch repro of the original session hang no longer
reproduces on this branch — see `QUALIFICATION_EVIDENCE.md` R9 — but the
unbounded wait remained a live hang class.)

Section 13 requirement, now enforced:

- A **no-progress watchdog** bounds every *bounded* drain:
  `drainStallTimeoutMs` (default `DRAIN_STALL_TIMEOUT_MS = 60_000`, API floor
  1000 ms, applier floor 100 ms). Progress = source data received or a
  transaction applied; heartbeats alone do not reset it (they only feed the
  watermark check, which itself terminates healthy drains within one keepalive
  interval).
- On expiry the drain fails **`DRAIN_BLOCKED`** — an explicit failure, never
  a success — carrying the section-13 capture set:

  | Section 13 field | `DRAIN_BLOCKED` detail |
  | --- | --- |
  | last captured source position | `lastCapturedPosition` (max seen incl. heartbeats) + `waterline` |
  | last queued transaction | `lastQueuedTransaction` (lsn/tag) + `queueDepth` |
  | last applied transaction | `lastAppliedPosition`, `appliedTransactions` |
  | last durable checkpoint | `durableCheckpoint` (reloaded at failure) |
  | last acknowledged source position | `lastAcknowledgedPosition` |
  | worker state | `streamState`, `openTransaction`, `reconnects`, `receivedMessages`, `stalledMs`, `drainStallTimeoutMs` |
  | write-barrier / cutover state | durable `phase` (`FINAL_DRAIN`/`CUTOVER_ARMED` vs catch-up) + `cutoverStatus`/`cutoverAttemptId` recorded by the command layer |
  | active connection state | `slotName`, `resumeLsn`, `reconnects`, `streamState` |

- The command layer (`#applyCdcToWaterline`, the single choke point shared by
  `catchUpCdc` and cutover `FINAL_DRAIN`) durably transitions the migration
  to **`FAILED_RECOVERABLE`** with `reason: 'DRAIN_BLOCKED'` and the capture
  set as transition evidence, then rethrows the original error. The operator
  sees exactly why progress stopped, in both the error and the durable
  transition record; recovery follows the canonical
  `FAILED_RECOVERABLE -> RECOVERY_PENDING` path.

Why `FAILED_RECOVERABLE` and not terminal `FAILED_OPERATOR_REQUIRED`: the
failure is operator-actionable but recoverable through the model's explicit
recovery path, and the state machine offers no terminal-state exit. The
`reason`/evidence — not the state name — carries the "why".

## 5. Known gap (registered H-05, out of scope for STEPS 23-26)

The stall watchdog runs in the pump's **empty-queue wait branch**. A
bounded drain whose *target apply* blocks indefinitely (for example the
target table is locked by another session) keeps the queue non-empty: the
pump sits inside `await applyOneTransaction(...)` where no watchdog check
executes, so that specific blocking class is not bounded by
`drainStallTimeoutMs`. This is a pre-existing class, distinct from the
silent-stream/unreachable-waterline hang fixed above (the reported defect:
there the queue was empty and the wait branch ran). It is registered as
H-05 rather than papered over; a future fix must bound it without a
background timer racing an in-flight target commit.
