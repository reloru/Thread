"""HTTP front end for the sandbox: GET /health, POST /run {"code": "..."}.

Code runs in a long-lived kernel process so state persists between runs. A run that
exceeds the timeout kills the kernel; the next run starts a fresh one.
"""
import json
import os
import socketserver
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8080"))
TIMEOUT = float(os.environ.get("RUN_TIMEOUT", "60"))
MAX_CODE = 100_000
KERNEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kernel.py")


class Kernel:
    def __init__(self):
        self.proc = None
        self.lock = threading.Lock()

    def start(self):
        self.proc = subprocess.Popen(
            [sys.executable, "-u", KERNEL],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd="/workspace" if os.path.isdir("/workspace") else None,
            text=True,
            bufsize=1,
        )

    def kill(self):
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        self.proc = None

    def run(self, code):
        with self.lock:
            restarted = False
            if self.proc is None or self.proc.poll() is not None:
                restarted = self.proc is not None
                self.start()
            result = {}

            def exchange():
                self.proc.stdin.write(json.dumps({"code": code}) + "\n")
                self.proc.stdin.flush()
                line = self.proc.stdout.readline()
                result["line"] = line

            worker = threading.Thread(target=exchange, daemon=True)
            worker.start()
            worker.join(TIMEOUT)
            if worker.is_alive() or not result.get("line"):
                timed_out = worker.is_alive()
                self.kill()
                message = (
                    f"Execution timed out after {TIMEOUT:g} s. The Python session was restarted and its state cleared."
                    if timed_out
                    else "The Python process exited. Its state was cleared."
                )
                return {"stdout": "", "stderr": "", "error": message, "images": [], "restarted": True}
            out = json.loads(result["line"])
            out["restarted"] = restarted
            return out


kernel = Kernel()


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"ok": True})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/run":
            self.send_json(404, {"error": "not found"})
            return
        length = int(self.headers.get("content-length") or 0)
        if length > MAX_CODE * 4:
            self.send_json(413, {"error": "request too large"})
            return
        try:
            code = json.loads(self.rfile.read(length) or b"{}").get("code")
        except ValueError:
            code = None
        if not isinstance(code, str) or len(code) > MAX_CODE:
            self.send_json(400, {"error": "code must be a string under 100k characters"})
            return
        self.send_json(200, kernel.run(code))

    def log_message(self, *args):
        pass


class Server(ThreadingHTTPServer):
    # HTTPServer.server_bind resolves the hostname with getfqdn(); Cloudflare container
    # hostnames exceed the 63-character DNS label limit and make that raise.
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name = "sandbox"
        self.server_port = self.server_address[1]


if __name__ == "__main__":
    Server(("0.0.0.0", PORT), Handler).serve_forever()
