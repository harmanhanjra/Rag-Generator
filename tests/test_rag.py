import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from backend import main
from tests.create_fixtures import create_fixtures


class RagTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.fixtures = self.folder / "fixtures"
        create_fixtures(self.fixtures)
        self.data = self.folder / "data"
        self.data.mkdir()
        self.data_patch = patch.object(main, "DATA_DIR", self.data)
        self.data_patch.start()
        self.env_patch = patch.dict(os.environ, {"NVIDIA_API_KEY": ""})
        self.env_patch.start()
        self.client = TestClient(main.app)
        self.a = self.workspace("Orion")
        self.b = self.workspace("Cedar")

    def tearDown(self):
        self.client.close()
        self.env_patch.stop()
        self.data_patch.stop()
        self.temp.cleanup()

    def workspace(self, name):
        response = self.client.post("/api/workspaces", json={"name": name})
        self.assertEqual(response.status_code, 200)
        return response.json()["id"]

    def upload(self, wid, *names):
        return self.client.post(f"/api/workspaces/{wid}/documents", files=[
            ("files", (name, (self.fixtures / name).read_bytes())) for name in names])

    def ask(self, wid, question):
        response = self.client.post(f"/api/workspaces/{wid}/ask", json={"question": question})
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_runtime_upload_all_formats_and_docx_table(self):
        result = self.upload(self.a, "orion-plan.pdf", "orion-support.txt", "orion-checklist.md", "orion-shipping.docx")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["document_count"], 4)
        self.assertEqual(result.json()["chunk_count"], 4)
        response = self.ask(self.a, "How many business days does delivery take?")
        self.assertIn("5 business days", response["answer"])
        self.assertEqual(response["sources"][0]["filename"], "orion-shipping.docx")

    def test_citations_match_uploaded_source(self):
        self.upload(self.a, "orion-plan.pdf")
        response = self.ask(self.a, "What is the launch budget?")
        self.assertIn("42000", response["answer"])
        self.assertIn("[1]", response["answer"])
        self.assertEqual(response["sources"][0]["filename"], "orion-plan.pdf")
        self.assertIn("42000", response["sources"][0]["snippet"])

    def test_plural_question_matches_singular_document(self):
        self.upload(self.a, "orion-support.txt")
        self.assertIn("18 months", self.ask(self.a, "How long are the warranties?")["answer"])

    def test_summary_retrieves_multiple_documents(self):
        self.upload(self.a, "orion-plan.pdf", "orion-support.txt", "orion-shipping.docx")
        for question in ("Summarize the documents", "What are the main themes?", "Summarize the key findings"):
            response = self.ask(self.a, question)
            self.assertEqual(len(response["sources"]), 3)

    def test_workspace_isolation_and_switching_document_sets(self):
        self.upload(self.a, "orion-plan.pdf")
        self.upload(self.b, "cedar-plan.pdf")
        for wid, expected, forbidden in ((self.a, "42000", "97000"), (self.b, "97000", "42000")):
            response = self.ask(wid, "What is the project budget?")
            self.assertIn(expected, response["answer"])
            self.assertNotIn(forbidden, response["answer"])
            self.assertEqual(response["workspace_id"], wid)

    def test_new_upload_becomes_queryable_without_code_changes(self):
        self.upload(self.a, "orion-plan.pdf")
        question = "What is the emergency contact extension?"
        self.assertEqual(self.ask(self.a, question)["sources"], [])
        self.upload(self.a, "orion-addendum.txt")
        self.assertIn("6732", self.ask(self.a, question)["answer"])

    def test_unrelated_question_and_empty_workspace_decline(self):
        self.upload(self.a, "orion-plan.pdf")
        for wid in (self.a, self.b):
            response = self.ask(wid, "What is the capital of Mars?")
            self.assertEqual(response["sources"], [])
            self.assertEqual(response["mode"], "retrieval")

    def test_reject_invalid_uploads_and_keep_existing_index(self):
        self.upload(self.a, "orion-plan.pdf")
        for name, expected in (("unsupported.csv", 415), ("broken.pdf", 422), ("empty.txt", 422)):
            response = self.upload(self.a, "orion-support.txt", name)
            self.assertEqual(response.status_code, expected)
            workspace = next(w for w in self.client.get("/api/workspaces").json() if w["id"] == self.a)
            self.assertEqual(workspace["document_count"], 1)

    def test_oversized_upload_rejected(self):
        with patch.object(main, "MAX_UPLOAD_BYTES", 16):
            self.assertEqual(self.upload(self.a, "orion-plan.pdf").status_code, 413)

    def test_remove_document_removes_retrievable_passages(self):
        result = self.upload(self.a, "orion-plan.pdf").json()
        docid = result["documents"][0]["id"]
        response = self.client.delete(f"/api/workspaces/{self.a}/documents/{docid}")
        self.assertEqual(response.json()["chunk_count"], 0)
        self.assertEqual(self.ask(self.a, "What is the project budget?")["sources"], [])

    def test_persistence_in_another_client(self):
        self.upload(self.a, "orion-plan.pdf")
        with TestClient(main.app) as other:
            workspace = next(w for w in other.get("/api/workspaces").json() if w["id"] == self.a)
            self.assertEqual(workspace["document_count"], 1)

    def test_delete_workspace_and_unknown_ids(self):
        self.assertEqual(self.client.delete(f"/api/workspaces/{self.a}").status_code, 200)
        self.assertEqual(self.client.post(f"/api/workspaces/{self.a}/ask", json={"question": "Budget?"}).status_code, 404)
        self.assertEqual(self.client.post("/api/workspaces/invalid/ask", json={"question": "Budget?"}).status_code, 404)

    def test_input_validation(self):
        self.assertEqual(self.client.post("/api/workspaces", json={"name": "   "}).status_code, 422)
        for question in ("  ", "a", "x" * 2001):
            self.assertEqual(self.client.post(f"/api/workspaces/{self.a}/ask", json={"question": question}).status_code, 422)


class NvidiaTests(unittest.TestCase):
    sources = [{"id": "sample:0", "filename": "sample.txt", "snippet": "The budget is USD 42000.", "citation": "[1]"}]

    def generate(self, handler):
        original_client = httpx.AsyncClient
        transport = httpx.MockTransport(handler)
        with patch.dict(os.environ, {"NVIDIA_API_KEY": "test-key", "NVIDIA_MODEL": "test-primary", "NVIDIA_FALLBACK_MODEL": "test-backup"}), patch.object(main.httpx, "AsyncClient", side_effect=lambda **kwargs: original_client(transport=transport, **kwargs)):
            return asyncio.run(main.generate_answer("What is the budget?", self.sources))

    def test_primary_failure_uses_nvidia_backup(self):
        attempted = []
        def handler(request):
            import json
            model = json.loads(request.content)["model"]
            attempted.append(model)
            if model == "test-primary":
                return httpx.Response(503)
            return httpx.Response(200, json={"choices": [{"message": {"content": "The budget is USD 42000 [1]."}}]})
        answer, mode = self.generate(handler)
        self.assertEqual(attempted, ["test-primary", "test-backup"])
        self.assertEqual(mode, "llm-fallback")
        self.assertIn("42000", answer)

    def test_both_time_out_returns_cited_source(self):
        def handler(request):
            raise httpx.ReadTimeout("Synthetic timeout", request=request)
        answer, mode = self.generate(handler)
        self.assertEqual(mode, "extractive-fallback")
        self.assertIn("42000", answer)
        self.assertIn("[1]", answer)

    def test_empty_uncited_and_invented_citations_rejected(self):
        for content in ("", "The budget is USD 999999.", "The budget is USD 999999 [99]."):
            answer, mode = self.generate(lambda request: httpx.Response(200, json={"choices": [{"message": {"content": content}}]}))
            self.assertEqual(mode, "extractive-fallback")
            self.assertNotIn("999999", answer)


if __name__ == "__main__":
    unittest.main()
