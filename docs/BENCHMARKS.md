# SPOOL Benchmarks

Generated: 2026-09-20T06:59:44.123Z
Suite: SPOOL-Bench v1

## Deterministic migration engine

| Rows | CSV parse | Transform + target validation | Rows/sec | Valid | Invalid |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 11.63 ms | 34.1 ms | 29,324 | 999 | 1 |
| 10,000 | 71.83 ms | 204.4 ms | 48,924 | 9,982 | 18 |
| 50,000 | 209.59 ms | 1045.22 ms | 47,837 | 49,910 | 90 |

## Content verification (exact row-hash projection)

| Rows | Verify | Rows/sec |
|---:|---:|---:|
| 1,000 | 341.27 ms | 2,930 |
| 10,000 | 2224.92 ms | 4,495 |

## Merkle trees (root + inclusion proof + verify)

| Leaves | Root/prove/verify | Leaves/sec |
|---:|---:|---:|
| 1,000 | 44.75 ms | 22,346 |
| 10,000 | 484.35 ms | 20,646 |

## Repair plans (DIFF evidence to hash-bound operations)

| Missing rows | Operations | Plan build |
|---:|---:|---:|
| 10 | 10 | 7.84 ms |
| 100 | 100 | 22.5 ms |

## SQLite end-to-end (fenced ledger-backed batches)

| Rows | Write | Rows/sec |
|---:|---:|---:|
| 1,000 | 26.04 ms | 38,400 |
| 10,000 | 234.81 ms | 42,588 |

## Release integrity (signed envelope + canonical evidence)

| Operation | Ops/sec |
|---:|---:|
| Signed envelope creation | 2,521 |
| Signed envelope verification | 2,618 |
| Canonical evidence list hashing | 1,24,891 |

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
