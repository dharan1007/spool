#!/usr/bin/env python3
"""Read-only measurements for a marked, disposable qualification process tree."""
import json
import os
import sys
import time
from pathlib import Path
import psutil

pid, roots_file, output = int(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
stop = output.with_suffix('.stop')
records, cpu_by_pid, errors = [], {}, []
peak_rss = peak_disk = peak_wal = 0


def summary():
    return json.dumps({'samples': len(records), 'peakTreeWorkingSetBytes': peak_rss,
        'peakFixtureLogicalDiskBytes': peak_disk, 'peakWalBytes': peak_wal,
        'observedTreeCpuSeconds': sum(cpu_by_pid.values()), 'errors': errors})


# Always leave a readable summary: a parent that fails before the first sample
# must report its own failure instead of an unreadable evidence file.
output.write_text(summary(), encoding='utf-8')
while not stop.exists() and psutil.pid_exists(pid):
    rss = disk = wal = 0
    try:
        parent = psutil.Process(pid)
        for proc in [parent] + parent.children(recursive=True):
            if proc.pid == os.getpid():
                continue
            try:
                rss += proc.memory_info().rss
                cpu = proc.cpu_times()
                cpu_by_pid[(proc.pid, proc.create_time())] = cpu.user + cpu.system
            except psutil.NoSuchProcess:
                pass
        roots = json.loads(roots_file.read_text(encoding='utf-8'))
        for root in roots:
            root = Path(root)
            marker = json.loads((root / '.spool-qualification.json').read_text(encoding='utf-8'))
            if Path(marker['root']).resolve() != root.resolve() or marker['purpose'] != 'spool-disposable-qualification-v1':
                raise RuntimeError('Unmarked measurement root')
            for path in root.rglob('*'):
                try:
                    if path.is_file() and not path.is_symlink():
                        size = path.stat().st_size
                        disk += size
                        if path.name.endswith('-wal'):
                            wal += size
                except FileNotFoundError:
                    pass
        peak_rss, peak_disk, peak_wal = max(peak_rss, rss), max(peak_disk, disk), max(peak_wal, wal)
        records.append({'monotonicSeconds': time.monotonic(), 'treeWorkingSetBytes': rss,
                        'fixtureLogicalDiskBytes': disk, 'walBytes': wal,
                        'observedTreeCpuSeconds': sum(cpu_by_pid.values())})
    except Exception as error:
        errors.append(repr(error))
    output.write_text(summary(), encoding='utf-8')
    time.sleep(.25)
output.write_text(summary(), encoding='utf-8')
output.with_suffix('.samples.json').write_text(json.dumps(records), encoding='utf-8')
