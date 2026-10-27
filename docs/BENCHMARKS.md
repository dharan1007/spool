# SPOOL Benchmarks

Generated: 2026-10-27T12:00:04.691Z
Suite: SPOOL-Bench v1

## Deterministic migration engine

| Rows | CSV parse | Transform + target validation | Rows/sec | Valid | Invalid |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 16.11 ms | 38.39 ms | 26,050 | 999 | 1 |
| 10,000 | 68.41 ms | 229.64 ms | 43,547 | 9,982 | 18 |
| 50,000 | 193.86 ms | 1065.33 ms | 46,934 | 49,910 | 90 |

## Content verification (exact row-hash projection)

| Rows | Verify | Rows/sec |
|---:|---:|---:|
| 1,000 | 319.24 ms | 3,132 |
| 10,000 | 1989.58 ms | 5,026 |

## Merkle trees (root + inclusion proof + verify)

| Leaves | Root/prove/verify | Leaves/sec |
|---:|---:|---:|
| 1,000 | 53.38 ms | 18,733 |
| 10,000 | 507.86 ms | 19,690 |

## Repair plans (DIFF evidence to hash-bound operations)

| Missing rows | Operations | Plan build |
|---:|---:|---:|
| 10 | 10 | 8.75 ms |
| 100 | 100 | 23.46 ms |

## SQLite end-to-end (fenced ledger-backed batches)

| Rows | Write | Rows/sec |
|---:|---:|---:|
| 1,000 | 188.13 ms | 5,315 |
| 10,000 | 1409.21 ms | 7,096 |

## Release integrity (signed envelope + canonical evidence)

| Operation | Ops/sec |
|---:|---:|
| Signed envelope creation | 3,968 |
| Signed envelope verification | 3,338 |
| Canonical evidence list hashing | 1,59,563 |

## Temporal WebMCP surface

A permanent surface across the measured phases contains **23 tools** / **8,101 serialized definition bytes**. SPOOL exposes **4.75 tools** / **1,738 bytes on average**, reducing active tool count by **79.3%** and serialized definition bytes by **78.6%** for this tool set.

| Phase | Active tools | Definition bytes |
|---|---:|---:|
| EMPTY | 2 | 642 |
| SOURCE_READY | 6 | 2,606 |
| TARGET_READY | 4 | 1,536 |
| MAPPING_DRAFT | 5 | 1,815 |
| MAPPING_VALID | 5 | 1,919 |
| RUNNING | 4 | 1,373 |
| PAUSED | 6 | 2,196 |
| COMPLETE | 6 | 1,813 |

> These are local deterministic engine and serialized-schema measurements. They are not claims about universal model success rate, tokenization, or browser-agent performance.
