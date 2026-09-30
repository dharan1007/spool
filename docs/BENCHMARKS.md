# SPOOL Benchmarks

Generated: 2026-09-30T19:38:19.149Z
Suite: SPOOL-Bench v1

## Deterministic migration engine

| Rows | CSV parse | Transform + target validation | Rows/sec | Valid | Invalid |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 11.63 ms | 35.84 ms | 27,904 | 999 | 1 |
| 10,000 | 85.23 ms | 321.84 ms | 31,071 | 9,982 | 18 |
| 50,000 | 291.5 ms | 1893.23 ms | 26,410 | 49,910 | 90 |

## Content verification (exact row-hash projection)

| Rows | Verify | Rows/sec |
|---:|---:|---:|
| 1,000 | 342.82 ms | 2,917 |
| 10,000 | 2224.04 ms | 4,496 |

## Merkle trees (root + inclusion proof + verify)

| Leaves | Root/prove/verify | Leaves/sec |
|---:|---:|---:|
| 1,000 | 54.26 ms | 18,429 |
| 10,000 | 568.5 ms | 17,590 |

## Repair plans (DIFF evidence to hash-bound operations)

| Missing rows | Operations | Plan build |
|---:|---:|---:|
| 10 | 10 | 6.69 ms |
| 100 | 100 | 18.32 ms |

## SQLite end-to-end (fenced ledger-backed batches)

| Rows | Write | Rows/sec |
|---:|---:|---:|
| 1,000 | 27.96 ms | 35,761 |
| 10,000 | 260.35 ms | 38,410 |

## Release integrity (signed envelope + canonical evidence)

| Operation | Ops/sec |
|---:|---:|
| Signed envelope creation | 2,177 |
| Signed envelope verification | 2,043 |
| Canonical evidence list hashing | 1,09,944 |

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
