# SPOOL Benchmarks

Generated: 2026-09-20T01:56:16.601Z
Suite: SPOOL-Bench v1

## Deterministic migration engine

| Rows | CSV parse | Transform + target validation | Rows/sec | Valid | Invalid |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 12.23 ms | 35.98 ms | 27,793 | 999 | 1 |
| 10,000 | 68.74 ms | 369.57 ms | 27,059 | 9,982 | 18 |
| 50,000 | 352.73 ms | 1507.45 ms | 33,169 | 49,910 | 90 |

## Content verification (exact row-hash projection)

| Rows | Verify | Rows/sec |
|---:|---:|---:|
| 1,000 | 186.26 ms | 5,369 |
| 10,000 | 1348.44 ms | 7,416 |

## Merkle trees (root + inclusion proof + verify)

| Leaves | Root/prove/verify | Leaves/sec |
|---:|---:|---:|
| 1,000 | 40.05 ms | 24,966 |
| 10,000 | 529.1 ms | 18,900 |

## Repair plans (DIFF evidence to hash-bound operations)

| Missing rows | Operations | Plan build |
|---:|---:|---:|
| 10 | 10 | 8.57 ms |
| 100 | 100 | 22.13 ms |

## SQLite end-to-end (fenced ledger-backed batches)

| Rows | Write | Rows/sec |
|---:|---:|---:|
| 1,000 | 21.42 ms | 46,687 |
| 10,000 | 239.32 ms | 41,785 |

## Release integrity (signed envelope + canonical evidence)

| Operation | Ops/sec |
|---:|---:|
| Signed envelope creation | 3,695 |
| Signed envelope verification | 3,395 |
| Canonical evidence list hashing | 1,62,881 |

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
