#!/usr/bin/env python3
import base64, json, os, shutil, subprocess, sys, tempfile, time, urllib.parse, urllib.request
import websocket

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTTP_PORT = 8876
CDP_PORT = 9336


def get_json(url, method='GET'):
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=3) as response:
        return json.load(response)


class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=8)
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
        result = self.call('Runtime.evaluate', {'expression': expression, 'returnByValue': True, 'awaitPromise': True})
        if 'exceptionDetails' in result:
            raise RuntimeError(result['exceptionDetails'])
        return result.get('result', {}).get('value')

    def close(self):
        self.ws.close()


def wait_for(fn, timeout=20, interval=.1, label='condition'):
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


def main():
    remote = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('SPOOL_URL')
    server = None
    if remote:
        target = remote.rstrip('/') + '/studio/new'
    else:
        server = subprocess.Popen(['python3', '-m', 'http.server', str(HTTP_PORT), '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        target = f'http://127.0.0.1:{HTTP_PORT}/studio/new'

    profile = tempfile.mkdtemp(prefix='spool-chrome-')
    chrome = subprocess.Popen([
        'chromium', '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--disable-background-networking', '--remote-allow-origins=*', f'--remote-debugging-port={CDP_PORT}',
        f'--user-data-dir={profile}', target
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    cdp = None
    try:
        wait_for(lambda: get_json(f'http://127.0.0.1:{CDP_PORT}/json'), timeout=10, label='Chromium CDP')
        pages = get_json(f'http://127.0.0.1:{CDP_PORT}/json')
        page = next(p for p in pages if p.get('type') == 'page')
        cdp = CDP(page['webSocketDebuggerUrl'])
        cdp.call('Runtime.enable')
        cdp.call('Page.enable')
        cdp.call('Network.enable')
        cdp.call('Log.enable')

        wait_for(lambda: cdp.eval('document.readyState === "complete"'), timeout=20, label='page load')
        wait_for(lambda: cdp.eval('Boolean(window.__spoolTest)'), timeout=15, label='SPOOL app bootstrap')
        assert cdp.eval('window.__spoolTest.state().job.phase') in ('EMPTY', 'COMPLETE')

        # Reset a prior durable terminal workspace when smoke is rerun against the same browser profile.
        if cdp.eval('window.__spoolTest.state().job.phase === "COMPLETE"'):
            cdp.eval('window.__spoolTest.invoke("start_new_migration", {})')
            wait_for(lambda: cdp.eval('window.__spoolTest.state().job.phase === "EMPTY"'), label='workspace reset')

        cdp.eval('window.__spoolTest.loadDemo()')
        wait_for(lambda: cdp.eval('window.__spoolTest.state().job.phase === "SOURCE_READY"'), timeout=15, label='demo source load')
        assert cdp.eval('window.__spoolTest.state().source.rows.length') == 25000

        result = cdp.eval('window.__spoolTest.runAutopilot("database_ready")')
        assert result['ok'] is True
        wait_for(lambda: cdp.eval('window.__spoolTest.state().job.phase === "COMPLETE"'), timeout=35, label='25k Autopilot completion')
        state = cdp.eval('window.__spoolTest.state()')
        assert state['job']['processedRows'] == 25000
        assert state['job']['validRows'] > 24900
        assert state['job']['invalidRows'] > 0
        assert state['mission']['status'] == 'COMPLETE'
        tools = cdp.eval('window.__spoolTest.tools()')
        assert 'export_csv' in tools and 'start_migration' not in tools

        cdp.eval('window.__spoolTest.navigate("/studio/results")')
        wait_for(lambda: cdp.eval('document.querySelectorAll(".result-metrics article").length === 4'), label='results UI')
        assert cdp.eval('document.querySelectorAll(".quality-grid article").length > 0')

        cdp.call('Page.reload', {'ignoreCache': True})
        wait_for(lambda: cdp.eval('Boolean(window.__spoolTest)'), timeout=15, label='reload bootstrap')
        wait_for(lambda: cdp.eval('window.__spoolTest.state().job.phase === "COMPLETE"'), timeout=10, label='IndexedDB restoration')
        assert cdp.eval('window.__spoolTest.state().output.length > 24900')

        # Force one more CDP round-trip so queued exception/network events are collected.
        cdp.eval('document.title')
        exceptions = [e for e in cdp.events if e.get('method') == 'Runtime.exceptionThrown']
        failed = [e for e in cdp.events if e.get('method') == 'Network.loadingFailed' and not e.get('params', {}).get('canceled')]
        severe_logs = [e for e in cdp.events if e.get('method') == 'Log.entryAdded' and e.get('params', {}).get('entry', {}).get('level') in ('error', 'warning')]
        if exceptions:
            raise AssertionError(f'Runtime exceptions: {exceptions[:3]}')
        if failed:
            raise AssertionError(f'Failed network loads: {failed[:3]}')
        if severe_logs:
            raise AssertionError(f'Browser error/warning logs: {severe_logs[:3]}')

        shot = cdp.call('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
        screenshot_path = os.path.join(ROOT, 'browser-smoke.png')
        with open(screenshot_path, 'wb') as f:
            f.write(base64.b64decode(shot['data']))
        print(json.dumps({
            'status': 'PASS',
            'url': target,
            'rows': state['job']['processedRows'],
            'valid': state['job']['validRows'],
            'invalid': state['job']['invalidRows'],
            'phase': state['job']['phase'],
            'mission': state['mission']['status'],
            'tools': tools,
            'recovery': 'PASS',
            'runtimeExceptions': 0,
            'failedNetworkLoads': 0,
            'screenshot': screenshot_path
        }, indent=2))
    finally:
        if cdp:
            cdp.close()
        chrome.terminate()
        try: chrome.wait(timeout=3)
        except subprocess.TimeoutExpired: chrome.kill()
        if server:
            server.terminate()
            try: server.wait(timeout=3)
            except subprocess.TimeoutExpired: server.kill()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == '__main__':
    main()
