#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
import websocket

CDP_PORT = 9337
BASE_URL = os.environ.get('SPOOL_URL', 'http://127.0.0.1:8876').rstrip('/')
CSV_PATH = os.environ['SPOOL_NYC_BROWSER_CSV']
HUGE_PATH = os.environ['SPOOL_NYC_HUGE_CSV']
EXPECTED_SHA = os.environ['SPOOL_CANDIDATE_SHA'].lower()
EXPECTED_ROWS = 43000


def get_json(url):
    with urllib.request.urlopen(url, timeout=5) as response:
        return json.load(response)


def wait_for(fn, timeout=30, interval=.2, label='condition'):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = fn()
            if last:
                return last
        except Exception as exc:
            last = exc
        time.sleep(interval)
    raise AssertionError(f'Timed out waiting for {label}; last={last!r}')


class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=15)
        self.ident = 0
        self.events = []

    def call(self, method, params=None):
        self.ident += 1
        ident = self.ident
        self.ws.send(json.dumps({'id': ident, 'method': method, 'params': params or {}}))
        while True:
            message = json.loads(self.ws.recv())
            if message.get('id') == ident:
                if 'error' in message:
                    raise RuntimeError(f"CDP {method}: {message['error']}")
                return message.get('result', {})
            self.events.append(message)

    def eval(self, expression):
        result = self.call('Runtime.evaluate', {
            'expression': expression,
            'returnByValue': True,
            'awaitPromise': True
        })
        if 'exceptionDetails' in result:
            raise RuntimeError(result['exceptionDetails'])
        return result.get('result', {}).get('value')

    def close(self):
        self.ws.close()


def upload(cdp, path):
    doc = cdp.call('DOM.getDocument', {'depth': -1, 'pierce': True})
    node = cdp.call('DOM.querySelector', {'nodeId': doc['root']['nodeId'], 'selector': '#source-file'}).get('nodeId')
    if not node:
        raise AssertionError('Missing #source-file')
    cdp.call('DOM.setFileInputFiles', {'nodeId': node, 'files': [path]})
    cdp.eval("document.querySelector('#source-file').dispatchEvent(new Event('change',{bubbles:true}))")


def wait_terminal(cdp, label):
    return wait_for(lambda: cdp.eval("""(() => {
      const s = window.__spoolTest.state();
      if (['COMPLETE','FAILED','ABORTED'].includes(s.job.phase) || s.mission?.status === 'NEEDS_ATTENTION') {
        return {phase:s.job.phase, mission:s.mission?.status, processed:s.job.processedRows, valid:s.job.validRows, invalid:s.job.invalidRows};
      }
      return null;
    })()"""), timeout=420, interval=.5, label=label)


def validate_result(cdp, expected_rows, preserve=False):
    metrics = cdp.eval("""(async () => {
      const s = window.__spoolTest.state();
      const { validateOutputRow } = await import('/src/core/schema.js');
      const { parseCsv } = await import('/src/core/csv.js');
      let invalidOutputRows = 0;
      let firstOutputError = null;
      for (let i = 0; i < s.output.length; i++) {
        try { validateOutputRow(s.output[i], s.targetSchema); }
        catch (error) {
          invalidOutputRows += 1;
          if (!firstOutputError) firstOutputError = { index:i, code:error?.code, message:error?.message };
        }
      }
      const exported = await window.__spoolTest.invoke('export_csv', {});
      let exportRows = null, exportFields = null, exportError = null;
      if (exported.ok) {
        try {
          const parsed = parseCsv(exported.result.content);
          exportRows = parsed.rows.length;
          exportFields = parsed.headers.length;
        } catch (error) { exportError = {code:error?.code, message:error?.message}; }
      }
      const localEvidence = (s.mission?.evidence ?? []).filter(e => e.inferredType === 'local_datetime');
      const localTargets = new Set(localEvidence.map(e => e.targetField));
      let timezoneInvented = 0;
      for (const row of s.output.slice(0, 500)) {
        for (const field of localTargets) {
          const value = row[field];
          if (typeof value === 'string' && (value.endsWith('Z') || /[+-]\\d{2}:?\\d{2}$/.test(value))) timezoneInvented += 1;
        }
      }
      return {
        sourceRows:s.source.rows.length,
        sourceFields:s.source.headers.length,
        processedRows:s.job.processedRows,
        validRows:s.job.validRows,
        invalidRows:s.job.invalidRows,
        outputRows:s.output.length,
        targetFields:s.targetSchema.length,
        phase:s.job.phase,
        mission:s.mission?.status,
        dryRun:s.mission?.dryRun,
        localDateTimeFields:[...localTargets],
        timezoneInvented,
        invalidOutputRows,
        firstOutputError,
        exportOk:exported.ok,
        exportRows,
        exportFields,
        exportError,
        violationGroups:(s.violations ?? []).map(v => ({code:v.code,count:v.count}))
      };
    })()""")
    assert metrics['sourceRows'] == expected_rows, metrics
    assert metrics['processedRows'] == expected_rows, metrics
    assert metrics['validRows'] + metrics['invalidRows'] == expected_rows, metrics
    assert metrics['outputRows'] == metrics['validRows'], metrics
    assert metrics['invalidOutputRows'] == 0, metrics
    assert metrics['exportOk'] and metrics['exportRows'] == metrics['validRows'] and not metrics['exportError'], metrics
    assert metrics['phase'] == 'COMPLETE', metrics
    expected_mission = 'COMPLETE_VERIFIED' if metrics['invalidRows'] == 0 else 'COMPLETE_WITH_REJECTIONS'
    assert metrics['mission'] == expected_mission, metrics
    dry = metrics.get('dryRun') or {}
    assert dry.get('processedRows') == 100, dry
    assert dry.get('minimumAcceptance') == 0.95, dry
    assert dry.get('sampling') == 'evenly_spaced_full_source', dry
    assert dry.get('assessment') in ('PASS', 'WARNING'), dry
    if preserve:
        assert metrics['validRows'] == expected_rows and metrics['invalidRows'] == 0, metrics
    else:
        assert metrics['validRows'] > 0, metrics
        assert len(metrics['localDateTimeFields']) > 0, metrics
        assert metrics['timezoneInvented'] == 0, metrics
    return metrics


def reset(cdp):
    response = cdp.eval("window.__spoolTest.invoke('start_new_migration', {})")
    if not response.get('ok'):
        raise AssertionError(response)
    wait_for(lambda: cdp.eval("window.__spoolTest.state().job.phase === 'EMPTY'"), timeout=30, label='workspace reset')
    cdp.call('Page.navigate', {'url': BASE_URL + '/studio/new'})
    wait_for(lambda: cdp.eval('Boolean(window.__spoolTest)'), timeout=30, label='Studio reload')


def main():
    with urllib.request.urlopen(BASE_URL + '/release.json', timeout=10) as response:
        release = json.load(response)
    assert str(release.get('commit', '')).lower() == EXPECTED_SHA, (release, EXPECTED_SHA)
    assert os.path.getsize(CSV_PATH) < 50 * 1024 * 1024, os.path.getsize(CSV_PATH)
    assert os.path.getsize(HUGE_PATH) > 50 * 1024 * 1024, os.path.getsize(HUGE_PATH)

    browser = shutil.which(os.environ.get('SPOOL_BROWSER', 'google-chrome'))
    if not browser:
        raise SystemExit('google-chrome not found')
    profile = tempfile.mkdtemp(prefix='spool-nyc-chrome-')
    chrome = subprocess.Popen([
        browser, '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--disable-background-networking', '--remote-allow-origins=*',
        f'--remote-debugging-port={CDP_PORT}', '--js-flags=--max-old-space-size=4096',
        f'--user-data-dir={profile}', BASE_URL + '/studio/new'
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    cdp = None
    report = {'candidateSha': EXPECTED_SHA, 'release': release, 'browserCsvBytes': os.path.getsize(CSV_PATH), 'hugeCsvBytes': os.path.getsize(HUGE_PATH)}
    try:
        wait_for(lambda: get_json(f'http://127.0.0.1:{CDP_PORT}/json'), timeout=20, label='Chrome CDP')
        page = next(p for p in get_json(f'http://127.0.0.1:{CDP_PORT}/json') if p.get('type') == 'page')
        cdp = CDP(page['webSocketDebuggerUrl'])
        for method in ('Runtime.enable','Page.enable','Network.enable','Log.enable','DOM.enable'):
            cdp.call(method)
        wait_for(lambda: cdp.eval('Boolean(window.__spoolTest)'), timeout=30, label='SPOOL bootstrap')

        started = time.time()
        upload(cdp, CSV_PATH)
        wait_for(lambda: cdp.eval("window.__spoolTest.state().job.phase === 'SOURCE_READY'"), timeout=180, interval=.25, label='43k NYC load')
        assert cdp.eval('window.__spoolTest.state().source.rows.length') == EXPECTED_ROWS
        report['databaseReadyLoadSeconds'] = round(time.time() - started, 3)
        started = time.time()
        response = cdp.eval("window.__spoolTest.runAutopilot('database_ready')")
        assert response.get('ok'), response
        assert response.get('result', {}).get('status') != 'NEEDS_ATTENTION', response
        report['databaseReadyTerminal'] = wait_terminal(cdp, '43k database_ready terminal')
        report['databaseReadySeconds'] = round(time.time() - started, 3)
        report['databaseReady'] = validate_result(cdp, EXPECTED_ROWS, preserve=False)

        reset(cdp)
        upload(cdp, CSV_PATH)
        wait_for(lambda: cdp.eval("window.__spoolTest.state().job.phase === 'SOURCE_READY'"), timeout=180, interval=.25, label='43k preserve load')
        started = time.time()
        response = cdp.eval("window.__spoolTest.runAutopilot('preserve_contract')")
        assert response.get('ok'), response
        assert response.get('result', {}).get('status') != 'NEEDS_ATTENTION', response
        report['preserveTerminal'] = wait_terminal(cdp, '43k preserve terminal')
        report['preserveSeconds'] = round(time.time() - started, 3)
        report['preserveContract'] = validate_result(cdp, EXPECTED_ROWS, preserve=True)

        before = cdp.eval("window.__spoolTest.state().source.fingerprint")
        upload(cdp, HUGE_PATH)
        time.sleep(1.5)
        huge = cdp.eval("""(() => ({
          fingerprint:window.__spoolTest.state().source?.fingerprint,
          phase:window.__spoolTest.state().job.phase,
          toast:document.querySelector('#toast')?.textContent || ''
        }))()""")
        assert huge['fingerprint'] == before, huge
        assert '50 MB' in huge['toast'], huge
        report['browserHugeRefusal'] = huge

        exceptions = [e for e in cdp.events if e.get('method') == 'Runtime.exceptionThrown']
        failed = [e for e in cdp.events if e.get('method') == 'Network.loadingFailed' and not e.get('params', {}).get('canceled')]
        severe = [e for e in cdp.events if e.get('method') == 'Log.entryAdded' and e.get('params', {}).get('entry', {}).get('level') in ('error','warning')]
        report['diagnostics'] = {'runtimeExceptions':len(exceptions),'failedNetworkLoads':len(failed),'warningOrErrorLogs':len(severe)}
        if exceptions or failed or severe:
            report['diagnostics']['samples'] = {'exceptions':exceptions[:2],'failed':failed[:2],'logs':severe[:2]}
            raise AssertionError(report['diagnostics'])
        report['status'] = 'PASS'
        print(json.dumps(report, indent=2), flush=True)
    finally:
        if cdp: cdp.close()
        chrome.terminate()
        try: chrome.wait(timeout=5)
        except subprocess.TimeoutExpired: chrome.kill()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == '__main__':
    main()
