# ConsumerShield Extension

A Chrome extension that flags dark patterns and third-party trackers on the page you are on, maps them to Indian consumer law, and generates a complaint you can file.

It checks pages against the CCPA Dark Patterns Guidelines 2023, the DPDP Act 2023 and the Consumer Protection Act 2019.

The Android app lives in [ConsumerShield-App](https://github.com/kart747/ConsumerShield-App) and uses the backend in this repo.

## What it does

- **Dark patterns:** false urgency, drip pricing, confirmshaming, forced continuity, obstruction, pre-selected add-ons, nagging, trick wording, disguised ads, misdirection.
- **Trackers:** watches third-party requests and names the company behind each domain.
- **Risk scores:** a privacy score and a manipulation score out of 10 for every page.
- **Complaint PDF:** a ready-to-file report with the evidence and the law each pattern breaks.
- **Full report and wall of shame:** a detailed report page, plus the highest-risk sites seen so far.
- **Evidence anchoring (optional):** stores a hash of each report on Ethereum Sepolia.

## Layout

```
extension/   Chrome extension (Manifest V3): content script, service worker, popup, report page
backend/     FastAPI service: risk scoring, law mapping, tracker lookup, report storage
tests/       End-to-end test that loads the real extension, plus older scripts
docs/        Design notes from the hackathon
train.py     LoRA fine-tuning script for the dark-pattern classifier
consumershield-roberta-final/        fine-tuned adapter the backend loads
consumershield-roberta-base-final/   later RoBERTa-base training run
```

## Run it

### 1. Backend

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
cd backend
uvicorn main:app --port 8000
```

That is enough: with no configuration it stores reports in a local SQLite file and uses rule-based analysis. API docs are at http://localhost:8000/docs.

Optional settings go in `backend/.env` (see `backend/.env.example`):

| Setting | What it adds |
| --- | --- |
| `DATABASE_URL` | PostgreSQL instead of SQLite |
| `GEMINI_API_KEY` | Gemini-written insights |
| `ENABLE_LOCAL_NLP=1` | the fine-tuned RoBERTa classifier (needs `backend/requirements-ml.txt`) |
| `ENABLE_QWEN_VL=1` | Qwen2.5-VL screenshot analysis (needs a GPU with about 8 GB) |
| `RPC_URL`, `PRIVATE_KEY`, `CONTRACT_ADDRESS` | Ethereum evidence anchoring |

### 2. Extension

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension/` folder.
3. Visit a shopping site and click the ConsumerShield icon.

The extension looks for the backend on ports 8012 and 8000 of localhost. It still detects patterns and trackers without the backend, but law mapping and saved reports need it.

## Test

```bash
pip install -r backend/requirements.txt -r tests/requirements.txt
playwright install chromium
python tests/test_extension_e2e.py
```

The test starts its own backend and a local page full of dark patterns, loads the real extension in headless Chromium, and checks the scan, the popup, the complaint PDF and the full report. It needs no network access.

## How detection works

1. The content script scans the page text and DOM with rules for each pattern type, and lists third-party domains.
2. The service worker sends the findings to the backend.
3. The backend scores the risk, resolves tracker domains against `backend/radar_lite.json`, and maps each finding to a law, a penalty and an authority.
4. If enabled, the RoBERTa classifier, Qwen2.5-VL and Gemini add a second opinion on borderline findings.

## Team

Built for a hackathon by kart747, PranamB21, LnAigal and Yashwin69.
