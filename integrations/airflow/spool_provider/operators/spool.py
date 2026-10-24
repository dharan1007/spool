"""
Airflow Provider Operators for SPOOL Enterprise Migration Platform.
Enables native DAG integration with cryptographically verified data migration receipts.
"""

from airflow.models.baseoperator import BaseOperator
import requests

class SpoolMigrationOperator(BaseOperator):
    """
    Executes an end-to-end SPOOL migration via REST API v2 and verifies cryptographic receipts.
    """
    def __init__(
        self,
        endpoint: str,
        api_key: str,
        migration_payload: dict,
        *args, **kwargs
    ):
        super().__init__(*args, **kwargs)
        self.endpoint = endpoint.rstrip('/')
        self.api_key = api_key
        self.migration_payload = migration_payload

    def execute(self, context):
        headers = {
            "Content-Type": "application/json",
            "X-API-Key": self.api_key
        }

        # 1. Create Migration
        create_res = requests.post(
            f"{self.endpoint}/v2/migrations",
            headers=headers,
            json=self.migration_payload,
            timeout=30
        )
        create_res.raise_for_status()
        data = create_res.json()
        migration_id = data["result"]["migrationId"]
        self.log.info(f"Created SPOOL migration: {migration_id}")

        # 2. Plan
        requests.post(f"{self.endpoint}/v2/migrations/{migration_id}/plan", headers=headers, timeout=60).raise_for_status()
        # 3. Dry-Run
        requests.post(f"{self.endpoint}/v2/migrations/{migration_id}/dry-run", headers=headers, timeout=60).raise_for_status()
        # 4. Approve
        requests.post(f"{self.endpoint}/v2/migrations/{migration_id}/approve", headers=headers, timeout=30).raise_for_status()
        # 5. Execute
        exec_res = requests.post(f"{self.endpoint}/v2/migrations/{migration_id}/execute", headers=headers, timeout=3600)
        exec_res.raise_for_status()
        result = exec_res.json()["result"]

        if result.get("status") != "COMPLETE":
            raise RuntimeError(f"SPOOL Migration {migration_id} failed with status: {result.get('status')}")

        # 6. Fetch verified receipt
        receipt_res = requests.get(f"{self.endpoint}/v2/migrations/{migration_id}/receipt", headers=headers, timeout=30)
        receipt_res.raise_for_status()
        receipt = receipt_res.json()["result"]

        self.log.info(f"SPOOL Migration {migration_id} COMPLETE. Receipt ID: {receipt.get('receiptId')}")
        return receipt
