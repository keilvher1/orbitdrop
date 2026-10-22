"""Download a public ghcr.io OCI image (manifest + blobs) with parallel HTTP/1.1 connections.

Partial blobs are resumed with HTTP Range requests (the CDN cuts long transfers), and
every blob is verified against its sha256 digest before it is kept; finished blobs are
skipped on a re-run. Usage: oci_fetch.py <out-dir> [repo] [tag] [workers]
"""
import concurrent.futures
import hashlib
import http.client
import json
import os
import sys
import threading
import time
import urllib.parse
import urllib.request

OUT = sys.argv[1]
REPO = sys.argv[2] if len(sys.argv) > 2 else 'cirruslabs/macos-sonoma-vanilla'
TAG = sys.argv[3] if len(sys.argv) > 3 else 'latest'
WORKERS = int(sys.argv[4]) if len(sys.argv) > 4 else 5
MANIFEST_TYPE = 'application/vnd.oci.image.manifest.v1+json'

lock = threading.Lock()


def log(msg):
    with lock:
        print(time.strftime('%H:%M:%S'), msg, flush=True)


def token():
    with urllib.request.urlopen('https://ghcr.io/token?scope=repository:%s:pull' % REPO, timeout=30) as r:
        return json.load(r)['token']


def request(url, headers):
    """GET without following redirects (the CDN must not receive the registry token)."""
    u = urllib.parse.urlsplit(url)
    conn = http.client.HTTPSConnection(u.hostname, timeout=60)
    path = u.path + ('?' + u.query if u.query else '')
    conn.request('GET', path, headers=headers)
    return conn, conn.getresponse()


def open_blob(digest, offset):
    headers = {'Authorization': 'Bearer ' + token()}
    if offset:
        headers['Range'] = 'bytes=%d-' % offset
    conn, resp = request('https://ghcr.io/v2/%s/blobs/%s' % (REPO, digest), headers)
    hops = 0
    while resp.status in (301, 302, 303, 307, 308) and hops < 5:
        location = resp.getheader('Location')
        resp.read()
        conn.close()
        conn, resp = request(location, {'Range': 'bytes=%d-' % offset} if offset else {})
        hops += 1
    if resp.status not in (200, 206):
        body = resp.read()[:200]
        conn.close()
        raise IOError('HTTP %d for %s: %r' % (resp.status, digest, body))
    return conn, resp


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return 'sha256:' + h.hexdigest()


def blob_path(digest):
    return os.path.join(OUT, 'blobs', digest.replace(':', '_'))


def fetch(desc):
    digest, size = desc['digest'], desc['size']
    path = blob_path(digest)
    tmp = path + '.part'
    if os.path.exists(path) and os.path.getsize(path) == size:
        return 'cached'
    for attempt in range(60):
        try:
            have = os.path.getsize(tmp) if os.path.exists(tmp) else 0
            if have > size:
                os.remove(tmp)
                have = 0
            if have < size:
                conn, resp = open_blob(digest, have)
                if have and resp.status == 200:  # the server ignored the range: start over
                    have = 0
                with open(tmp, 'ab' if have else 'wb') as f:
                    while True:
                        chunk = resp.read(1 << 18)
                        if not chunk:
                            break
                        f.write(chunk)
                conn.close()
            got = os.path.getsize(tmp)
            if got < size:
                raise IOError('short transfer, %d of %d bytes so far' % (got, size))
            if got != size or sha256_file(tmp) != digest:
                os.remove(tmp)
                raise IOError('digest mismatch, starting over')
            os.replace(tmp, path)
            return 'ok'
        except Exception as e:
            log('retry %d %s: %s' % (attempt + 1, digest[7:19], e))
            time.sleep(min(30, 2 ** min(attempt, 5)))
    raise IOError('giving up on ' + digest)


def main():
    os.makedirs(os.path.join(OUT, 'blobs'), exist_ok=True)
    conn, resp = request('https://ghcr.io/v2/%s/manifests/%s' % (REPO, TAG), {'Authorization': 'Bearer ' + token(), 'Accept': MANIFEST_TYPE})
    manifest = resp.read()
    conn.close()
    if resp.status != 200:
        raise SystemExit('manifest HTTP %d' % resp.status)
    manifest_file = os.path.join(OUT, 'manifest.json')
    if os.path.exists(manifest_file) and open(manifest_file, 'rb').read() != manifest:
        raise SystemExit('the remote manifest changed since the first run; use a new output folder')
    with open(manifest_file, 'wb') as f:
        f.write(manifest)
    m = json.loads(manifest)
    blobs = [m['config']] + m['layers']
    total = sum(b['size'] for b in blobs)
    log('manifest %s: %d blobs, %.2f GB' % ('sha256:' + hashlib.sha256(manifest).hexdigest(), len(blobs), total / 1e9))

    def on_disk():
        n = 0
        for b in blobs:
            for p in (blob_path(b['digest']), blob_path(b['digest']) + '.part'):
                if os.path.exists(p):
                    n += os.path.getsize(p)
        return n

    def progress():
        last, last_t = on_disk(), time.time()
        while True:
            time.sleep(60)
            now, now_t = on_disk(), time.time()
            log('progress %.2f / %.2f GB (%.1f%%), %.2f MB/s' % (now / 1e9, total / 1e9, 100 * now / total, (now - last) / (now_t - last_t) / 1e6))
            last, last_t = now, now_t

    threading.Thread(target=progress, daemon=True).start()
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        list(pool.map(fetch, blobs))
    missing = [b['digest'] for b in blobs if not (os.path.exists(blob_path(b['digest'])) and os.path.getsize(blob_path(b['digest'])) == b['size'])]
    if missing:
        raise SystemExit('missing %d blobs' % len(missing))
    log('all %d blobs present and verified' % len(blobs))


if __name__ == '__main__':
    main()
