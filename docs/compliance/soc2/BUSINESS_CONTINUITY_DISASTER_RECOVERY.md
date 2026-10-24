# SPOOL Enterprise — Business Continuity & Disaster Recovery (BCP/DR) Plan

## 1. Objectives & Recovery Targets
- **Recovery Point Objective (RPO)**: **0 data loss** (supported by immutable commit-before-checkpoint batch ledgers).
- **Recovery Time Objective (RTO)**: **< 15 minutes** for single-node crash resumption; **< 1 hour** for managed cloud cluster failover.

## 2. Redundancy Architecture
- **Control Plane**: Stateless REST API pods (`spoold-v2`) deployed across multiple availability zones (AZs) behind network load balancers.
- **Worker Plane**: Distributed worker nodes coordinate via atomic lease tables and fencing tokens. If a worker node crashes mid-batch, peer nodes detect lease expiration, assume partition ownership, and resume without manual intervention.

## 3. Cryptographic State Durability
- Migration execution state resides in local or managed SQLite/PostgreSQL `state.db` stores with WAL journal mode and fsync enabled.
- Cryptographic approvals are tied to machine DPAPI or vault-stored asymmetric keys. If a node fails, replacement nodes can verify historical receipts using the immutable public verification key.
