# SPOOL Benchmarks

Generated: 2026-10-27T07:56:24.150Z
Suite: SPOOL-Bench v1

## Deterministic migration engine

| Rows | CSV parse | Transform + target validation | Rows/sec | Valid | Invalid |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 19.62 ms | 37.99 ms | 26,325 | 999 | 1 |
| 10,000 | 85.79 ms | 239.61 ms | 41,735 | 9,982 | 18 |
| 50,000 | 197.62 ms | 1056.58 ms | 47,322 | 49,910 | 90 |

## Content verification (exact row-hash projection)

| Rows | Verify | Rows/sec |
|---:|---:|---:|
| 1,000 | 343.99 ms | 2,907 |
| 10,000 | 2341.79 ms | 4,270 |

## Merkle trees (root + inclusion proof + verify)

| Leaves | Root/prove/verify | Leaves/sec |
|---:|---:|---:|
| 1,000 | 54.06 ms | 18,498 |
| 10,000 | 589.07 ms | 16,976 |

## Repair plans (DIFF evidence to hash-bound operations)

| Missing rows | Operations | Plan build |
|---:|---:|---:|
| 10 | 10 | 10.78 ms |
| 100 | 100 | 17.59 ms |

## SQLite end-to-end (fenced ledger-backed batches)

| Rows | Write | Rows/sec |
|---:|---:|---:|
| 1,000 | 34.72 ms | 28,803 |
| 10,000 | 263.12 ms | 38,005 |

## Release integrity (signed envelope + canonical evidence)

| Operation | Ops/sec |
|---:|---:|
| Signed envelope creation | 3,848 |
| Signed envelope verification | 3,288 |
| Canonical evidence list hashing | 1,37,928 |

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
