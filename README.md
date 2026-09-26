# Atlas — RAG workspace

A document-grounded question answering workspace. Create a workspace for any document set, upload PDF, DOCX, TXT, or Markdown files, and ask questions against the indexed content. No code changes are needed when the documents change.

## Run locally

Requirements: Python 3.10+ and Node.js 20+.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn backend.main:app --reload --port 8001
```

In another terminal:

```powershell
npm install
npm run dev
```

Open http://localhost:5173. Vite forwards `/api` requests to the backend on port 8001.

Set `NVIDIA_API_KEY` in `.env` to enable generated answers through NVIDIA NIM. `NVIDIA_BASE_URL` and `NVIDIA_MODEL` configure the primary endpoint and model. The default primary is `nvidia/nemotron-3-ultra-550b-a55b`; if it fails or times out, the app retries with `nvidia/nemotron-3-super-120b-a12b` before returning a cited extractive answer. Override the secondary model with `NVIDIA_FALLBACK_MODEL`. Without credentials or when both models fail, the app responds with the best matching passages and citations. It does not invent an answer when retrieval finds no relevant evidence.

## Design

- Documents and chunks are isolated by workspace ID and persisted under `.rag-data/`.
- Files are extracted and split into overlapping chunks on upload.
- Retrieval combines normalized term matching with BM25-style scoring.
- Answers cite retrieved source snippets; the LLM is instructed to use only those snippets and cite their source markers.
- Delete a workspace to remove its document data.

This starter is designed for local, single-user development. Add authentication, access controls, malware scanning, and managed vector storage before exposing it to multiple users or untrusted production uploads.
