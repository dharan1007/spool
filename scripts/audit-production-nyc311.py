#!/usr/bin/env python3
import base64
import csv
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE_URL = os.environ.get('SPOOL_AUDIT_URL', 'https://spool-webmcp.vercel.app').rstrip('/')
EXPECTED_SHA = os.environ.get('SPOOL_EXPECTED_SHA', 'feb1cfaab15c44522c594d008a8b0190f400ff52').lower()
DATASET_API = 'https://data.cityofnewyork.us/resource/erm2-nwe9.csv'
MIB = 1024 * 1024

spec = importlib.util.spec_from_file_location('spool_browser_smoke', os.path.join(ROOT, 'scripts', 'browser-smoke.py'))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def curl_dataset(limit, output):
    cmd = [
        'curl', '-fL', '--retry', '4', '--retry-delay', '2', '--compressed', '-G', DATASET_API,
        '--data-urlencode', f'$limit={limit}',
        '--data-urlencode', '$order=unique_key DESC',
        '-H', 'User-Agent: SPOOL-production-audit/1.0',
        '-o', output,
    ]
    started = time.time()
    subprocess.run(cmd, check=True)
    return time.time() - started


def ensure_huge_dataset(workdir):
    for limit in (100_000, 150_000, 220_000):
        path = os.path.join(workdir, f'nyc311-{limit}.csv')
        elapsed = curl_dataset(limit, path)
        size = os.path.getsize(path)
        print(json.dumps({'datasetDownloadRowsRequested': limit, 'bytes': size, 'seconds': round(elapsed, 2)}), flush=True)
        if size > 52 * MIB:
            return path, limit
    raise AssertionError('Could not obtain an official NYC 311 CSV larger than 52 MiB')


def derive_large_subset(source, output, target_bytes=34 * MIB):
    rows = 0
    with open(source, 'r', encoding='utf-8-sig', newline='') as src, open(output, 'w', encoding='utf-8', newline='') as dst:
        reader = csv.reader(src)
        writer = csv.writer(dst, lineterminator='\n')
        header = next(reader)
        writer.writerow(header)
        for row in reader:
            writer.writerow(row)
            rows += 1
            if rows % 1000 == 0 and dst.tell() >= target_bytes:
                break
    size = os.path.getsize(output)
    if not (20 * MIB <= size < 49 * MIB):
        raise AssertionError(f'Large subset size outside stress band: {size} bytes')
    return rows, len(header), size


def csv_metrics(path, sample_cap=100_000):
    row_count = 0
    columns = 0
    blank_cells = 0
    rows_with_blank = 0
    multiline_cells = 0
    max_cell_length = 0
    formula_like = 0
    distinct_widths = set()
    with open(path, 'r', encoding='utf-8-sig', newline='') as f:
        reader = csv.reader(f)
        header = next(reader)
        columns = len(header)
        for row in reader:
            row_count += 1
            distinct_widths.add(len(row))
            has_blank = False
            for cell in row:
                if cell == '':
                    blank_cells += 1
                    has_blank = True
                if '\n' in cell or '\r' in cell:
                    multiline_cells += 1
                max_cell_length = max(max_cell_length, len(cell))
                if cell.lstrip().startswith(('=', '+', '-', '@')):
                    formula_like += 1
            rows_with_blank += int(has_blank)
            if row_count >= sample_cap:
                break
    return {
        'rowsScanned': row_count,
        'columns': columns,
        'blankCells': blank_cells,
        'rowsWithBlank': rows_with_blank,
        'multilineCells': multiline_cells,
        'maxCellLength': max_cell_length,
        'formulaLikeCells': formula_like,
        'distinctRowWidths': sorted(distinct_widths),
    }


def start_browser(target):
    profile = tempfile.mkdtemp(prefix='spool-audit-chrome-')
    browser = smoke.resolve_browser()
    log_path = os.path.join(profile, 'chrome.log')
    log_handle = open(log_path, 'w+', encoding='utf-8')
    chrome = subprocess.Popen([
        browser, '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--disable-background-networking', '--remote-allow-origins=*', f'--remote-debugging-port={smoke.CDP_PORT}',
        '--js-flags=--max-old-space-size=4096', f'--user-data-dir={profile}', target
    ], stdout=log_handle, stderr=log_handle)
    try:
        smoke.wait_for(lambda: smoke.get_json(f'http://127.0.0.1:{smoke.CDP_PORT}/json'), timeout=15, label='Chrome CDP')
        pages = smoke.get_json(f'http://127.0.0.1:{smoke.CDP_PORT}/json')
        page = next(p for p in pages if p.get('type') == 'page')
        cdp = smoke.CDP(page['webSocketDebuggerUrl'])
        for domain in ('Runtime.enable', 'Page.enable', 'Network.enable', 'Log.enable', 'DOM.enable'):
            cdp.call(domain)
        return chrome, cdp, profile, log_handle
    except Exception:
        log_handle.flush(); log_handle.seek(0)
        details = log_handle.read()[-10000:]
        chrome.terminate()
        raise AssertionError(f'Browser boot failed: {details}')


def upload_file(cdp, path):
    doc = cdp.call('DOM.getDocument', {'depth': -1, 'pierce': True})
    node_id = cdp.call('DOM.querySelector', {'nodeId': doc['root']['nodeId'], 'selector': '#source-file'}).get('nodeId')
    if not node_id:
        raise AssertionError('Missing #source-file input')
    cdp.call('DOM.setFileInputFiles', {'nodeId': node_id, 'files': [path]})
    cdp.eval("document.querySelector('#source-file').dispatchEvent(new Event('change',{bubbles:true}))")


def route_audit(cdp):
    routes = ['/', '/local-runner', '/examples', '/security', '/services', '/docs', '/studio', '/studio/new']
    out = []
    for width, height, mode in ((1440, 1000, 'desktop'), (390, 844, 'mobile')):
        cdp.call('Emulation.setDeviceMetricsOverride', {'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': mode == 'mobile'})
        for route in routes:
            cdp.call('Page.navigate', {'url': BASE_URL + route})
            smoke.wait_for(lambda: cdp.eval('document.readyState === "complete"'), timeout=20, label=f'{route} load')
            smoke.wait_for(lambda: cdp.eval("!document.body.innerText.includes('Loading SPOOL')"), timeout=20, label=f'{route} render')
            metrics = cdp.eval("""(() => ({
              title: document.title,
              h1: document.querySelectorAll('h1').length,
              bodyChars: document.body.innerText.length,
              overflow: document.documentElement.scrollWidth - window.innerWidth,
              brokenImages: [...document.images].filter(i => !i.complete || i.naturalWidth === 0).length,
              emptyLinks: [...document.querySelectorAll('a')].filter(a => !a.textContent.trim() && !a.getAttribute('aria-label')).length
            }))()""")
            out.append({'mode': mode, 'route': route, **metrics})
            if metrics['h1'] != 1 or metrics['bodyChars'] < 100 or metrics['brokenImages'] or metrics['emptyLinks']:
                raise AssertionError(f'Route semantic/render failure: {mode} {route} {metrics}')
            if metrics['overflow'] > 4:
                raise AssertionError(f'Horizontal overflow: {mode} {route} {metrics["overflow"]}px')
    cdp.call('Emulation.clearDeviceMetricsOverride')
    return out


def validate_output_in_page(cdp):
    return cdp.eval("""(async () => {
      const state = window.__spoolTest.state();
      const { validateOutputRow } = await import('/src/core/schema.js');
      const { parseCsv } = await import('/src/core/csv.js');
      let invalidOutputRows = 0;
      let firstError = null;
      for (let i = 0; i < state.output.length; i++) {
        try { validateOutputRow(state.output[i], state.targetSchema); }
        catch (error) { invalidOutputRows++; if (!firstError) firstError = {index:i, code:error?.code, message:error?.message}; }
      }
      const exported = await window.__spoolTest.invoke('export_csv', {});
      let exportRows = null;
      let exportHeaders = null;
      let exportParseError = null;
      if (exported.ok) {
        try {
          const parsed = parseCsv(exported.result.content);
          exportRows = parsed.rows.length;
          exportHeaders = parsed.headers.length;
        } catch (error) { exportParseError = {code:error?.code, message:error?.message}; }
      }
      return {
        sourceRows: state.source.rows.length,
        sourceFields: state.source.headers.length,
        processedRows: state.job.processedRows,
        validRows: state.job.validRows,
        invalidRows: state.job.invalidRows,
        outputRows: state.output.length,
        targetFields: state.targetSchema.length,
        mission: state.mission?.status,
        phase: state.job.phase,
        violations: state.violations?.map(v => ({code:v.code,count:v.count,message:v.message})),
        invalidOutputRows,
        firstError,
        exportOk: exported.ok,
        exportRows,
        exportHeaders,
        exportParseError
      };
    })()""")


def main():
    with urllib.request.urlopen(BASE_URL + '/release.json', timeout=20) as r:
        release = json.load(r)
    assert str(release.get('commit', '')).lower() == EXPECTED_SHA, (release, EXPECTED_SHA)

    workdir = tempfile.mkdtemp(prefix='spool-nyc311-')
    report = {'baseUrl': BASE_URL, 'expectedSha': EXPECTED_SHA, 'release': release, 'dataset': {'source': DATASET_API}}
    chrome = cdp = profile = log_handle = None
    try:
        huge_path, requested = ensure_huge_dataset(workdir)
        huge_size = os.path.getsize(huge_path)
        large_path = os.path.join(workdir, 'nyc311-large.csv')
        large_rows, large_cols, large_size = derive_large_subset(huge_path, large_path)
        report['dataset']['huge'] = {'path': huge_path, 'requestedRows': requested, 'bytes': huge_size, 'metrics': csv_metrics(huge_path)}
        report['dataset']['large'] = {'path': large_path, 'rows': large_rows, 'columns': large_cols, 'bytes': large_size, 'metrics': csv_metrics(large_path)}

        chrome, cdp, profile, log_handle = start_browser(BASE_URL + '/studio/new')
        smoke.wait_for(lambda: cdp.eval('document.readyState === "complete"'), timeout=20, label='production load')
        smoke.wait_for(lambda: cdp.eval('Boolean(window.__spoolTest)'), timeout=20, label='SPOOL bootstrap')

        report['routeAudit'] = route_audit(cdp)
        cdp.call('Page.navigate', {'url': BASE_URL + '/studio/new'})
        smoke.wait_for(lambda: cdp.eval('Boolean(window.__spoolTest)'), timeout=20, label='Studio bootstrap after route audit')

        started = time.time()
        upload_file(cdp, large_path)
        smoke.wait_for(lambda: cdp.eval("window.__spoolTest.state().job.phase === 'SOURCE_READY'"), timeout=180, interval=.25, label='large NYC 311 parse/load')
        parse_seconds = time.time() - started
        loaded_rows = cdp.eval('window.__spoolTest.state().source.rows.length')
        if loaded_rows != large_rows:
            raise AssertionError(f'Loaded row mismatch: browser={loaded_rows}, CSV={large_rows}')

        started = time.time()
        autopilot = cdp.eval("window.__spoolTest.runAutopilot('database_ready')")
        if not autopilot.get('ok'):
            raise AssertionError(f'Autopilot command failed: {autopilot}')
        terminal = smoke.wait_for(
            lambda: cdp.eval("(['COMPLETE','FAILED','ABORTED'].includes(window.__spoolTest.state().job.phase) || window.__spoolTest.state().mission?.status === 'NEEDS_ATTENTION') && window.__spoolTest.state()"),
            timeout=300, interval=.5, label='large NYC 311 terminal state')
        run_seconds = time.time() - started
        validation = validate_output_in_page(cdp)
        validation['parseSeconds'] = round(parse_seconds, 3)
        validation['runSeconds'] = round(run_seconds, 3)
        report['largeProductionRun'] = validation

        if validation['phase'] != 'COMPLETE' or validation['mission'] != 'COMPLETE':
            raise AssertionError(f'Large production run did not complete: {validation}')
        if validation['processedRows'] != validation['sourceRows']:
            raise AssertionError(f'Processed/source mismatch: {validation}')
        if validation['validRows'] + validation['invalidRows'] != validation['processedRows']:
            raise AssertionError(f'Row accounting mismatch: {validation}')
        if validation['outputRows'] != validation['validRows'] or validation['invalidOutputRows'] != 0:
            raise AssertionError(f'Output validity mismatch: {validation}')
        if not validation['exportOk'] or validation['exportRows'] != validation['validRows'] or validation['exportParseError']:
            raise AssertionError(f'Export round-trip mismatch: {validation}')

        # Fresh workspace before testing the hard >50 MiB boundary.
        cdp.eval("window.__spoolTest.invoke('start_new_migration', {})")
        smoke.wait_for(lambda: cdp.eval("window.__spoolTest.state().job.phase === 'EMPTY'"), timeout=30, label='workspace reset')
        cdp.call('Page.navigate', {'url': BASE_URL + '/studio/new'})
        smoke.wait_for(lambda: cdp.eval('Boolean(window.__spoolTest)'), timeout=20, label='Studio bootstrap for huge test')
        upload_file(cdp, huge_path)
        time.sleep(1.5)
        huge_result = cdp.eval("""(() => ({
          phase: window.__spoolTest.state().job.phase,
          hasSource: Boolean(window.__spoolTest.state().source),
          toast: document.querySelector('#toast')?.textContent || ''
        }))()""")
        report['hugeUpload'] = {'bytes': huge_size, **huge_result}
        if huge_result['phase'] != 'EMPTY' or huge_result['hasSource'] or '50 MB' not in huge_result['toast']:
            raise AssertionError(f'>50 MiB boundary did not fail safely: {huge_result}')

        exceptions = [e for e in cdp.events if e.get('method') == 'Runtime.exceptionThrown']
        failed_network = [e for e in cdp.events if e.get('method') == 'Network.loadingFailed' and not e.get('params', {}).get('canceled')]
        severe_logs = [e for e in cdp.events if e.get('method') == 'Log.entryAdded' and e.get('params', {}).get('entry', {}).get('level') in ('error', 'warning')]
        report['browserDiagnostics'] = {'runtimeExceptions': len(exceptions), 'failedNetworkLoads': len(failed_network), 'warningOrErrorLogs': len(severe_logs)}
        if exceptions or failed_network or severe_logs:
            report['browserDiagnostics']['samples'] = {'exceptions': exceptions[:2], 'failedNetwork': failed_network[:2], 'logs': severe_logs[:2]}
            raise AssertionError(f'Browser diagnostics not clean: {report["browserDiagnostics"]}')

        shot = cdp.call('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
        with open('/tmp/spool-audit-final.png', 'wb') as f:
            f.write(base64.b64decode(shot['data']))

        report['status'] = 'PASS'
    except Exception as exc:
        report['status'] = 'FAIL'
        report['failure'] = {'type': type(exc).__name__, 'message': str(exc)}
        raise
    finally:
        with open('/tmp/spool-production-audit.json', 'w', encoding='utf-8') as f:
            json.dump(report, f, indent=2)
        print(json.dumps(report, indent=2), flush=True)
        if cdp:
            try: cdp.close()
            except Exception: pass
        if chrome:
            chrome.terminate()
            try: chrome.wait(timeout=5)
            except subprocess.TimeoutExpired: chrome.kill()
        if log_handle:
            log_handle.close()
        if profile:
            shutil.rmtree(profile, ignore_errors=True)
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == '__main__':
    main()
