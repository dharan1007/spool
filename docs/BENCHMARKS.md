# SPOOL Benchmarks

Generated: 2026-10-28T05:33:10.830Z
Suite: SPOOL-Bench v1

## Deterministic migration engine

| Rows | CSV parse | Transform + target validation | Rows/sec | Valid | Invalid |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 16.75 ms | 39.25 ms | 25,475 | 999 | 1 |
| 10,000 | 72.3 ms | 232.95 ms | 42,928 | 9,982 | 18 |
| 50,000 | 203.2 ms | 1116.35 ms | 44,789 | 49,910 | 90 |

## Content verification (exact row-hash projection)

| Rows | Verify | Rows/sec |
|---:|---:|---:|
| 1,000 | 209.73 ms | 4,768 |
| 10,000 | 1397.65 ms | 7,155 |

## Merkle trees (root + inclusion proof + verify)

| Leaves | Root/prove/verify | Leaves/sec |
|---:|---:|---:|
| 1,000 | 36.66 ms | 27,281 |
| 10,000 | 365.77 ms | 27,339 |

## Repair plans (DIFF evidence to hash-bound operations)

| Missing rows | Operations | Plan build |
|---:|---:|---:|
| 10 | 10 | 5.18 ms |
| 100 | 100 | 16.51 ms |

## SQLite end-to-end (fenced ledger-backed batches)

| Rows | Write | Rows/sec |
|---:|---:|---:|
| 1,000 | 119.08 ms | 8,398 |
| 10,000 | 1411.17 ms | 7,086 |

## Release integrity (signed envelope + canonical evidence)

| Operation | Ops/sec |
|---:|---:|
| Signed envelope creation | 3,671 |
| Signed envelope verification | 3,455 |
| Canonical evidence list hashing | 2,38,895 |

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
