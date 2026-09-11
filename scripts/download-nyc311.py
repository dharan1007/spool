#!/usr/bin/env python3
import argparse
import csv
import os
import tempfile
import urllib.parse
import urllib.request

ENDPOINT = 'https://data.cityofnewyork.us/resource/erm2-nwe9.csv'
PAGE_SIZE = 40000


def fetch_page(limit, offset, path):
    query = urllib.parse.urlencode({
        '$limit': str(limit),
        '$offset': str(offset),
        '$order': 'unique_key DESC'
    })
    request = urllib.request.Request(
        f'{ENDPOINT}?{query}',
        headers={'User-Agent': 'SPOOL-production-audit/1.1.0', 'Accept': 'text/csv'}
    )
    with urllib.request.urlopen(request, timeout=120) as response, open(path, 'wb') as out:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--rows', type=int)
    parser.add_argument('--min-bytes', type=int, default=0)
    parser.add_argument('--max-rows', type=int, default=200000)
    args = parser.parse_args()
    if not args.rows and not args.min_bytes:
        raise SystemExit('Specify --rows or --min-bytes')

    wanted_rows = args.rows or args.max_rows
    total = 0
    header = None
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, 'w', encoding='utf-8', newline='') as dst:
        writer = csv.writer(dst, lineterminator='\n')
        while total < wanted_rows and total < args.max_rows:
            limit = min(PAGE_SIZE, wanted_rows - total, args.max_rows - total)
            if limit <= 0:
                break
            fd, page_path = tempfile.mkstemp(prefix='nyc311-', suffix='.csv')
            os.close(fd)
            try:
                fetch_page(limit, total, page_path)
                page_rows = 0
                with open(page_path, 'r', encoding='utf-8-sig', newline='') as src:
                    reader = csv.reader(src)
                    page_header = next(reader, None)
                    if not page_header:
                        break
                    if header is None:
                        header = page_header
                        writer.writerow(header)
                    elif page_header != header:
                        raise RuntimeError('NYC 311 schema changed between paginated responses')
                    for row in reader:
                        if len(row) != len(header):
                            raise RuntimeError(f'Row width {len(row)} differs from header width {len(header)}')
                        writer.writerow(row)
                        page_rows += 1
                        total += 1
                        if total >= wanted_rows or total >= args.max_rows:
                            break
                if page_rows == 0:
                    break
            finally:
                try:
                    os.unlink(page_path)
                except OSError:
                    pass

            dst.flush()
            size = os.path.getsize(args.output)
            print(f'rows={total} bytes={size}', flush=True)
            if args.min_bytes and size >= args.min_bytes and (args.rows is None or total >= args.rows):
                break
            if args.rows is None and total >= wanted_rows and size < args.min_bytes:
                wanted_rows = min(args.max_rows, wanted_rows + PAGE_SIZE)

    size = os.path.getsize(args.output)
    if args.rows is not None and total != args.rows:
        raise SystemExit(f'Expected exactly {args.rows} rows, got {total}')
    if args.min_bytes and size < args.min_bytes:
        raise SystemExit(f'Could not reach {args.min_bytes} bytes before {total} rows; got {size}')
    print(f'complete rows={total} fields={len(header or [])} bytes={size}', flush=True)


if __name__ == '__main__':
    main()
