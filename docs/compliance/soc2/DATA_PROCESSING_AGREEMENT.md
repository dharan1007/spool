# SPOOL Enterprise — Data Processing Agreement (DPA)

**Between**: Customer ("Data Controller")  
**And**: SPOOL Technologies Inc. ("Data Processor")  
**Effective Date**: Upon Execution  

---

### 1. Scope and Roles
- Customer acts as the Data Controller of all Personal Data transferred, processed, or migrated.
- SPOOL acts strictly as the Data Processor, executing data processing exclusively upon verified Customer commands.

### 2. Processing Instructions
- In self-hosted software deployments, SPOOL processes data locally without transmitting records to SPOOL servers.
- In managed cloud services, Customer data is processed strictly in volatile worker memory and committed directly into Customer-designated targets. No persistent caching of row data occurs in SPOOL control planes.

### 3. Sub-processors
- SPOOL shall not engage sub-processors for self-hosted software.
- For managed cloud services, approved cloud infrastructure sub-processors (AWS, Google Cloud) are listed with written notification requirements prior to modification.

### 4. Security Measures (GDPR Article 32)
- Pseudonymisation and cryptographic hashing of data payloads.
- Ability to ensure the ongoing confidentiality, integrity, availability, and resilience of processing systems.
- Automated content verification to detect accidental or unlawful destruction or loss of Personal Data.
