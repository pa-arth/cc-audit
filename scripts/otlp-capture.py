#!/usr/bin/env python3
"""Throwaway OTLP/HTTP-JSON receiver for the otel-native-capture §1 fidelity gate.

Accepts POST /v1/logs, /v1/metrics, /v1/traces and appends each decoded request
body to a JSONL file, one line per batch, tagged with the signal + arrival order.
Stdlib only. Handles gzip and identity encodings.

Deliberately dumb: it stores the RAW wire body untouched so the corpus is
"captured, not authored" (spec requirement). All interpretation happens later in
the comparison script, against the file on disk.
"""
import gzip
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OUT = sys.argv[1] if len(sys.argv) > 1 else 'wire.jsonl'
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 4318

_lock = threading.Lock()
_n = [0]


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):  # silence per-request stderr noise
        pass

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(n) if n else b''
        if (self.headers.get('Content-Encoding') or '').lower() == 'gzip':
            try:
                raw = gzip.decompress(raw)
            except Exception:
                pass
        rec = {'signal': self.path, 'ct': self.headers.get('Content-Type')}
        try:
            rec['body'] = json.loads(raw.decode('utf-8'))
        except Exception as e:
            # Protobuf or malformed — keep evidence rather than silently dropping,
            # so "the receiver saw nothing" can never be confused with "the client
            # sent nothing" (the spec's absent-vs-empty rule).
            rec['undecodable'] = str(e)
            rec['bytes'] = len(raw)
            rec['head'] = raw[:200].hex()
        with _lock:
            _n[0] += 1
            rec['seq'] = _n[0]
            with open(OUT, 'a') as f:
                f.write(json.dumps(rec) + '\n')
        # OTLP/HTTP expects a JSON body; an empty 200 is accepted by the SDK too.
        body = b'{}'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        body = json.dumps({'batches': _n[0]}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    print(f'otlp receiver on :{PORT} -> {OUT}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
