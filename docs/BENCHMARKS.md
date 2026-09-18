# SPOOL Benchmarks

Generated: 2026-09-18T05:06:13.559Z
Suite: SPOOL-Bench v1

## Deterministic migration engine

| Rows | CSV parse | Transform + target validation | Rows/sec | Valid | Invalid |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 11.31 ms | 33.8 ms | 29,586 | 999 | 1 |
| 10,000 | 95.64 ms | 274.58 ms | 36,420 | 9,982 | 18 |
| 50,000 | 295.89 ms | 1241.27 ms | 40,281 | 49,910 | 90 |

## Content verification (exact row-hash projection)

| Rows | Verify | Rows/sec |
|---:|---:|---:|
| 1,000 | 326.28 ms | 3,065 |
| 10,000 | 2152.59 ms | 4,646 |

## Merkle trees (root + inclusion proof + verify)

| Leaves | Root/prove/verify | Leaves/sec |
|---:|---:|---:|
| 1,000 | 63.49 ms | 15,751 |
| 10,000 | 603.75 ms | 16,563 |

## Repair plans (DIFF evidence to hash-bound operations)

| Missing rows | Operations | Plan build |
|---:|---:|---:|
| 10 | 10 | 6 ms |
| 100 | 100 | 13.11 ms |

## SQLite end-to-end (fenced ledger-backed batches)

| Rows | Write | Rows/sec |
|---:|---:|---:|
| 1,000 | 24.01 ms | 41,655 |
| 10,000 | 220.35 ms | 45,383 |

## Release integrity (signed envelope + canonical evidence)

| Operation | Ops/sec |
|---:|---:|
| Signed envelope creation | 2,173 |
| Signed envelope verification | 2,719 |
| Canonical evidence list hashing | 1,87,707 |

## Temporal WebMCP surface

A permanent surface across the measured phases contains **23 tools** / **8,018 serialized definition bytes**. SPOOL exposes **4.75 tools** / **1,665 bytes on average**, reducing active tool count by **79.3%** and serialized definition bytes by **79.2%** for this tool set.

| Phase | Active tools | Definition bytes |
|---|---:|---:|
| EMPTY | 2 | 642 |
| SOURCE_READY | 6 | 2,523 |
| TARGET_READY | 4 | 1,453 |
| MAPPING_DRAFT | 5 | 1,732 |
| MAPPING_VALID | 5 | 1,836 |
| RUNNING | 4 | 1,290 |
| PAUSED | 6 | 2,113 |
| COMPLETE | 6 | 1,730 |

> These are local deterministic engine and serialized-schema measurements. They are not claims about universal model success rate, tokenization, or browser-agent performance.
