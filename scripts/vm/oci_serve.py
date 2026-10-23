"""Serve a downloaded OCI image (see oci_fetch.py) as a minimal read-only registry on 127.0.0.1.

Usage: oci_serve.py <dir> [repo] [port] [--delete-after-serve]
Then: tart clone --insecure 127.0.0.1:<port>/<repo>:latest <name>

--delete-after-serve removes each disk layer once it has been sent completely as many times
as the manifest references it (identical chunks — all-zero ones — share one blob that tart
requests once per layer), so the compressed copy and tart's decompressed disk never both
take space (for a nearly full disk; if the clone fails, the image has to be downloaded again).
"""
import collections
import hashlib
import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ARGS = [a for a in sys.argv[1:] if not a.startswith('--')]
DELETE_AFTER_SERVE = '--delete-after-serve' in sys.argv
DIR = ARGS[0]
REPO = ARGS[1] if len(ARGS) > 1 else 'cirruslabs/macos-sonoma-vanilla'
PORT = int(ARGS[2]) if len(ARGS) > 2 else 5005
MANIFEST = open(os.path.join(DIR, 'manifest.json'), 'rb').read()
MANIFEST_DIGEST = 'sha256:' + hashlib.sha256(MANIFEST).hexdigest()
MANIFEST_TYPE = 'application/vnd.oci.image.manifest.v1+json'
# How many more complete transfers of each blob the manifest calls for (for --delete-after-serve).
REMAINING = collections.Counter(l['digest'] for l in json.loads(MANIFEST)['layers'])
REMAINING_LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (self.command, fmt % args))

    def send_bytes(self, status, body, ctype, extra=None):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def handle_request(self):
        path = self.path.split('?')[0]
        if path in ('/v2', '/v2/'):
            return self.send_bytes(200, b'{}', 'application/json')
        m = re.fullmatch(r'/v2/(.+)/manifests/([^/]+)', path)
        if m and m.group(1) == REPO:
            return self.send_bytes(200, MANIFEST, MANIFEST_TYPE, {'Docker-Content-Digest': MANIFEST_DIGEST})
        m = re.fullmatch(r'/v2/(.+)/blobs/(sha256:[0-9a-f]{64})', path)
        if m and m.group(1) == REPO:
            file = os.path.join(DIR, 'blobs', m.group(2).replace(':', '_'))
            if not os.path.exists(file):
                return self.send_bytes(404, b'{}', 'application/json')
            size = os.path.getsize(file)
            first, last, status = 0, size - 1, 200
            rng = self.headers.get('Range')
            if rng:
                r = re.fullmatch(r'bytes=(\d+)-(\d*)', rng.strip())
                if r:
                    first = int(r.group(1))
                    last = int(r.group(2)) if r.group(2) else size - 1
                    status = 206
            self.send_response(status)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(last - first + 1))
            self.send_header('Docker-Content-Digest', m.group(2))
            self.send_header('Accept-Ranges', 'bytes')
            if status == 206:
                self.send_header('Content-Range', 'bytes %d-%d/%d' % (first, last, size))
            self.end_headers()
            if self.command == 'HEAD':
                return
            with open(file, 'rb') as f:
                f.seek(first)
                left = last - first + 1
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            if DELETE_AFTER_SERVE and left == 0 and first == 0 and last == size - 1 and size > (1 << 20):
                self.wfile.flush()
                with REMAINING_LOCK:
                    REMAINING[m.group(2)] -= 1
                    last_reference = REMAINING[m.group(2)] <= 0
                if last_reference:
                    os.remove(file)
                    sys.stderr.write('served and removed %s\n' % m.group(2)[:19])
            return
        return self.send_bytes(404, b'{}', 'application/json')

    do_GET = handle_request
    do_HEAD = handle_request


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
