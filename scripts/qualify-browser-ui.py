#!/usr/bin/env python3
"""Release-blocking real Chrome Studio UI and resource qualification.

Runs against locally built dist/ only. No fixtures are uploaded to a server.
Requires Chrome/Chromium, websocket-client and psutil. See browser-smoke.py for
the existing shared CDP protocol and browser discovery.
"""
import hashlib
import base64
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from pathlib import Path

import psutil

# The existing CDP implementation is named browser-smoke.py (hyphenated).
# Python cannot import that filename using an ordinary 'from browser_smoke'.
# Load the existing, reviewed executable as a module without duplicating it.
_smoke_path = Path(__file__).resolve().with_name("browser-smoke.py")
_smoke_spec = importlib.util.spec_from_file_location("spool_browser_smoke", _smoke_path)
if _smoke_spec is None or _smoke_spec.loader is None:
    raise RuntimeError(f"Existing Chrome CDP helper unavailable: {_smoke_path}")
_smoke = importlib.util.module_from_spec(_smoke_spec)
_smoke_spec.loader.exec_module(_smoke)
CDP = _smoke.CDP
get_json = _smoke.get_json
launch_browser_with_cdp = _smoke.launch_browser_with_cdp
resolve_browser = _smoke.resolve_browser
stop_process = _smoke.stop_process
wait_for = _smoke.wait_for
CDP_PORT = _smoke.CDP_PORT

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
MiB = 1024 * 1024
MAX_INPUT = 50 * MiB
assertions = 0


def require(predicate, message):
    global assertions
    assertions += 1
    if not predicate:
        raise AssertionError(message)


def source_sha():
    value = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
    ).strip().lower()
    require(len(value) == 40 and all(c in "0123456789abcdef" for c in value),
            "exact source SHA unavailable")
    require(not os.environ.get("SPOOL_COMMIT_SHA") or
            os.environ["SPOOL_COMMIT_SHA"].lower() == value,
            "candidate SHA does not match actual HEAD")
    return value


class ProcessSampler:
    def __init__(self, pid):
        self.pid = pid
        self.stop_event = threading.Event()
        self.peak_rss = 0
        self.samples = 0
        self.heap_peak = 0
        self.heap_samples = 0
        self.heap_cdp = None
        self.records = []
        self.measurement_errors = []
        self.thread = threading.Thread(target=self.sample, daemon=True)

    def sample(self):
        while not self.stop_event.is_set():
            rss = 0
            try:
                parent = psutil.Process(self.pid)
                for proc in [parent] + parent.children(recursive=True):
                    try:
                        rss += proc.memory_info().rss
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        continue
                self.peak_rss = max(self.peak_rss, rss)
                self.samples += 1
                if self.heap_cdp:
                    fields = {x['name']: x['value'] for x in self.heap_cdp.call('Performance.getMetrics').get('metrics', [])}
                    heap = fields.get('JSHeapUsedSize', 0)
                    if heap > 0:
                        self.heap_peak = max(self.heap_peak, int(heap))
                        self.heap_samples += 1
                        self.records.append({'monotonicSeconds': time.monotonic(), 'treeRssBytes': rss, 'mainPageHeapBytes': int(heap)})
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
            except Exception as measurement_error:
                self.measurement_errors.append(repr(measurement_error))
            self.stop_event.wait(.12)

    def start(self):
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.thread.join(timeout=10)
        require(self.samples > 0, "Chrome process memory sampler did not execute")

    def attach_heap(self, ws_url):
        connection = CDP(ws_url)
        connection.call('Performance.enable')
        self.heap_cdp = connection


def ui_wait(cdp, expr, label, timeout=35):
    return wait_for(lambda: cdp.eval(expr), timeout=timeout, label=label)


def open_ui(cdp, base_url, route="/studio/original"):
    cdp.call("Page.navigate", {"url": base_url + route})
    ui_wait(cdp, 'document.readyState === "complete"', "page ready")
    ui_wait(cdp, 'Boolean(window.__spoolTest) && Boolean(document.querySelector("[data-spool-flow-root]"))',
            "Studio document and kernel")
    require(cdp.eval("location.pathname") == route, "wrong Studio route")


def click(cdp, selector, route=None):
    require(bool(cdp.eval("Boolean(document.querySelector(" + json.dumps(selector) + "))")),
            "missing real UI control: " + selector)
    cdp.eval("document.querySelector(" + json.dumps(selector) + ").click()")
    if route:
        ui_wait(cdp, "location.pathname === " + json.dumps(route), "UI route " + route)


def upload(cdp, file_path, expected_rows=None, should_reject=False, timeout=180):
    """Drive the real DOM file input via CDP; do not invoke loadCsv directly."""
    info = cdp.call("DOM.getDocument")
    node = cdp.call("DOM.querySelector", {
        "nodeId": info["root"]["nodeId"], "selector": "#flow-file"
    })["nodeId"]
    require(node > 0, "Studio original-file input missing")
    cdp.call("DOM.setFileInputFiles", {
        "nodeId": node, "files": [str(file_path.resolve())]
    })
    # DOM.setFileInputFiles dispatches a real file change through Chromium;
    # never send a second event, which could race and load the source twice.
    if should_reject:
        ui_wait(cdp, 'Boolean(document.querySelector(".flow-notice.danger, .flow-notice[role=alert]")) || document.body.innerText.includes("File too large") || document.body.innerText.includes("Could not load source")',
                "visible input rejection", timeout=timeout)
        require(cdp.eval("location.pathname") == "/studio/original",
                "rejected file unexpectedly navigated into processing")
        return
    ui_wait(cdp, 'location.pathname === "/studio/inspect"', "real file upload", timeout=timeout)
    if expected_rows is not None:
        require(cdp.eval("window.__spoolTest.viewState().source.rows.length") == expected_rows,
                "real uploaded row count did not match source fixture")
    require(cdp.eval("window.__spoolTest.viewState().job.phase") == "SOURCE_READY",
            "file input failed to create SOURCE_READY workspace")


def workflow(cdp, expected_csv, download_dir):
    click(cdp, '[data-flow-route="/studio/understand"]', "/studio/understand")
    click(cdp, '[data-flow-route="/studio/transform"]', "/studio/transform")
    click(cdp, '[data-flow-outcome="clean_standardize"]')
    click(cdp, '[data-flow-action="approve-plan"]', "/studio/test")
    click(cdp, '[data-flow-action="run-preview"]')
    ui_wait(cdp, 'document.body.innerText.includes("TEST OUTPUT") || document.body.innerText.includes("Transformed sample")',
            "actual preview result")
    require(cdp.eval("window.__spoolTest.state().output.length") == 0,
            "dry run incorrectly mutated complete output")
    click(cdp, '[data-flow-route="/studio/process"]', "/studio/process")
    click(cdp, '[data-flow-action="start-process"]')
    ui_wait(cdp, 'window.__spoolTest.viewState().job.phase === "COMPLETE"',
            "real Worker execution", timeout=95)
    state = cdp.eval("window.__spoolTest.state()")
    require(state["job"]["processedRows"] == 2 and state["job"]["validRows"] == 2
            and state["job"]["invalidRows"] == 0, "unexpected final exact row accounting")
    click(cdp, '[data-flow-route="/studio/validate"]', "/studio/validate")
    require(cdp.eval("document.querySelectorAll('.flow-metrics article').length") == 4,
            "validation UI lacks final accountable metrics")
    cdp.call("Page.setDownloadBehavior", {
        "behavior": "allow", "downloadPath": str(download_dir.resolve())
    })
    for name, action in [
        ("spool-result.csv", "export-csv"),
        ("spool-result.json", "export-json")
    ]:
        path = download_dir / name
        if path.exists():
            path.unlink()
        click(cdp, '[data-flow-action="' + action + '"]')
        wait_for(lambda: path.exists() and path.stat().st_size > 0,
                 timeout=20, label="real browser download " + name)
        raw = path.read_bytes()
        if action == "export-csv":
            require(raw == expected_csv, "downloaded CSV bytes do not match independent expected bytes")
        else:
            rows = json.loads(raw)
            require(isinstance(rows, list) and len(rows) == 2 and
                    [str(row.get("id")) for row in rows] == ["1", "2"] and
                    [row.get("name") for row in rows] == ["Ada", "Lin"],
                    "actual downloaded JSON records are incorrect")
    cdp.call("Page.reload", {"ignoreCache": True})
    ui_wait(cdp, 'Boolean(window.__spoolTest) && window.__spoolTest.state().job.phase === "COMPLETE"',
            "durable IndexedDB reload restoration")
    require(cdp.eval('location.pathname') == "/studio/validate", "reload lost the seven-stage route")
    require(cdp.eval('window.__spoolTest.state().output.length') == 2,
            "durable reload lost output records")
    click(cdp, '[data-flow-action="new-source"]', "/studio/original")
    ui_wait(cdp, 'window.__spoolTest.state().job.phase === "EMPTY"', "fresh source after completion")


def simple_xlsx(path, hidden=False):
    workbook = ('<workbook><sheets>'
        + ('<sheet name="Hidden" state="hidden" r:id="rId2"/>' if hidden else '')
        + '<sheet name="People" r:id="rId1"/></sheets></workbook>')
    sheet = ('<worksheet><sheetData>'
        '<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c>'
        '<c r="B1" t="inlineStr"><is><t>name</t></is></c></row>'
        '<row r="2"><c r="A2" t="inlineStr"><is><t>1</t></is></c>'
        '<c r="B2" t="inlineStr"><is><t>Ada</t></is></c></row>'
        '<row r="3"><c r="A3" t="inlineStr"><is><t>2</t></is></c>'
        '<c r="B3" t="inlineStr"><is><t>Lin</t></is></c></row>'
        '</sheetData></worksheet>')
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=False) as z:
        z.writestr("xl/workbook.xml", workbook)
        z.writestr("xl/_rels/workbook.xml.rels", '<Relationships>'
            '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>'
            '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>'
            '</Relationships>')
        z.writestr("xl/worksheets/sheet1.xml", sheet)
        if hidden:
            z.writestr("xl/worksheets/sheet2.xml",
                       '<worksheet><sheetData><row r="1"><c t="inlineStr"><is><t>secret</t></is></c></row></sheetData></worksheet>')


def csv_near_limit(path):
    row = b'123,Ada-' + b'x' * 72 + b'\n'
    header = b'id,name\n'
    target = 49 * MiB
    count = 0
    with path.open("wb") as stream:
        stream.write(header)
        while stream.tell() + len(row) < target:
            stream.write(row)
            count += 1
    require(48 * MiB <= path.stat().st_size <= MAX_INPUT, "CSV fixture not at upper accepted boundary")
    require(count < 1_000_000, "CSV fixture exceeded row ceiling")
    return count


def expansion_bomb(path):
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=False) as z:
        z.writestr("xl/workbook.xml", '<workbook><sheets><sheet name="Data" r:id="rId1"/></sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels",
                   '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
        with z.open("xl/worksheets/sheet1.xml", "w", force_zip64=False) as entry:
            block = b" " * MiB
            for _ in range(257):
                entry.write(block)
    require(path.stat().st_size < MAX_INPUT, "expansion fixture should be compressed below input limit")


def chrome_heap_bytes(cdp):
    metrics = cdp.call("Performance.getMetrics").get("metrics", [])
    fields = {item["name"]: item["value"] for item in metrics}
    value = fields.get("JSHeapUsedSize")
    require(isinstance(value, (int, float)) and value > 0, "Chrome JS heap measurement unavailable")
    return int(value)


def main():
    global assertions
    sha = source_sha()
    # Test data, a temporary Chrome profile and generated XLSX workbooks share
    # the OS temp volume. Do not quietly fall back to a nearly full C: drive.
    scratch = Path(tempfile.gettempdir()).resolve()
    require(scratch.is_dir(), "Windows qualification scratch volume is unavailable")
    free = shutil.disk_usage(scratch).free
    require(free >= 3 * 1024 ** 3,
            f"Browser qualification requires >=3 GiB scratch free; {scratch} has only {free} bytes")
    require(DIST.is_dir() and (DIST / "release.json").is_file(), "built dist/release.json missing")
    release = json.loads((DIST / "release.json").read_text(encoding="utf8"))
    require(release.get("commit") == sha,
            "built dist is not bound to current source SHA")
    browser = resolve_browser()
    temp = Path(tempfile.mkdtemp(prefix="spool-real-ui-"))
    server = chrome = profile = log_handle = cdp = sampler = None
    browser_log = None
    measurements = {}
    evidence = Path(os.environ.get('SPOOL_QUALIFICATION_EVIDENCE_ROOT', str(ROOT.parent / 'evidence'))) / 'browser-attempts' / sha / str(time.time_ns())
    require(ROOT not in evidence.resolve().parents, 'Browser evidence must remain outside the checkout')
    evidence.mkdir(parents=True)
    passed = False
    try:
        (temp / "downloads").mkdir()
        small_csv = temp / "people.csv"
        small_csv.write_bytes(b"id,name\n1,Ada\n2,Lin\n")
        xlsx = temp / "people.xlsx"
        simple_xlsx(xlsx, hidden=True)
        malformed = temp / "corrupt.xlsx"
        malformed.write_bytes(b"not a ZIP workbook")
        oversized = temp / "oversized.csv"
        with oversized.open("wb") as stream:
            stream.truncate(MAX_INPUT + 1)
        server = subprocess.Popen([
            sys.executable, str(ROOT / "scripts/spa-server.py"),
            "--port", "8876", "--directory", str(DIST)
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wait_for(lambda: server.poll() is None and (DIST / "release.json").is_file(),
                 label="local SPA server process running")
        chrome, profile, log_handle, browser_log = launch_browser_with_cdp(browser)
        sampler = ProcessSampler(chrome.pid)
        sampler.start()
        pages = get_json("http://127.0.0.1:" + str(CDP_PORT) + "/json")
        page = next(p for p in pages if p.get("type") == "page")
        cdp = CDP(page["webSocketDebuggerUrl"])
        sampler.attach_heap(page["webSocketDebuggerUrl"])
        for domain in ["Runtime", "Page", "Network", "Performance", "Log"]:
            cdp.call(domain + ".enable")
        base = "http://127.0.0.1:8876"
        open_ui(cdp, base)
        # Enforce the shipped privacy boundary against an actual blocked fetch.
        meta = cdp.eval('document.querySelector("meta[http-equiv=Content-Security-Policy]")?.content || ""')
        require("connect-src 'none'" in meta, "built Studio CSP lacks network prohibition")
        require(cdp.eval('fetch("https://example.com/spool-qualifier").then(()=>false,()=>true)') is True,
                "real browser permitted cross-origin data connection under CSP")

        # Force a real IndexedDB write rejection from a file-input action.
        # This is an injected storage fault, not a claim that disk quota is measured.
        cdp.eval('window.__originalPut = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function(){throw new DOMException("Storage capacity exhausted","QuotaExceededError")}')
        upload(cdp, small_csv, should_reject=True)
        require(cdp.eval('window.__spoolTest.viewState().job.phase') != "COMPLETE",
                "IndexedDB quota failure created false COMPLETE")
        cdp.call("Page.reload", {"ignoreCache": True})
        ui_wait(cdp, 'Boolean(window.__spoolTest) && Boolean(document.querySelector("[data-spool-flow-root]"))',
                "kernel reload after storage write fault")
        require(cdp.eval('window.__spoolTest.viewState().job.phase') != "COMPLETE",
                "reload exposed false success after failed IndexedDB write")

        upload(cdp, xlsx, expected_rows=2)
        require("People" in cdp.eval("document.body.innerText") or
                cdp.eval("window.__spoolTest.viewState().source.rows.length") == 2,
                "first visible XLSX sheet was not accepted")
        workflow(cdp, b"id,name\r\n1,Ada\r\n2,Lin", temp / "downloads")

        upload(cdp, small_csv, expected_rows=2)
        workflow(cdp, b"id,name\r\n1,Ada\r\n2,Lin", temp / "downloads")

        upload(cdp, malformed, should_reject=True)
        require(cdp.eval('window.__spoolTest.viewState().job.phase') == "EMPTY",
                "malformed workbook mutated empty workspace")
        oversized_csv = temp / "max.csv"
        size_start = time.monotonic()
        rows = csv_near_limit(oversized_csv)
        upload(cdp, oversized_csv, expected_rows=rows, timeout=240)
        measurements["csv49MiBUploadSeconds"] = round(time.monotonic() - size_start, 2)
        measurements["csvBytes"] = oversized_csv.stat().st_size
        measurements["csvRows"] = rows
        measurements["heapAfterCsvBytes"] = chrome_heap_bytes(cdp)
        open_ui(cdp, base)
        upload(cdp, oversized, should_reject=True)
        require(cdp.eval('window.__spoolTest.viewState().job.phase') == "SOURCE_READY",
                "oversized file corrupted previously valid source")
        bomb = temp / "zip-bomb.xlsx"
        expansion_bomb(bomb)
        open_ui(cdp, base)
        upload(cdp, bomb, should_reject=True, timeout=240)
        require(cdp.eval('window.__spoolTest.viewState().job.phase') == "SOURCE_READY",
                "expanded XLSX rejection destroyed the previously accepted source")
        measurements["heapAfterZipBombBytes"] = chrome_heap_bytes(cdp)
        measurements["maxInputBytes"] = MAX_INPUT

        # A real near-limit compressed XLSX workload is mandatory as well;
        # absent that measurement, this test MUST NOT authorize release.
        large_xlsx = temp / "max.xlsx"
        build_large_xlsx(large_xlsx)
        open_ui(cdp, base)
        import_started = time.monotonic()
        upload(cdp, large_xlsx, timeout=300)
        measurements["xlsxImportSeconds"] = round(time.monotonic() - import_started, 2)
        measurements["xlsxBytes"] = large_xlsx.stat().st_size
        measurements["xlsxRows"] = cdp.eval("window.__spoolTest.viewState().source.rows.length")
        measurements["heapAfterXlsxBytes"] = chrome_heap_bytes(cdp)

        # Explicit manual run and browser termination/reload prove checkpoint
        # recovery on the genuinely uploaded near-limit source.
        open_ui(cdp, base, "/studio/transform")
        click(cdp, '[data-flow-outcome="clean_standardize"]')
        click(cdp, '[data-flow-action="approve-plan"]', "/studio/test")
        click(cdp, '[data-flow-action="run-preview"]')
        ui_wait(cdp, 'document.body.innerText.includes("TEST OUTPUT") || document.body.innerText.includes("Transformed sample")',
                "large-workload noncommitting preview", timeout=95)
        click(cdp, '[data-flow-route="/studio/process"]', "/studio/process")
        click(cdp, '[data-flow-action="start-process"]')
        ui_wait(cdp, 'window.__spoolTest.viewState().job.phase === "RUNNING" && window.__spoolTest.viewState().job.checkpoint > 0',
                "large-worker active durable checkpoint", timeout=120)
        measurements["checkpointBeforeForcedReload"] = cdp.eval('window.__spoolTest.viewState().job.checkpoint')
        cdp.call("Page.reload", {"ignoreCache": True})
        ui_wait(cdp, 'Boolean(window.__spoolTest) && window.__spoolTest.viewState().job.phase === "PAUSED_RECOVERED"',
                "manual Worker reload recovery", timeout=80)
        require(cdp.eval('window.__spoolTest.viewState().job.checkpoint') >=
                measurements["checkpointBeforeForcedReload"],
                "forced browser refresh regressed acknowledged checkpoint")
        click(cdp, '[data-flow-action="resume-process"]')
        ui_wait(cdp, 'window.__spoolTest.viewState().job.phase === "COMPLETE"',
                "replayed or resumed large-worker completion", timeout=420)
        recovered = cdp.eval('window.__spoolTest.viewState().job')
        require(recovered["processedRows"] == measurements["xlsxRows"] and
                recovered["validRows"] + recovered["invalidRows"] == recovered["processedRows"],
                "recovered Worker final rows differ from input or double-count")
        measurements["recoveredRows"] = recovered["processedRows"]

        sampler.stop()
        measurements["chromePeakTreeRssBytes"] = sampler.peak_rss
        measurements["chromeRssSamples"] = sampler.samples
        measurements['observedPeakMainPageHeapBytes'] = sampler.heap_peak
        measurements['mainPageHeapSamples'] = sampler.heap_samples
        require(sampler.heap_samples > 0, 'Continuous Chrome heap sampler did not execute')
        require(not sampler.measurement_errors, 'Chrome resource measurement failed: ' + repr(sampler.measurement_errors[:2]))
        require(measurements["chromePeakTreeRssBytes"] <
                int(os.environ.get("SPOOL_BROWSER_MAX_TREE_RSS_MIB", "4096")) * MiB,
                "Chrome process-tree RSS exceeded the measured release budget")
        require(max(sampler.heap_peak, measurements["heapAfterCsvBytes"], measurements["heapAfterZipBombBytes"],
                    measurements["heapAfterXlsxBytes"]) <
                int(os.environ.get("SPOOL_BROWSER_MAX_HEAP_MIB", "2500")) * MiB,
                "Chrome JS heap exceeded the measured release budget")
        require(measurements["csv49MiBUploadSeconds"] <= 240 and
                measurements["xlsxImportSeconds"] <= 300,
                "maximum-source Studio import exceeded bounded elapsed-time budget")
        exceptions = [e for e in cdp.events if e.get("method") == "Runtime.exceptionThrown"]
        require(not exceptions, "real Chrome logged runtime exceptions: " + repr(exceptions[:2]))
        passed = True
        print(json.dumps({"qualification": "browser_ui", "measurements": measurements,
                          "assertions": assertions}), flush=True)
        print("SPOOL_EVIDENCE_JSON=" + json.dumps({
            "surface": "browser_ui", "status": "PASS", "commitSha": sha,
            "actualExecution": True, "assertions": assertions,
            "measurements": measurements
        }, separators=(",", ":")), flush=True)
    finally:
        if sampler and sampler.thread.is_alive():
            sampler.stop()
        if sampler:
            measurements.update({'chromePeakTreeRssBytes': sampler.peak_rss, 'chromeRssSamples': sampler.samples,
                                 'observedPeakMainPageHeapBytes': sampler.heap_peak, 'mainPageHeapSamples': sampler.heap_samples})
            (evidence / 'resource-samples.json').write_text(json.dumps(sampler.records), encoding='utf8')
            if sampler.heap_cdp:
                sampler.heap_cdp.close()
        if cdp:
            (evidence / 'cdp-events.json').write_text(json.dumps(cdp.events), encoding='utf8')
            try:
                shot = cdp.call('Page.captureScreenshot', {'format': 'png'})
                (evidence / 'last-page.png').write_bytes(base64.b64decode(shot['data']))
            except Exception as capture_error:
                (evidence / 'screenshot-error.txt').write_text(repr(capture_error), encoding='utf8')
        (evidence / 'attempt.json').write_text(json.dumps({'commitSha': sha, 'status': 'PASS' if passed else 'BLOCKED',
                                                       'assertionsAttempted': assertions, 'measurements': measurements}, indent=2), encoding='utf8')
        print('BROWSER_ATTEMPT_EVIDENCE=' + str(evidence), flush=True)
        if cdp:
            cdp.close()
        stop_process(chrome)
        if log_handle:
            log_handle.close()
        if browser_log:
            shutil.copyfile(browser_log, evidence / 'chrome.log')
        stop_process(server)
        if profile:
            shutil.rmtree(profile, ignore_errors=True)
        shutil.rmtree(temp, ignore_errors=True)


def build_large_xlsx(path):
    """Fit actual compressed 48–50 MiB workload without silent smaller samples."""
    rows = 178_000
    for _ in range(4):
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6,
                             allowZip64=False) as z:
            z.writestr("xl/workbook.xml", '<workbook><sheets><sheet name="Data" r:id="rId1"/></sheets></workbook>')
            z.writestr("xl/_rels/workbook.xml.rels",
                       '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
            with z.open("xl/worksheets/sheet1.xml", "w") as stream:
                stream.write(b'<worksheet><sheetData>')
                stream.write(b'<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c>'
                             b'<c r="B1" t="inlineStr"><is><t>payload</t></is></c></row>')
                for i in range(2, rows + 2):
                    # Reproducible, high-entropy printable cells for realistic
                    # compressed file size; no nondeterministic test evidence.
                    cell = hashlib.shake_256(str(i).encode("ascii")).hexdigest(224)
                    stream.write(('<row r="' + str(i) + '"><c r="A' + str(i)
                                  + '"><v>' + str(i - 1) + '</v></c><c r="B' + str(i)
                                  + '" t="inlineStr"><is><t>' + cell
                                  + '</t></is></c></row>').encode("ascii"))
                stream.write(b'</sheetData></worksheet>')
        total = path.stat().st_size
        if 48 * MiB <= total <= MAX_INPUT:
            return
        rows = max(1, round(rows * (49 * MiB) / max(1, total)))
        require(rows <= 1_000_000, "XLSX compressed-boundary generator exceeded row cap")
    raise AssertionError("Unable to generate genuine 48–50 MiB compressed XLSX workbook")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("SPOOL browser_ui FAIL: " + repr(error), file=sys.stderr, flush=True)
        sys.exit(1)
