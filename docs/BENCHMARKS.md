# SPOOL Benchmarks

Generated: 2026-09-14T05:23:22.209Z
Suite: SPOOL-Bench v1

## Deterministic migration engine

| Rows | CSV parse | Transform + target validation | Rows/sec | Valid | Invalid |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 18.78 ms | 49.96 ms | 20,016 | 999 | 1 |
| 10,000 | 97.86 ms | 246.31 ms | 40,600 | 9,982 | 18 |
| 50,000 | 286.75 ms | 1288.27 ms | 38,812 | 49,910 | 90 |

## Content verification (exact row-hash projection)

| Rows | Verify | Rows/sec |
|---:|---:|---:|
| 1,000 | 284.3 ms | 3,517 |
| 10,000 | 2428.18 ms | 4,118 |

## Merkle trees (root + inclusion proof + verify)

| Leaves | Root/prove/verify | Leaves/sec |
|---:|---:|---:|
| 1,000 | 70.73 ms | 14,138 |
| 10,000 | 674.7 ms | 14,821 |

## Repair plans (DIFF evidence to hash-bound operations)

| Missing rows | Operations | Plan build |
|---:|---:|---:|
| 10 | 10 | 9.7 ms |
| 100 | 100 | 25.95 ms |

## SQLite end-to-end (fenced ledger-backed batches)

| Rows | Write | Rows/sec |
|---:|---:|---:|
| 1,000 | 38.79 ms | 25,778 |
| 10,000 | 292.31 ms | 34,210 |

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
