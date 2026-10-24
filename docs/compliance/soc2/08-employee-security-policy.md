# Policy 08: Personnel & Access Lifecycle Security Policy (SOC 2 CC1.4, CC2.2)

## 1. Objective
Ensure that all personnel and external contributors accessing SPOOL systems adhere to vetted security practices from onboarding through offboarding.

## 2. Standards
1. **Background Checks & Agreements**:
   - All engineers and administrators must undergo background verification and execute non-disclosure and intellectual property assignment agreements prior to system access.
2. **Access Provisioning**:
   - Access to cloud infrastructure, production databases, and signing keys must be granted solely on a business-need basis with mandatory Multi-Factor Authentication (MFA).
3. **Immediate Offboarding**:
   - Upon termination or role change, all cryptographic credentials, SSH keys, cloud permissions, and repository write privileges must be revoked within 1 hour.
4. **Security Awareness Training**:
   - Personnel must complete annual security awareness training covering social engineering, credential hygiene, and secure coding practices.
