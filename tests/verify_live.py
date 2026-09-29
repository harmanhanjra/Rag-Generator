"""Verify the real NVIDIA endpoint using disposable synthetic workspaces."""
import argparse
import json
import time
from pathlib import Path

import httpx


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8001")
    args = parser.parse_args()
    base = args.url.rstrip("/")
    fixtures = Path(__file__).parent / "fixtures"
    results = []
    created = []
    with httpx.Client(timeout=55, trust_env=False) as client:
        def create(name):
            response = client.post(base + "/api/workspaces", json={"name": name})
            response.raise_for_status()
            wid = response.json()["id"]
            created.append(wid)
            return wid

        def upload(wid, names):
            response = client.post(f"{base}/api/workspaces/{wid}/documents", files=[
                ("files", (name, (fixtures / name).read_bytes())) for name in names])
            response.raise_for_status()
            return response.json()

        def ask(wid, question, expected=(), forbidden=(), require_llm=False):
            started = time.monotonic()
            response = client.post(f"{base}/api/workspaces/{wid}/ask", json={"question": question})
            response.raise_for_status()
            data = response.json()
            normalized = data["answer"].replace(",", "").lower()
            assert all(text.lower() in normalized for text in expected), data["answer"]
            assert all(text.lower() not in normalized for text in forbidden), data["answer"]
            if require_llm:
                assert data["mode"].startswith("llm"), data["mode"]
            if expected:
                assert data["sources"] and "[1]" in data["answer"]
            row = {"question": question, "mode": data["mode"], "seconds": round(time.monotonic()-started, 2), "answer": data["answer"], "sources": [s["filename"] for s in data["sources"]]}
            results.append(row)
            print(json.dumps(row), flush=True)
            return data

        try:
            a, b = create("QA live Orion"), create("QA live Cedar")
            result = upload(a, ["orion-plan.pdf", "orion-support.txt", "orion-checklist.md", "orion-shipping.docx"])
            assert result["document_count"] == 4 and result["chunk_count"] == 4
            upload(b, ["cedar-plan.pdf", "cedar-support.txt"])
            ask(a, "What is the project budget?", ["42000"], ["97000"], True)
            ask(b, "What is the project budget and warranty?", ["97000", "36 months"], ["42000"], True)
            ask(a, "How long are the warranties?", ["18 months"], require_llm=True)
            summary = ask(a, "Summarize the documents", ["42000", "18 months", "5 business days", "ORION-731"], require_llm=True)
            assert len(summary["sources"]) == 4
            assert not ask(a, "What is the emergency contact extension?")["sources"]
            upload(a, ["orion-addendum.txt"])
            ask(a, "What is the emergency contact extension?", ["6732"], require_llm=True)
            assert not ask(b, "What is the capital of Mars?")["sources"]
            print("PASS: live uploads, indexing, NVIDIA answers, citations, summaries, new documents, and isolation", flush=True)
            (Path(__file__).parent / "live-results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
        finally:
            for wid in created:
                client.delete(f"{base}/api/workspaces/{wid}").raise_for_status()


if __name__ == "__main__":
    main()
