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
import traceback
import zipfile
import struct
from pathlib import Path

import psutil
import openpyxl

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
        self.max_frame_gap_ms = 0
        self.max_response_ms = 0
        self.max_bootstrap_response_ms = 0
        self.bootstrapped = False
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
                    started = time.monotonic()
                    before_url = self.heap_cdp.eval('location.href')
                    first_response = time.monotonic()
                    fields = {x['name']: x['value'] for x in self.heap_cdp.call('Performance.getMetrics').get('metrics', [])}
                    second_response = time.monotonic()
                    observation = self.heap_cdp.eval('({url:location.href,frames:window.__qualifierFrames || null})')
                    frames = observation['frames']
                    finished = time.monotonic()
                    probe_ms = {'urlEvaluationMs': (first_response-started)*1000,
                                'performanceMetricsMs': (second_response-first_response)*1000,
                                'frameEvaluationMs': (finished-second_response)*1000}
                    response_ms = max(probe_ms.values())
                    # Attribute initial about:blank/CDP startup separately. Never
                    # exclude SPOOL navigation, bootstrap, reload or recovery.
                    if not self.bootstrapped and frames is None:
                        applicable = False
                    else:
                        self.bootstrapped = True
                        applicable = any(url.startswith('http://127.0.0.1:8876/') for url in (before_url, observation['url']))
                    if applicable:
                        self.max_response_ms = max(self.max_response_ms, response_ms)
                    else:
                        self.max_bootstrap_response_ms = max(self.max_bootstrap_response_ms, response_ms)
                    if frames:
                        self.max_frame_gap_ms = max(self.max_frame_gap_ms, frames['maxGapMs'])
                    heap = fields.get('JSHeapUsedSize', 0)
                    if heap > 0:
                        self.heap_peak = max(self.heap_peak, int(heap))
                        self.heap_samples += 1
                        self.records.append({'monotonicSeconds': time.monotonic(), 'treeRssBytes': rss, 'mainPageHeapBytes': int(heap),
                                             'maxFrameGapMs': self.max_frame_gap_ms, 'maxCdpResponseMs': self.max_response_ms,
                                             'responseMs': response_ms, 'probeTimings': probe_ms, 'probeTotalMs': (finished-started)*1000, 'urlBefore': before_url, 'urlAfter': observation['url'],
                                             'applicationInteraction': applicable, 'bootstrapMaxResponseMs': self.max_bootstrap_response_ms})
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


class SerializedCDP:
    """Share a protocol socket so browser actions and resource probes cannot race."""
    def __init__(self, connection):
        self.connection = connection
        self.lock = threading.RLock()
        self.events = connection.events

    def call(self, method, params=None):
        with self.lock:
            return self.connection.call(method, params)

    def eval(self, expression):
        with self.lock:
            return self.connection.eval(expression)

    def close(self):
        self.connection.close()


def ui_wait(cdp, expr, label, timeout=35):
    return wait_for(lambda: cdp.eval(expr), timeout=timeout, label=label)


def wait_route(cdp, route, timeout=35):
    expected = json.dumps(route)
    ui_wait(cdp, 'location.pathname === ' + expected +
            ' && document.querySelector(".flow-step.current")?.getAttribute("data-flow-route") === ' + expected,
            'rendered Studio route ' + route, timeout=timeout)


def open_ui(cdp, base_url, route="/studio/original"):
    cdp.eval('window.__qualifierNavigationMarker = true')
    cdp.call("Page.navigate", {"url": base_url + route})
    ui_wait(cdp, 'typeof window.__qualifierNavigationMarker === "undefined" && document.readyState === "complete"', "new page ready")
    ui_wait(cdp, 'Boolean(window.__spoolTest) && Boolean(document.querySelector("[data-spool-flow-root]"))',
            "Studio document and kernel")
    wait_route(cdp, route)
    require(cdp.eval("location.pathname") == route, "wrong Studio route")


def reload_ui(cdp):
    cdp.eval('window.__qualifierNavigationMarker = true')
    cdp.call('Page.reload', {'ignoreCache': True})
    ui_wait(cdp, 'typeof window.__qualifierNavigationMarker === "undefined" && document.readyState === "complete" && Boolean(window.__spoolTest)', 'new document after reload')


def click(cdp, selector, route=None):
    # A restored durable phase can become observable before the route finishes
    # rendering. Wait for the real control; never substitute a kernel call.
    ui_wait(cdp, "Boolean(document.querySelector(" + json.dumps(selector) + "))",
            "rendered UI control " + selector)
    require(bool(cdp.eval("Boolean(document.querySelector(" + json.dumps(selector) + "))")),
            "missing real UI control: " + selector)
    cdp.eval("document.querySelector(" + json.dumps(selector) + ").click()")
    if route:
        wait_route(cdp, route)


def upload(cdp, file_path, expected_rows=None, should_reject=False, timeout=180):
    """Drive the real DOM file input via CDP; do not invoke loadCsv directly."""
    for attempt in range(20):
        info = cdp.call("DOM.getDocument")
        node = cdp.call("DOM.querySelector", {
            "nodeId": info["root"]["nodeId"], "selector": "#flow-file"
        })["nodeId"]
        if node > 0:
            try:
                cdp.call("DOM.setFileInputFiles", {
                    "nodeId": node, "files": [str(file_path.resolve())]
                })
                break
            except RuntimeError as selection_error:
                if 'Could not find node with given id' not in str(selection_error):
                    raise
        if attempt == 19:
            raise AssertionError('Studio file input did not stabilize for real file selection')
        time.sleep(.1)
    require(node > 0, "Studio original-file input missing")
    # DOM.setFileInputFiles dispatches a real file change through Chromium;
    # never send a second event, which could race and load the source twice.
    if should_reject:
        ui_wait(cdp, 'Boolean(document.querySelector(".flow-notice.danger, .flow-notice[role=alert]")) || document.body.innerText.includes("File too large") || document.body.innerText.includes("Could not load source")',
                "visible input rejection", timeout=timeout)
        require(cdp.eval("location.pathname") == "/studio/original",
                "rejected file unexpectedly navigated into processing")
        return
    wait_route(cdp, '/studio/inspect', timeout=timeout)
    if expected_rows is not None:
        require(cdp.eval("window.__spoolTest.viewState().source.rows.length") == expected_rows,
                "real uploaded row count did not match source fixture")
    require(cdp.eval("window.__spoolTest.viewState().job.phase") == "SOURCE_READY",
            "file input failed to create SOURCE_READY workspace")


def workflow(cdp, expected_csv, download_dir, expected_json=None):
    expected_json = expected_json or [{'id': 1, 'name': 'Ada'}, {'id': 2, 'name': 'Lin'}]
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
        event_start = len(cdp.events)
        click(cdp, '[data-flow-action="' + action + '"]')
        def download_completed():
            cdp.eval('true')  # Drain Chrome download events on this connection.
            events = cdp.events[event_start:]
            ids = {e['params']['guid'] for e in events
                   if e.get('method') == 'Page.downloadWillBegin' and e['params'].get('suggestedFilename') == name}
            return any(e.get('method') == 'Page.downloadProgress' and
                       e['params'].get('guid') in ids and e['params'].get('state') == 'completed'
                       for e in events)
        wait_for(download_completed, timeout=30, label='Chrome completed download ' + name)
        wait_for(lambda: path.exists() and path.stat().st_size > 0,
                 timeout=20, label="real browser download " + name)
        raw = path.read_bytes()
        if action == "export-csv":
            require(raw == expected_csv, "downloaded CSV bytes do not match independent expected bytes")
        else:
            rows = json.loads(raw)
            require(rows == expected_json,
                    "actual downloaded JSON records are incorrect")
    reload_ui(cdp)
    ui_wait(cdp, 'Boolean(window.__spoolTest) && window.__spoolTest.state().job.phase === "COMPLETE"',
            "durable IndexedDB reload restoration")
    require(cdp.eval('location.pathname') == "/studio/validate", "reload lost the seven-stage route")
    require(cdp.eval('window.__spoolTest.state().output.length') == 2,
            "durable reload lost output records")
    click(cdp, '[data-flow-action="new-source"]', "/studio/original")
    ui_wait(cdp, 'window.__spoolTest.state().job.phase === "EMPTY"', "fresh source after completion")


MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'


def write_zip_part(z, name, raw):
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    z.writestr(info, raw, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)


def package_metadata(z, sheets):
    overrides = ''.join('<Override PartName="/xl/worksheets/sheet' + str(number) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for number in sheets)
    write_zip_part(z, '[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + overrides + '</Types>')
    write_zip_part(z, '_rels/.rels', '<Relationships xmlns="' + PACKAGE_REL_NS + '"><Relationship Id="rId1" Type="' + REL_NS + '/officeDocument" Target="xl/workbook.xml"/></Relationships>')


def simple_xlsx(path, hidden=False):
    workbook = ('<workbook xmlns="' + MAIN_NS + '" xmlns:r="' + REL_NS + '"><sheets>'
        + ('<sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/>' if hidden else '')
        + '<sheet name="People" sheetId="1" r:id="rId1"/></sheets></workbook>')
    sheet = ('<worksheet xmlns="' + MAIN_NS + '"><sheetData>'
        '<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c>'
        '<c r="B1" t="inlineStr"><is><t>name</t></is></c></row>'
        '<row r="2"><c r="A2" t="inlineStr"><is><t>1</t></is></c>'
        '<c r="B2" t="inlineStr"><is><t>Ada</t></is></c></row>'
        '<row r="3"><c r="A3" t="inlineStr"><is><t>2</t></is></c>'
        '<c r="B3" t="inlineStr"><is><t>Lin</t></is></c></row>'
        '</sheetData></worksheet>')
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=False) as z:
        package_metadata(z, [1, 2] if hidden else [1])
        write_zip_part(z, "xl/workbook.xml", workbook)
        write_zip_part(z, "xl/_rels/workbook.xml.rels", '<Relationships xmlns="' + PACKAGE_REL_NS + '">'
            '<Relationship Id="rId1" Type="' + REL_NS + '/worksheet" Target="worksheets/sheet1.xml"/>'
            + ('<Relationship Id="rId2" Type="' + REL_NS + '/worksheet" Target="worksheets/sheet2.xml"/>' if hidden else '') +
            '</Relationships>')
        write_zip_part(z, "xl/worksheets/sheet1.xml", sheet)
        if hidden:
            write_zip_part(z, "xl/worksheets/sheet2.xml",
                       '<worksheet xmlns="' + MAIN_NS + '"><sheetData><row r="1"><c t="inlineStr"><is><t>secret</t></is></c></row></sheetData></worksheet>')


def adversarial_ui_fixtures(temp, template):
    with zipfile.ZipFile(template) as z:
        original = {name: z.read(name) for name in z.namelist()}
    sheet = original['xl/worksheets/sheet1.xml'].decode('utf-8')
    cases = {
        'sparse_row': sheet.replace('<row r="2">', '<row r="999999999">'),
        'duplicate_cell': sheet.replace('r="B2"', 'r="A2"'),
        'mismatched_cell': sheet.replace('r="B2"', 'r="B3"'),
        'invalid_boolean': sheet.replace('<c r="B2" t="inlineStr"><is><t>Ada</t></is></c>', '<c r="B2" t="b"><v>garbage</v></c>'),
        'invalid_iso_date': sheet.replace('<c r="B2" t="inlineStr"><is><t>Ada</t></is></c>', '<c r="B2" t="d"><v>2023-02-30</v></c>'),
        'missing_shared_string': sheet.replace('<c r="B2" t="inlineStr"><is><t>Ada</t></is></c>', '<c r="B2" t="s"><v>99</v></c>'),
        'formula_without_cache': sheet.replace('<c r="B2" t="inlineStr"><is><t>Ada</t></is></c>', '<c r="B2"><f>1+1</f></c>'),
        'error_cell': sheet.replace('<c r="B2" t="inlineStr"><is><t>Ada</t></is></c>', '<c r="B2" t="e"><v>#REF!</v></c>'),
        'serial_60': sheet.replace('<c r="B2" t="inlineStr"><is><t>Ada</t></is></c>', '<c r="B2" s="0"><v>60</v></c>'),
    }
    fixtures = []
    for name, xml in cases.items():
        parts = dict(original)
        parts['xl/worksheets/sheet1.xml'] = xml.encode('utf-8')
        if name == 'serial_60':
            parts['xl/styles.xml'] = b'<styleSheet><cellXfs><xf numFmtId="14"/></cellXfs></styleSheet>'
        path = temp / (name + '.xlsx')
        with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=False) as z:
            for part, raw in parts.items(): write_zip_part(z, part, raw)
        fixtures.append((name, path))
    for name in ['wrong_crc', 'duplicate_zip_entry', 'actual_size_overrun']:
        path = temp / (name + '.xlsx')
        with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=False) as z:
            for part, raw in original.items(): write_zip_part(z, part, raw)
            if name == 'duplicate_zip_entry': write_zip_part(z, 'xl/workbook.xml', original['xl/workbook.xml'])
            if name == 'actual_size_overrun': write_zip_part(z, 'large.xml', b'A' * (2 * MiB))
        if name != 'duplicate_zip_entry':
            with zipfile.ZipFile(path) as z:
                item = z.getinfo('large.xml' if name == 'actual_size_overrun' else 'xl/workbook.xml')
            raw = bytearray(path.read_bytes())
            central = raw.find(b'PK\x01\x02')
            while raw[central + 46:central + 46 + struct.unpack_from('<H', raw, central + 28)[0]] != item.filename.encode('utf-8'):
                length, extra, comment = struct.unpack_from('<HHH', raw, central + 28)
                central += 46 + length + extra + comment
            if name == 'wrong_crc':
                wrong = item.CRC ^ 1
                struct.pack_into('<I', raw, item.header_offset + 14, wrong)
                struct.pack_into('<I', raw, central + 16, wrong)
            else:
                struct.pack_into('<I', raw, item.header_offset + 22, 8)
                struct.pack_into('<I', raw, central + 24, 8)
            path.write_bytes(raw)
        fixtures.append((name, path))
    for name, raw in {
        'duplicate_csv_header': b'id,id\n1,2\n', 'empty_csv_header': b'id,\n1,Ada\n',
        'unsafe_csv_header': b'__proto__,name\n1,Ada\n', 'wrong_csv_width': b'id,name\n1,Ada,extra\n',
        'unterminated_csv': b'id,name\n1,"Ada', 'invalid_utf8_csv': b'id,name\n1,\xc3(\n'
    }.items():
        path = temp / (name + '.csv'); path.write_bytes(raw); fixtures.append((name, path))
    return fixtures


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
        write_zip_part(z, "xl/workbook.xml", '<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>')
        write_zip_part(z, "xl/_rels/workbook.xml.rels",
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
        independent = openpyxl.load_workbook(xlsx, read_only=True, data_only=True)
        require(next(sheet.title for sheet in independent if sheet.sheet_state == 'visible') == 'People', 'Independent reader disagrees with first visible worksheet')
        require(list(independent['People'].values) == [('id', 'name'), ('1', 'Ada'), ('2', 'Lin')], 'Independent reader disagrees with positive XLSX corpus')
        independent.close()
        malformed = temp / "corrupt.xlsx"
        malformed.write_bytes(b"not a ZIP workbook")
        oversized = temp / "oversized.csv"
        with oversized.open("wb") as stream:
            stream.truncate(MAX_INPUT + 1)
        _smoke.ensure_loopback_port_free(8876, 'Real Studio qualifier HTTP server')
        server = subprocess.Popen([
            sys.executable, str(ROOT / "scripts/spa-server.py"),
            "--port", "8876", "--directory", str(DIST)
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wait_for(lambda: server.poll() is None and (DIST / "release.json").is_file(),
                 label="local SPA server process running")
        chrome, profile, log_handle, browser_log = launch_browser_with_cdp(browser)
        sampler = ProcessSampler(chrome.pid)
        pages = get_json("http://127.0.0.1:" + str(CDP_PORT) + "/json")
        page = next(p for p in pages if p.get("type") == "page")
        cdp = SerializedCDP(CDP(page["webSocketDebuggerUrl"]))
        sampler.attach_heap(page["webSocketDebuggerUrl"])
        for domain in ["Runtime", "Page", "Network", "Performance", "Log"]:
            cdp.call(domain + ".enable")
        cdp.call('Page.addScriptToEvaluateOnNewDocument', {'source': '''
            window.__qualifierFrames = {last:performance.now(),maxGapMs:0,count:0};
            function measureFrame(now) {
                const m=window.__qualifierFrames;
                m.maxGapMs=Math.max(m.maxGapMs,now-m.last); m.last=now; m.count++;
                requestAnimationFrame(measureFrame);
            }
            requestAnimationFrame(measureFrame);
        '''})
        base = "http://127.0.0.1:8876"
        open_ui(cdp, base)
        sampler.start()
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
        reload_ui(cdp)
        ui_wait(cdp, 'Boolean(window.__spoolTest) && Boolean(document.querySelector("[data-spool-flow-root]"))',
                "kernel reload after storage write fault")
        require(cdp.eval('window.__spoolTest.viewState().job.phase') != "COMPLETE",
                "reload exposed false success after failed IndexedDB write")

        upload(cdp, xlsx, expected_rows=2)
        require("People" in cdp.eval("document.body.innerText") or
                cdp.eval("window.__spoolTest.viewState().source.rows.length") == 2,
                "first visible XLSX sheet was not accepted")
        workflow(cdp, b"id,name\r\n1,Ada\r\n2,Lin", temp / "downloads")

        cached = temp / 'cached-formula.xlsx'
        with zipfile.ZipFile(xlsx) as z:
            parts = {name: z.read(name) for name in z.namelist()}
        parts['xl/worksheets/sheet1.xml'] = parts['xl/worksheets/sheet1.xml'].replace(
            b'<c r="B2" t="inlineStr"><is><t>Ada</t></is></c>',
            b'<c r="B2" t="str"><f>CONCAT("WRONG","WRONG")</f><v>Ada</v></c>')
        with zipfile.ZipFile(cached, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=False) as z:
            for name, raw in parts.items(): write_zip_part(z, name, raw)
        independent = openpyxl.load_workbook(cached, read_only=True, data_only=True)
        require(list(independent['People'].values)[1][1] == 'Ada', 'Independent reader disagrees with saved cached formula result')
        independent.close()
        upload(cdp, cached, expected_rows=2)
        require('cached values only' in cdp.eval('document.body.innerText'), 'Cached-only formula limitation is not visible after import')
        workflow(cdp, b'id,name\r\n1,Ada\r\n2,Lin', temp / 'downloads')

        upload(cdp, small_csv, expected_rows=2)
        workflow(cdp, b"id,name\r\n1,Ada\r\n2,Lin", temp / "downloads")
        injection = temp / 'formula-text.csv'
        injection.write_bytes(b'id,name\n1,=1+1\n2,@name\n')
        upload(cdp, injection, expected_rows=2)
        workflow(cdp, b"id,name\r\n1,'=1+1\r\n2,'@name", temp / 'downloads',
                 [{'id': 1, 'name': '=1+1'}, {'id': 2, 'name': '@name'}])

        upload(cdp, malformed, should_reject=True)
        require(cdp.eval('window.__spoolTest.viewState().job.phase') == "EMPTY",
                "malformed workbook mutated empty workspace")
        measurements['adversarialUiCases'] = []
        for case, path in adversarial_ui_fixtures(temp, xlsx):
            open_ui(cdp, base)
            before = cdp.eval('window.__spoolTest.viewState().source?.fingerprint || null')
            upload(cdp, path, should_reject=True, timeout=35)
            require(cdp.eval('window.__spoolTest.viewState().source?.fingerprint || null') == before,
                    case + ': rejected source changed durable identity')
            message = cdp.eval('document.querySelector(".flow-notice.danger")?.innerText || ""')
            expected = {'sparse_row': 'row index', 'duplicate_cell': 'duplicate cell', 'mismatched_cell': 'cell reference',
                'invalid_boolean': 'boolean', 'invalid_iso_date': 'date', 'missing_shared_string': 'shared-string',
                'formula_without_cache': 'cached', 'error_cell': 'error cell', 'serial_60': 'serial 60',
                'wrong_crc': 'integrity', 'duplicate_zip_entry': 'duplicate', 'actual_size_overrun': 'decompression exceeds',
                'duplicate_csv_header': 'unique', 'empty_csv_header': 'empty', 'unsafe_csv_header': '__proto__',
                'wrong_csv_width': 'columns', 'unterminated_csv': 'quoted', 'invalid_utf8_csv': 'utf-8'}[case]
            require(expected in message.lower(), case + ': refusal did not identify the expected malformed input: ' + message)
            measurements['adversarialUiCases'].append({'case': case, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'observedError': message})
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
        generated_xlsx = build_large_xlsx(large_xlsx)
        independent = openpyxl.load_workbook(large_xlsx, read_only=True, data_only=True)
        require(next(sheet.title for sheet in independent if sheet.sheet_state == 'visible') == 'Data', 'Independent large-workbook sheet selection differs')
        require(sum(1 for _ in independent['Data'].values) - 1 == generated_xlsx['visibleRows'], 'Independent reader found a different large-workbook row count')
        independent.close()
        measurements['independentXlsxReader'] = 'openpyxl ' + openpyxl.__version__
        open_ui(cdp, base)
        import_started = time.monotonic()
        upload(cdp, large_xlsx, expected_rows=generated_xlsx['visibleRows'], timeout=300)
        measurements["xlsxImportSeconds"] = round(time.monotonic() - import_started, 2)
        measurements["xlsxBytes"] = large_xlsx.stat().st_size
        measurements["xlsxRows"] = cdp.eval("window.__spoolTest.viewState().source.rows.length")
        measurements['xlsxExpandedBytes'] = generated_xlsx['expandedBytes']
        measurements['xlsxWorksheetCount'] = 2
        measurements["heapAfterXlsxBytes"] = chrome_heap_bytes(cdp)

        # Explicit manual run and browser termination/reload prove checkpoint
        # recovery on the genuinely uploaded near-limit source.
        click(cdp, '[data-flow-route="/studio/understand"]', '/studio/understand')
        click(cdp, '[data-flow-route="/studio/transform"]', '/studio/transform')
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
        reload_ui(cdp)
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
        measurements['maxAnimationFrameGapMs'] = round(sampler.max_frame_gap_ms, 2)
        measurements['maxMainPageCdpResponseMs'] = round(sampler.max_response_ms, 2)
        measurements['chromeBootstrapMaxCdpResponseMs'] = round(sampler.max_bootstrap_response_ms, 2)
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
        require(sampler.max_frame_gap_ms <= 2000 and sampler.max_response_ms <= 2000,
                'Studio main-thread responsiveness exceeded the two-second qualification budget: ' +
                json.dumps({'frameGapMs': sampler.max_frame_gap_ms, 'responseMs': sampler.max_response_ms}))
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
                                 'observedPeakMainPageHeapBytes': sampler.heap_peak, 'mainPageHeapSamples': sampler.heap_samples,
                                 'maxAnimationFrameGapMs': sampler.max_frame_gap_ms, 'maxMainPageCdpResponseMs': sampler.max_response_ms,
                                 'chromeBootstrapMaxCdpResponseMs': sampler.max_bootstrap_response_ms})
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
    """Two real data sheets, 48–50 MiB compressed; first-visible CSV <=50 MiB.

    The previous single-sheet hex corpus normalized above the CSV parser's
    independent 50 MiB limit. This workbook exercises the full archive limit
    with two equally sized actual worksheets; only Data is visible/imported.
    """
    rows = 89_000
    for _ in range(4):
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6,
                             allowZip64=False) as z:
            package_metadata(z, [1, 2])
            write_zip_part(z, "xl/workbook.xml", '<workbook xmlns="' + MAIN_NS + '" xmlns:r="' + REL_NS + '"><sheets><sheet name="Archive" sheetId="2" state="hidden" r:id="rId2"/><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>')
            write_zip_part(z, "xl/_rels/workbook.xml.rels",
                       '<Relationships xmlns="' + PACKAGE_REL_NS + '"><Relationship Id="rId1" Type="' + REL_NS + '/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="' + REL_NS + '/worksheet" Target="worksheets/sheet2.xml"/></Relationships>')
            for sheet_number in [1, 2]:
              with z.open('xl/worksheets/sheet' + str(sheet_number) + '.xml', 'w') as stream:
                stream.write(('<worksheet xmlns="' + MAIN_NS + '"><sheetData>').encode('ascii'))
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
            with zipfile.ZipFile(path) as archive:
                expanded = sum(entry.file_size for entry in archive.infolist())
            require(expanded <= 256 * MiB, 'accepted workbook exceeds expanded boundary')
            normalized_bound = len(b'id,payload\n') + rows * (len(str(rows)) + 448 + 2)
            require(normalized_bound <= MAX_INPUT, 'visible worksheet exceeds normalized CSV boundary')
            return {'visibleRows': rows, 'expandedBytes': expanded}
        rows = max(1, round(rows * (49 * MiB) / max(1, total)))
        require(rows <= 1_000_000, "XLSX compressed-boundary generator exceeded row cap")
    raise AssertionError("Unable to generate genuine 48–50 MiB compressed XLSX workbook")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        traceback.print_exc()
        print("SPOOL browser_ui FAIL: " + repr(error), file=sys.stderr, flush=True)
        sys.exit(1)
