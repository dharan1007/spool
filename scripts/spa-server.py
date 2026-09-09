#!/usr/bin/env python3
import argparse
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class SpaRequestHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        translated = self.translate_path(self.path.split('?', 1)[0].split('#', 1)[0])
        if os.path.isfile(translated) or os.path.isdir(translated):
            return super().send_head()

        original_path = self.path
        try:
            self.path = '/index.html'
            return super().send_head()
        finally:
            self.path = original_path

    def log_message(self, fmt, *args):
        return


def main():
    parser = argparse.ArgumentParser(description='Serve SPOOL static assets with Vercel-style SPA fallback.')
    parser.add_argument('--port', type=int, default=8876)
    parser.add_argument('--directory', required=True)
    args = parser.parse_args()

    directory = os.path.realpath(args.directory)
    if not os.path.isdir(directory):
        raise SystemExit(f'Not a directory: {directory}')

    os.chdir(directory)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), SpaRequestHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
