#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
import websocket

BASE_URL = os.environ.get('SPOOL_URL', 'https://spool-webmcp.vercel.app').rstrip('/')
EXPECTED_SHA = os.environ['SPOOL_EXPECTED_SHA'].lower()


def get_json(url, timeout=5):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.load(response)


def wait_for(fn, timeout=30, interval=.15, label='condition'):
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


def start_browser(browser):
    failures = []
    for attempt in range(1, 4):
        port = 9340 + attempt
        profile = tempfile.mkdtemp(prefix=f'spool-prod-chrome-{attempt}-')
        log_path = os.path.join(profile, 'chrome.log')
        log_handle = open(log_path, 'w+', encoding='utf-8')
        env = os.environ.copy()
        env.pop('DBUS_SESSION_BUS_ADDRESS', None)
        chrome = subprocess.Popen([
            browser,
            '--headless=new',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-background-networking',
            '--no-first-run',
            '--no-default-browser-check',
            '--remote-allow-origins=*',
            '--remote-debugging-address=127.0.0.1',
            f'--remote-debugging-port={port}',
            f'--user-data-dir={profile}',
            'about:blank'
        ], stdout=log_handle, stderr=log_handle, env=env)
        try:
            wait_for(lambda: get_json(f'http://127.0.0.1:{port}/json'), timeout=30, label=f'Chrome CDP attempt {attempt}')
            pages = get_json(f'http://127.0.0.1:{port}/json')
            page = next(p for p in pages if p.get('type') == 'page')
            return chrome, profile, log_handle, CDP(page['webSocketDebuggerUrl'])
        except Exception as exc:
            log_handle.flush()
            log_handle.seek(0)
            details = log_handle.read()[-5000:]
            failures.append({'attempt': attempt, 'exit': chrome.poll(), 'error': repr(exc), 'log': details})
            chrome.terminate()
            try:
                chrome.wait(timeout=5)
            except subprocess.TimeoutExpired:
                chrome.kill()
            log_handle.close()
            shutil.rmtree(profile, ignore_errors=True)
    raise AssertionError(f'Chrome failed to expose CDP after 3 attempts: {failures!r}')


def navigate(cdp, path, label):
    cdp.call('Page.navigate', {'url': BASE_URL + path})
    wait_for(lambda: cdp.eval('document.readyState === "complete"'), timeout=30, label=f'{label} ready')


def main():
    release = get_json(BASE_URL + '/release.json', timeout=20)
    actual = str(release.get('commit', '')).lower()
    if actual != EXPECTED_SHA:
        raise AssertionError(f'Production release mismatch: expected {EXPECTED_SHA}, got {actual}')

    browser = shutil.which(os.environ.get('SPOOL_BROWSER', 'google-chrome'))
    if not browser:
        raise SystemExit('google-chrome not found')

    chrome = profile = log_handle = cdp = None
    report = {'url': BASE_URL, 'expectedSha': EXPECTED_SHA, 'release': release, 'browser': browser}
    try:
        chrome, profile, log_handle, cdp = start_browser(browser)
        for method in ('Runtime.enable', 'Page.enable', 'Network.enable', 'Log.enable'):
            cdp.call(method)

        checks = [
            ('/local-runner', 'GATE B', 'target_write'),
            ('/examples', '5 source records', '3 valid'),
            ('/security', "connect-src 'none'", 'STALE_FENCE'),
            ('/services', 'DEPLOYMENT + SUPPORT', 'Production target writes stay local')
        ]
        for route, a, b in checks:
            navigate(cdp, route, route)
            wait_for(lambda r=route: cdp.eval(f'document.querySelector("[data-product-route=\\"{r}\\"]") !== null'), timeout=20, label=f'{route} product surface')
            text = cdp.eval('document.body.innerText')
            assert a in text, f'{route} missing {a!r}'
            assert b in text, f'{route} missing {b!r}'
            assert 'Migration Preflight' not in text, f'{route} exposes paid Hobby-hosted copy'

        navigate(cdp, '/studio/new', 'studio')
        wait_for(lambda: cdp.eval('Boolean(window.__spoolTest)'), timeout=30, label='SPOOL bootstrap')
        phase = cdp.eval('window.__spoolTest.state().job.phase')
        if phase != 'EMPTY':
            response = cdp.eval("window.__spoolTest.invoke('start_new_migration', {})")
            assert response.get('ok'), response
            wait_for(lambda: cdp.eval("window.__spoolTest.state().job.phase === 'EMPTY'"), timeout=20, label='workspace reset')

        cdp.eval('window.__spoolTest.loadDemo()')
        wait_for(lambda: cdp.eval("window.__spoolTest.state().job.phase === 'SOURCE_READY'"), timeout=30, label='demo source')
        assert cdp.eval('window.__spoolTest.state().source.rows.length') == 25000

        started = time.time()
        response = cdp.eval("window.__spoolTest.runAutopilot('database_ready')")
        assert response.get('ok'), response
        wait_for(lambda: cdp.eval("window.__spoolTest.state().job.phase === 'COMPLETE'"), timeout=90, interval=.25, label='25k production migration')
        state = cdp.eval('window.__spoolTest.state()')
        assert state['job']['processedRows'] == 25000, state['job']
        assert state['job']['validRows'] > 24900, state['job']
        assert state['job']['invalidRows'] > 0, state['job']
        assert state['mission']['status'] == 'COMPLETE_WITH_REJECTIONS', state['mission']
        report['migration'] = {
            'seconds': round(time.time() - started, 3),
            'processed': state['job']['processedRows'],
            'valid': state['job']['validRows'],
            'invalid': state['job']['invalidRows'],
            'mission': state['mission']['status']
        }

        cdp.eval("window.__spoolTest.navigate('/studio/results')")
        wait_for(lambda: cdp.eval('document.querySelectorAll(".result-metrics article").length === 4'), timeout=20, label='results UI')

        cdp.call('Page.reload', {'ignoreCache': True})
        wait_for(lambda: cdp.eval('Boolean(window.__spoolTest)'), timeout=30, label='reload bootstrap')
        wait_for(lambda: cdp.eval("window.__spoolTest.state().job.phase === 'COMPLETE'"), timeout=20, label='IndexedDB restoration')
        restored = cdp.eval('window.__spoolTest.state()')
        assert restored['output'] and len(restored['output']) > 24900
        assert restored['mission']['status'] == 'COMPLETE_WITH_REJECTIONS'

        exceptions = [e for e in cdp.events if e.get('method') == 'Runtime.exceptionThrown']
        failed = [e for e in cdp.events if e.get('method') == 'Network.loadingFailed' and not e.get('params', {}).get('canceled')]
        severe = [e for e in cdp.events if e.get('method') == 'Log.entryAdded' and e.get('params', {}).get('entry', {}).get('level') in ('error', 'warning')]
        report['diagnostics'] = {'runtimeExceptions': len(exceptions), 'failedNetworkLoads': len(failed), 'warningOrErrorLogs': len(severe)}
        if exceptions or failed or severe:
            report['diagnostics']['samples'] = {'exceptions': exceptions[:2], 'failed': failed[:2], 'logs': severe[:2]}
            raise AssertionError(report['diagnostics'])

        report['status'] = 'PASS'
        print(json.dumps(report, indent=2), flush=True)
    finally:
        if cdp:
            cdp.close()
        if chrome:
            chrome.terminate()
            try:
                chrome.wait(timeout=5)
            except subprocess.TimeoutExpired:
                chrome.kill()
        if log_handle:
            log_handle.close()
        if profile:
            shutil.rmtree(profile, ignore_errors=True)


if __name__ == '__main__':
    main()
