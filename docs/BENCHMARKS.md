# SPOOL Benchmarks

Generated: 2026-09-04T08:07:01.677Z

## Deterministic migration engine

| Rows | CSV parse | Transform + target validation | Rows/sec | Valid | Invalid |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 6.1 ms | 8.44 ms | 118,461 | 999 | 1 |
| 10,000 | 35.91 ms | 57.72 ms | 173,246 | 9,982 | 18 |
| 50,000 | 114.37 ms | 275.38 ms | 181,569 | 49,910 | 90 |

## Temporal WebMCP surface

A permanent surface across the measured phases contains **23 tools** / **7,963 serialized definition bytes**. SPOOL exposes **4.75 tools** / **1,658 bytes on average**, reducing active tool count by **79.3%** and serialized definition bytes by **79.2%** for this tool set.

| Phase | Active tools | Definition bytes |
|---|---:|---:|
| EMPTY | 2 | 642 |
| SOURCE_READY | 6 | 2,468 |
| TARGET_READY | 4 | 1,453 |
| MAPPING_DRAFT | 5 | 1,732 |
| MAPPING_VALID | 5 | 1,836 |
| RUNNING | 4 | 1,290 |
| PAUSED | 6 | 2,113 |
| COMPLETE | 6 | 1,730 |

> These are local deterministic engine and serialized-schema measurements. They are not claims about universal model success rate, tokenization, or browser-agent performance.
