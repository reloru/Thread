"""Tests for container/runner.py using the host Python (no Docker needed)."""
import json
import os
import socket
import subprocess
import sys
import time
import unittest
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class RunnerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        env = {**os.environ, "PORT": str(cls.port), "RUN_TIMEOUT": "2"}
        cls.proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "container", "runner.py")], env=env)
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/health", timeout=1)
                return
            except OSError:
                time.sleep(0.1)
        raise RuntimeError("runner did not start")

    @classmethod
    def tearDownClass(cls):
        cls.proc.kill()
        cls.proc.wait()

    def run_code(self, code):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/run",
            data=json.dumps({"code": code}).encode(),
            headers={"content-type": "application/json"},
        )
        return json.load(urllib.request.urlopen(req, timeout=30))

    def test_01_state_persists_and_last_expression_prints(self):
        self.run_code("x = 20")
        self.assertEqual(self.run_code("x + 22")["stdout"], "42\n")

    def test_02_errors_show_only_user_frames(self):
        out = self.run_code("def f():\n    return 1/0\nf()")
        self.assertIn("ZeroDivisionError", out["error"])
        self.assertNotIn("kernel.py", out["error"])

    def test_03_output_is_capped(self):
        out = self.run_code("print('a' * 50000)")
        self.assertLess(len(out["stdout"]), 21000)
        self.assertIn("truncated", out["stdout"])

    def test_04_timeout_restarts_and_clears_state(self):
        self.run_code("keep = 1")
        out = self.run_code("import time\ntime.sleep(10)")
        self.assertIn("timed out", out["error"])
        self.assertTrue(out["restarted"])
        self.assertEqual(self.run_code("'keep' in dir()")["stdout"], "False\n")

    def test_05_rejects_bad_requests(self):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/run", data=b'{"code": 5}')
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(ctx.exception.code, 400)


class BindTest(unittest.TestCase):
    def test_binds_when_hostname_lookup_fails(self):
        # Cloudflare container hostnames exceed the DNS label limit, so getfqdn() raises.
        code = (
            "import socket, sys\n"
            "def boom(*a, **k): raise UnicodeError('label too long')\n"
            "socket.getfqdn = boom\n"
            f"sys.path.insert(0, {os.path.join(ROOT, 'container')!r})\n"
            "import runner\n"
            "s = runner.Server(('127.0.0.1', 0), runner.Handler)\n"
            "print(s.server_name)\n"
        )
        out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=20)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.strip(), "sandbox")


if __name__ == "__main__":
    unittest.main()
