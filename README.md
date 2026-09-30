# Atlas — RAG workspace

A document-grounded question answering workspace. Create a workspace for any document set, upload PDF, DOCX, TXT, or Markdown files, and ask questions against the indexed content. No code changes are needed when the documents change.

## Run locally

Requirements: Python 3.10+ and Node.js 20+.

On Windows, use a Python 3.10+ installation to create a separate environment if
an older `.venv` already exists. The launcher prefers `.venv-runtime`:

```powershell
py -3.12 -m venv .venv-runtime
.\.venv-runtime\Scripts\python.exe -m pip install -r requirements.txt
npm ci
powershell -File .\start.ps1
```

Use `.\.venv-runtime\Scripts\python.exe -m unittest tests.test_rag -v`
to run backend tests in this environment. Keep `.env` and `.rag-data/` private;
neither is needed in a GitHub checkout. If your `python` command resolves to
Anaconda 3.9, select a newer installation explicitly rather than reusing it.

If dependencies are already installed, run `powershell -File .\start.ps1`.
It starts both servers from this project and prints the app URL. If another app
occupies the usual ports, it chooses available ports and connects the frontend
to the matching backend automatically.

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
For a custom backend port, set `API_PROXY_TARGET` before starting Vite.
The backend always loads `.env` and the default document storage from this project's
directory, even when started from another working directory.

Set `NVIDIA_API_KEY` in `.env` to enable generated answers through NVIDIA NIM. `NVIDIA_BASE_URL` and `NVIDIA_MODEL` configure the primary endpoint and model. The default primary is `nvidia/nemotron-3-ultra-550b-a55b`; if it fails or times out, the app retries with `nvidia/nemotron-3-super-120b-a12b` before returning a cited extractive answer. Override the secondary model with `NVIDIA_FALLBACK_MODEL`. Without credentials or when both models fail, the app responds with the best matching passages and citations. It does not invent an answer when retrieval finds no relevant evidence.

## Design

- Documents and chunks are isolated by workspace ID and persisted under `.rag-data/`.
- Files are extracted and split into overlapping chunks on upload.
- Retrieval combines normalized term matching with BM25-style scoring.
- General document summaries sample passages across documents; summary coverage is limited to those excerpts.
- Answers cite retrieved source snippets; the LLM is instructed to use only those snippets and cite their source markers.
- Delete a workspace to remove its document data.

## Verification

Run `python -m unittest tests.test_rag -v` for the 16 regression checks, and
`npm run build` to verify the production frontend. Regression tests use synthetic
documents and temporary storage, without calling NVIDIA or changing user workspaces.

This starter is designed for local, single-user development. Add authentication, access controls, malware scanning, and managed vector storage before exposing it to multiple users or untrusted production uploads.
