#!/usr/bin/env python3
import csv
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE_URL = 'https://spool-webmcp.vercel.app'
DATASET_API = 'https://data.cityofnewyork.us/resource/erm2-nwe9.csv'
EXPECTED_SHA = 'feb1cfaab15c44522c594d008a8b0190f400ff52'

spec = importlib.util.spec_from_file_location('spool_browser_smoke', os.path.join(ROOT, 'scripts', 'browser-smoke.py'))
smoke = importlib.util.module_from_spec(spec); spec.loader.exec_module(smoke)


def download(path):
    subprocess.run(['curl','-fL','--retry','4','--retry-delay','2','--compressed','-G',DATASET_API,'--data-urlencode','$limit=43000','--data-urlencode','$order=unique_key DESC','-H','User-Agent: SPOOL-production-audit/1.0','-o',path], check=True)


def count_rows(path):
    with open(path, 'r', encoding='utf-8-sig', newline='') as f:
        r=csv.reader(f); header=next(r); return sum(1 for _ in r), len(header)


def upload_file(cdp, path):
    doc=cdp.call('DOM.getDocument', {'depth':-1,'pierce':True})
    node=cdp.call('DOM.querySelector', {'nodeId':doc['root']['nodeId'],'selector':'#source-file'}).get('nodeId')
    if not node: raise AssertionError('missing source input')
    cdp.call('DOM.setFileInputFiles', {'nodeId':node,'files':[path]})


def browser_preserve(path, expected_rows):
    profile=tempfile.mkdtemp(prefix='spool-diagnostic-chrome-')
    log=open(os.path.join(profile,'chrome.log'),'w+',encoding='utf8')
    browser=smoke.resolve_browser()
    chrome=subprocess.Popen([browser,'--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-background-networking','--remote-allow-origins=*',f'--remote-debugging-port={smoke.CDP_PORT}',f'--user-data-dir={profile}',BASE_URL+'/studio/new'],stdout=log,stderr=log)
    cdp=None
    try:
        smoke.wait_for(lambda: smoke.get_json(f'http://127.0.0.1:{smoke.CDP_PORT}/json'),timeout=15,label='CDP')
        page=next(p for p in smoke.get_json(f'http://127.0.0.1:{smoke.CDP_PORT}/json') if p.get('type')=='page')
        cdp=smoke.CDP(page['webSocketDebuggerUrl']); cdp.call('Runtime.enable'); cdp.call('Page.enable'); cdp.call('DOM.enable')
        smoke.wait_for(lambda: cdp.eval('Boolean(window.__spoolTest)'),timeout=20,label='SPOOL')
        t=time.time(); upload_file(cdp,path)
        smoke.wait_for(lambda: cdp.eval("window.__spoolTest.state().job.phase === 'SOURCE_READY'"),timeout=180,interval=.25,label='source ready')
        parse_seconds=time.time()-t
        assert cdp.eval('window.__spoolTest.state().source.rows.length') == expected_rows
        t=time.time(); result=cdp.eval("window.__spoolTest.runAutopilot('preserve_contract')")
        assert result['ok'] is True, result
        smoke.wait_for(lambda: cdp.eval("window.__spoolTest.state().job.phase === 'COMPLETE'"),timeout=300,interval=.5,label='preserve completion')
        run_seconds=time.time()-t
        audit=cdp.eval("""(async()=>{const s=window.__spoolTest.state(); const {validateOutputRow}=await import('/src/core/schema.js'); const {parseCsv}=await import('/src/core/csv.js'); let bad=0; for(const row of s.output){try{validateOutputRow(row,s.targetSchema)}catch{bad++}} const ex=await window.__spoolTest.invoke('export_csv',{}); let parsed=null,err=null; if(ex.ok){try{parsed=parseCsv(ex.result.content)}catch(e){err={code:e?.code,message:e?.message}}} return {phase:s.job.phase,mission:s.mission?.status,processed:s.job.processedRows,valid:s.job.validRows,invalid:s.job.invalidRows,output:s.output.length,badOutputRows:bad,exportOk:ex.ok,exportRows:parsed?.rows?.length??null,exportFields:parsed?.headers?.length??null,exportError:err}})()""")
        audit['parseSeconds']=round(parse_seconds,3); audit['runSeconds']=round(run_seconds,3)
        return audit
    finally:
        if cdp:
            try: cdp.close()
            except: pass
        chrome.terminate()
        try: chrome.wait(timeout=5)
        except: chrome.kill()
        log.close(); shutil.rmtree(profile,ignore_errors=True)


def main():
    work=tempfile.mkdtemp(prefix='spool-nyc-diag-'); path=os.path.join(work,'nyc311-43000.csv')
    report={}
    try:
        download(path); rows,fields=count_rows(path)
        report['source']={'bytes':os.path.getsize(path),'rows':rows,'fields':fields}
        report['browserPreserve']=browser_preserve(path,rows)
        proc=subprocess.run(['node','scripts/audit-local-runner-nyc311.mjs',path,'run'],cwd=ROOT,text=True,capture_output=True,env={**os.environ,'SPOOL_EXPECTED_SHA':EXPECTED_SHA},timeout=600)
        report['localRunnerProcess']={'exitCode':proc.returncode,'stderr':proc.stderr[-2000:]}
        try: report['localRunner']=json.loads(proc.stdout.strip().splitlines()[-1])
        except Exception: report['localRunner']={'raw':proc.stdout[-4000:]}
        if proc.returncode != 0: raise AssertionError(f'local runner diagnostic process failed: {proc.stderr}')
        b=report['browserPreserve']
        if not (b['phase']=='COMPLETE' and b['mission']=='COMPLETE' and b['processed']==rows and b['valid']==rows and b['invalid']==0 and b['output']==rows and b['badOutputRows']==0 and b['exportOk'] and b['exportRows']==rows and not b['exportError']):
            raise AssertionError(f'browser preserve diagnostics failed: {b}')
        l=report['localRunner']
        if not (l.get('inspect',{}).get('ok') and l.get('dryRun',{}).get('validRows')==rows and l.get('run',{}).get('status')=='COMPLETE' and l.get('run',{}).get('verification')=='VERIFIED' and l.get('run',{}).get('targetRows')==rows):
            raise AssertionError(f'local runner diagnostics failed: {l}')
        report['status']='PASS'
    except Exception as e:
        report['status']='FAIL'; report['failure']={'type':type(e).__name__,'message':str(e)}
        raise
    finally:
        with open('/tmp/spool-nyc311-diagnostics.json','w',encoding='utf8') as f: json.dump(report,f,indent=2)
        print(json.dumps(report,indent=2),flush=True); shutil.rmtree(work,ignore_errors=True)

if __name__=='__main__': main()
