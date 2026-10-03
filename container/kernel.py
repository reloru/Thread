"""Persistent Python kernel: reads one JSON request per line on stdin, writes one JSON result per line."""
import ast
import base64
import contextlib
import io
import json
import sys
import traceback

MAX_OUTPUT = 20000
MAX_IMAGES = 4

namespace = {"__name__": "__main__"}
protocol_out = sys.stdout


def cap(text):
    if len(text) <= MAX_OUTPUT:
        return text
    return text[:MAX_OUTPUT] + f"\n… [truncated {len(text) - MAX_OUTPUT} characters]"


def run(code):
    stdout, stderr = io.StringIO(), io.StringIO()
    error = None
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            tree = ast.parse(code, "<cell>", "exec")
            last = None
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                last = ast.Expression(tree.body.pop().value)
            exec(compile(tree, "<cell>", "exec"), namespace)
            if last is not None:
                value = eval(compile(last, "<cell>", "eval"), namespace)
                if value is not None:
                    print(repr(value))
        except BaseException as exc:
            error = format_error(exc)
    return {
        "stdout": cap(stdout.getvalue()),
        "stderr": cap(stderr.getvalue()),
        "error": cap(error) if error else None,
        "images": figures(),
    }


def format_error(exc):
    # Drop this module's own frames so the traceback shows only the user's cell.
    frames = [f for f in traceback.extract_tb(exc.__traceback__) if f.filename != __file__][-8:]
    lines = ["Traceback (most recent call last):\n"] if frames else []
    lines += traceback.format_list(frames)
    lines += traceback.format_exception_only(type(exc), exc)
    return "".join(lines)


def figures():
    if "matplotlib.pyplot" not in sys.modules:
        return []
    plt = sys.modules["matplotlib.pyplot"]
    images = []
    for num in plt.get_fignums()[:MAX_IMAGES]:
        buf = io.BytesIO()
        plt.figure(num).savefig(buf, format="png", dpi=110, bbox_inches="tight")
        images.append(base64.b64encode(buf.getvalue()).decode())
    plt.close("all")
    return images


for line in sys.stdin:
    request = json.loads(line)
    result = run(request.get("code", ""))
    protocol_out.write(json.dumps(result) + "\n")
    protocol_out.flush()
