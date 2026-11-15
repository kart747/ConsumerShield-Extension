#!/usr/bin/env python3
"""
End-to-end test of the real extension.

Loads extension/ into headless Chromium, opens a local page full of dark
patterns, and checks the whole path: content script -> service worker ->
backend -> popup -> full report -> complaint PDF.

It starts its own backend (SQLite, rule-based) and its own page server, and
intercepts the page's tracker requests, so it needs no network and no setup:

    pip install -r backend/requirements.txt -r tests/requirements.txt
    playwright install chromium
    python tests/test_extension_e2e.py
"""

import asyncio
import functools
import http.server
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

from playwright.async_api import async_playwright

REPO = Path(__file__).resolve().parent.parent
EXTENSION = REPO / "extension"
FIXTURES = REPO / "tests" / "fixtures"

EXPECTED_PATTERN_TYPES = {
    "urgency", "sneaking", "confirmshaming", "forced_continuity", "obstruction", "preselected",
}


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def start_backend(port: int, db_path: str) -> subprocess.Popen:
    env = {**os.environ, "DATABASE_URL": f"sqlite:///{db_path}", "GEMINI_API_KEY": "",
           "ENABLE_LOCAL_NLP": "0", "ENABLE_QWEN_VL": "0"}
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--port", str(port)],
        cwd=REPO / "backend", env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1)
            return proc
        except Exception:
            time.sleep(0.3)
    proc.kill()
    raise RuntimeError("backend did not start")


def start_page_server(port: int) -> http.server.ThreadingHTTPServer:
    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(QuietHandler, directory=str(FIXTURES))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


async def run(backend_url: str, page_url: str, out_dir: Path) -> list:
    failures = []
    errors = []

    def check(condition, message):
        print(("  ok   " if condition else "  FAIL ") + message)
        if not condition:
            failures.append(message)

    async with async_playwright() as pw:
        ctx = await pw.chromium.launch_persistent_context(
            tempfile.mkdtemp(), channel="chromium", headless=True,
            args=[f"--disable-extensions-except={EXTENSION}", f"--load-extension={EXTENSION}"],
        )
        # Answer the fixture's tracker requests locally.
        for pattern in ("**/*google-analytics.com/**", "**/*facebook.net/**"):
            await ctx.route(pattern, lambda route: route.fulfill(content_type="text/javascript", body=""))

        worker = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
        extension_id = worker.url.split("/")[2]
        worker.on("console", lambda m: m.type == "error" and errors.append(("service worker", m.text)))
        await worker.evaluate("(url) => chrome.storage.local.set({consumershield_backend_url: url})", backend_url)

        print("Scanning the test page")
        page = await ctx.new_page()
        page.on("pageerror", lambda e: errors.append(("page", str(e))))
        await page.goto(page_url)
        await page.wait_for_timeout(9000)

        state = await worker.evaluate("""async () => {
            const [tab] = await chrome.tabs.query({url: 'http://127.0.0.1/*'});
            const stored = await chrome.storage.local.get(['127.0.0.1']);
            return {tabId: tab && tab.id, analysis: stored['127.0.0.1'] || null};
        }""")
        analysis = state["analysis"] or {}
        patterns = (analysis.get("manipulation") or {}).get("patterns") or []
        trackers = (analysis.get("privacy") or {}).get("trackers") or []
        found_types = {p.get("type") for p in patterns}
        tracker_names = {t.get("name") for t in trackers}

        check(bool(analysis), "analysis is stored for the page")
        check(analysis.get("backendAnalyzed") is True, "backend analysed the page")
        check(EXPECTED_PATTERN_TYPES <= found_types,
              f"detects {sorted(EXPECTED_PATTERN_TYPES)} (found {sorted(t for t in found_types if t)})")
        check("Google Analytics" in tracker_names and "Meta Pixel" in tracker_names,
              f"trackers are resolved by name (found {sorted(n for n in tracker_names if n)})")
        check(len({t.get("domain") for t in trackers}) == len(trackers), "no tracker is listed twice")
        check(bool(analysis.get("regulatoryViolations")), "violations are mapped to laws")

        print("Opening the popup")
        popup = await ctx.new_page()
        # A popup opened as a tab would otherwise treat itself as the active tab.
        await popup.add_init_script(
            "const q = chrome.tabs.query.bind(chrome.tabs);"
            "chrome.tabs.query = async (o) => (o && o.active) ? [await chrome.tabs.get(%d)] : q(o);" % state["tabId"]
        )
        popup.on("pageerror", lambda e: errors.append(("popup", str(e))))
        popup.on("console", lambda m: m.type == "error" and errors.append(("popup", m.text)))
        await popup.set_viewport_size({"width": 420, "height": 640})
        await popup.goto(f"chrome-extension://{extension_id}/popup.html")
        await popup.wait_for_timeout(5000)
        popup_text = await popup.evaluate("document.body.innerText")
        check("Google Analytics" in popup_text, "popup lists the tracker by name")
        check("False Urgency" in popup_text, "popup lists the dark patterns")
        check("CCPA Dark Patterns Guidelines 2023 — False Urgency" in popup_text, "popup cites the pattern's own law")
        await popup.screenshot(path=str(out_dir / "popup.png"))

        print("Generating the complaint PDF")
        try:
            async with popup.expect_download(timeout=20000) as download_info:
                await popup.locator("#btn-generate").click()
            download = await download_info.value
            pdf_path = out_dir / "complaint.pdf"
            await download.save_as(str(pdf_path))
            pdf_bytes = pdf_path.read_bytes()
            check(pdf_bytes.startswith(b"%PDF-"), "complaint PDF is generated")
            check(b"2023 - False Urgency" in pdf_bytes, "PDF prints dashes in law names, not '?'")
        except Exception as exc:
            check(False, f"complaint PDF is generated ({exc})")

        print("Opening the full report")
        async with ctx.expect_page() as report_info:
            await popup.locator("#btn-report").click()
        report = await report_info.value
        report.on("pageerror", lambda e: errors.append(("report", str(e))))
        await report.wait_for_timeout(4000)
        height = await report.evaluate("document.body.scrollHeight")
        for y in range(0, height, 500):
            await report.evaluate("(y) => window.scrollTo(0, y)", y)
            await report.wait_for_timeout(200)
        report_text = (await report.evaluate("document.body.innerText")).lower()
        check("127.0.0.1" in report_text, "report is about the scanned site")
        check("flipkart" not in report_text, "report shows no demo data")
        check("google analytics" in report_text, "report lists the trackers")
        hidden_rows = await report.evaluate(
            "[...document.querySelectorAll('.shame-row')].filter(e => getComputedStyle(e).opacity === '0').length")
        check(hidden_rows == 0, "wall of shame rows are visible")
        await report.evaluate("window.scrollTo(0, 0)")
        await report.screenshot(path=str(out_dir / "report.png"), full_page=True)

        await ctx.close()

    check(not errors, f"no script errors ({errors[:3]})")
    return failures


def main() -> int:
    out_dir = Path(os.environ.get("E2E_OUTPUT_DIR") or tempfile.mkdtemp(prefix="consumershield-e2e-"))
    out_dir.mkdir(parents=True, exist_ok=True)
    backend_port, page_port = free_port(), free_port()
    backend = start_backend(backend_port, str(out_dir / "e2e.db"))
    server = start_page_server(page_port)
    try:
        failures = asyncio.run(run(
            f"http://127.0.0.1:{backend_port}",
            f"http://127.0.0.1:{page_port}/dark_pattern_shop.html",
            out_dir,
        ))
    finally:
        backend.terminate()
        server.shutdown()
    print(f"\nScreenshots and PDF: {out_dir}")
    print("FAILED: " + "; ".join(failures) if failures else "All checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
