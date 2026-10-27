#!/usr/bin/env python3
"""Offline structural checks for the LeadForge n8n export pack; never calls services."""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "workflows"
EXPECTED = {
    "leadforge-rentcast-discovery.json": "/api/automation/rentcast-sync",
    "leadforge-source-health.json": "/api/automation/source-health",
    "lead-discovery-and-ingestion.json": "/api/ingestion/listings",
}
FORBIDDEN_KEYS = {"password", "token", "secret", "api_key", "apikey", "service_role_key"}

def walk(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield str(key).lower(), item
            yield from walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk(item)

def main() -> None:
    files = sorted(ROOT.glob("*.json"))
    assert {file.name for file in files} == set(EXPECTED), "Unexpected or missing workflow export"
    for file in files:
        data = json.loads(file.read_text())
        assert data.get("active") is False, f"{file.name} must stay inactive"
        assert data.get("settings", {}).get("saveDataErrorExecution") == "none"
        assert data.get("settings", {}).get("saveDataSuccessExecution") == "none"
        all_text = json.dumps(data)
        assert EXPECTED[file.name] in all_text, f"{file.name} does not target its documented endpoint"
        for key, value in walk(data):
            assert key not in FORBIDDEN_KEYS, f"Possible secret field {key} in {file.name}"
            if key == "url":
                assert "YOUR-LEADFORGE-APP.example" in value or value.startswith("https://"), f"Non-HTTPS URL in {file.name}"
        for node in data.get("nodes", []):
            if node.get("type") == "n8n-nodes-base.httpRequest":
                assert node.get("retryOnFail") is True, f"Unbounded/no retry policy in {file.name}"
                assert 1 <= int(node.get("maxTries", 0)) <= 3, f"Retry count exceeds limit in {file.name}"
                assert "credentials" not in node, f"Credential ID/value must not be exported in {file.name}"
        if file.name == "lead-discovery-and-ingestion.json":
            assert "privateDetails" in all_text and "ownerContact" in all_text and "sellerContact" in all_text
            assert "Header Auth" in all_text
        print(f"PASS {file.name}: valid JSON, inactive, credential-free, bounded")
    print(f"PASS {len(files)} disabled workflow exports validated; no network or database calls made")

if __name__ == "__main__":
    main()
