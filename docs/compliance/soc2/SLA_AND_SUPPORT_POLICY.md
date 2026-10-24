# SPOOL Enterprise — Service Level Agreement (SLA) & Support Policy

## 1. Availability Commitment
SPOOL Technologies commits to a **99.9% Monthly Uptime Percentage** for the SPOOL Enterprise Managed Cloud Platform during each calendar month.

$$\text{Uptime Percentage} = \frac{\text{Total Minutes} - \text{Downtime Minutes}}{\text{Total Minutes}} \times 100$$

## 2. Severity Levels & Incident Response Times

| Severity Level | Definition | First Response Target | Workaround / Resolution Target |
|---|---|---|---|
| **P1 - Critical** | Catastrophic failure, split-brain write, data pipeline stalled | < 1 hour (24/7/365) | < 4 hours |
| **P2 - Major** | Impaired migration functionality, degraded API throughput | < 4 hours (Business hours) | < 1 business day |
| **P3 - Minor** | Non-blocking defect, UI rendering anomaly, warning classification | < 1 business day | < 5 business days |
| **P4 - General** | Feature request, documentation clarification, configuration guidance | < 2 business days | Next release cycle |

## 3. Service Credits
If SPOOL fails to meet the Uptime Commitment, customers are eligible for service credits:
- **99.0% - < 99.9%**: 10% credit of monthly billing
- **95.0% - < 99.0%**: 25% credit of monthly billing
- **< 95.0%**: 50% credit of monthly billing
