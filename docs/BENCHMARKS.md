# SPOOL Benchmarks

Generated: 2026-09-17T10:12:17.123Z
Suite: SPOOL-Bench v1

## Deterministic migration engine

| Rows | CSV parse | Transform + target validation | Rows/sec | Valid | Invalid |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 21.2 ms | 108.26 ms | 9,237 | 999 | 1 |
| 10,000 | 123.58 ms | 393.18 ms | 25,434 | 9,982 | 18 |
| 50,000 | 289.37 ms | 1384.79 ms | 36,106 | 49,910 | 90 |

## Content verification (exact row-hash projection)

| Rows | Verify | Rows/sec |
|---:|---:|---:|
| 1,000 | 260.54 ms | 3,838 |
| 10,000 | 2244.57 ms | 4,455 |

## Merkle trees (root + inclusion proof + verify)

| Leaves | Root/prove/verify | Leaves/sec |
|---:|---:|---:|
| 1,000 | 84.54 ms | 11,828 |
| 10,000 | 474.47 ms | 21,076 |

## Repair plans (DIFF evidence to hash-bound operations)

| Missing rows | Operations | Plan build |
|---:|---:|---:|
| 10 | 10 | 7.71 ms |
| 100 | 100 | 15.67 ms |

## SQLite end-to-end (fenced ledger-backed batches)

| Rows | Write | Rows/sec |
|---:|---:|---:|
| 1,000 | 27.97 ms | 35,750 |
| 10,000 | 254.09 ms | 39,356 |

## Release integrity (signed envelope + canonical evidence)

| Operation | Ops/sec |
|---:|---:|
| Signed envelope creation | 3,112 |
| Signed envelope verification | 2,767 |
| Canonical evidence list hashing | 1,95,245 |

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
