"""Run a task's evaluator on one program, the way SkyDiscover's Evaluator does.

    python run_evaluator.py <task dir> <program file>

Loads evaluate() from <task>/evaluator/evaluator.py. Then, per attempt, writes the
program without its #EVOLVE_START/#EVOLVE_END lines to a temporary file with the
same suffix and calls evaluate(path) under the task's timeout: a timeout ends the
evaluation, an exception is retried up to max_retries times (task.json). The
result is scored with SkyDiscover's get_score and printed as one JSON line,
{"fitness": ..., "metrics": {...}}; everything the evaluator prints goes to
stderr. The runner fails only when the evaluator cannot be loaded.
"""

import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

MARKERS = {b"#EVOLVE_START", b"#EVOLVE_END"}


class EvaluationTimeout(Exception):
    """evaluate() ran past the task's timeout."""


def load_evaluate(path: Path):
    """As SkyDiscover's Evaluator._load_evaluation_function."""
    if str(path.parent) not in sys.path:
        sys.path.insert(0, str(path.parent))
    name = f"_evolve_eval_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module.evaluate


def call_with_timeout(function, argument, timeout: float):
    """Call function(argument) in a daemon thread, so a late call cannot hold the process open."""
    outcome = {}

    def target():
        try:
            outcome["value"] = function(argument)
        except Exception as error:
            outcome["error"] = error

    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    thread.join(timeout)
    if thread.is_alive():
        raise EvaluationTimeout()
    if "error" in outcome:
        raise outcome["error"]
    return outcome["value"]


def evaluate(function, code: bytes, suffix: str, timeout: float, max_retries: int) -> dict:
    """As SkyDiscover's Evaluator.evaluate_program, without cascade evaluation."""
    for attempt in range(max_retries + 1):
        # Left for the caller to remove with its scratch directory.
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
            handle.write(code)
        try:
            result = call_with_timeout(function, handle.name, timeout)
            return result if isinstance(result, dict) else {"error": 0.0}
        except EvaluationTimeout:
            return {"error": 0.0, "timeout": True}
        except Exception as error:
            print(f"evaluate() failed, attempt {attempt + 1} of {max_retries + 1}: {error!r}",
                  file=sys.stderr)
            if attempt < max_retries:
                time.sleep(1.0)
    return {"error": 0.0}


def get_score(metrics: dict) -> float:
    """As SkyDiscover's get_score: combined_score, else the mean of the numeric metrics."""
    if not metrics:
        return 0.0
    if "combined_score" in metrics:
        try:
            return float(metrics["combined_score"])
        except (ValueError, TypeError):
            pass
    values = [v for v in metrics.values() if isinstance(v, (int, float)) and not isinstance(v, bool)]
    return sum(values) / len(values) if values else 0.0


def main() -> None:
    task, program = Path(sys.argv[1]), Path(sys.argv[2])
    settings = json.loads((task / "task.json").read_text(encoding="utf-8"))
    # The result line alone goes to stdout; whatever the evaluator prints goes to stderr.
    result_stream = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    function = load_evaluate(task / "evaluator" / "evaluator.py")
    code = b"\n".join(line for line in program.read_bytes().split(b"\n")
                      if line.strip() not in MARKERS)
    metrics = evaluate(function, code, program.suffix, settings["timeout"], settings["max_retries"])
    result_stream.write(json.dumps({"fitness": get_score(metrics), "metrics": metrics}, default=str) + "\n")
    result_stream.flush()


if __name__ == "__main__":
    main()
