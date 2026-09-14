# SPOOL Benchmarks

Generated: 2026-09-14T07:26:36.559Z
Suite: SPOOL-Bench v1

## Deterministic migration engine

| Rows | CSV parse | Transform + target validation | Rows/sec | Valid | Invalid |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 20.5 ms | 64.61 ms | 15,478 | 999 | 1 |
| 10,000 | 111.49 ms | 460.54 ms | 21,714 | 9,982 | 18 |
| 50,000 | 329.97 ms | 1421.36 ms | 35,178 | 49,910 | 90 |

## Content verification (exact row-hash projection)

| Rows | Verify | Rows/sec |
|---:|---:|---:|
| 1,000 | 373.97 ms | 2,674 |
| 10,000 | 2007.08 ms | 4,982 |

## Merkle trees (root + inclusion proof + verify)

| Leaves | Root/prove/verify | Leaves/sec |
|---:|---:|---:|
| 1,000 | 48.71 ms | 20,529 |
| 10,000 | 670.79 ms | 14,908 |

## Repair plans (DIFF evidence to hash-bound operations)

| Missing rows | Operations | Plan build |
|---:|---:|---:|
| 10 | 10 | 9.98 ms |
| 100 | 100 | 23.04 ms |

## SQLite end-to-end (fenced ledger-backed batches)

| Rows | Write | Rows/sec |
|---:|---:|---:|
| 1,000 | 38.68 ms | 25,851 |
| 10,000 | 320.82 ms | 31,170 |

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
