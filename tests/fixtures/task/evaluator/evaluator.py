"""Fixture evaluator, shaped like a benchmark one: evaluate(program_path) -> metrics.

Runs the program and scores the integer it prints. A program that fails or
prints no integer scores zero.
"""

import subprocess
import sys


def evaluate(program_path):
    completed = subprocess.run([sys.executable, program_path], capture_output=True, text=True, timeout=60)
    text = completed.stdout.strip()
    if completed.returncode != 0 or not text.lstrip("-").isdigit():
        return {"combined_score": 0.0, "error": completed.stderr[-500:]}
    return {"combined_score": float(text)}
