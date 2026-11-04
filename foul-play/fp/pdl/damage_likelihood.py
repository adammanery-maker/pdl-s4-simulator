"""Local, explicit bridge to the simulator's Showdown damage enumerator.

Callers pass a public observation plus one belief hypothesis as JSON. This
module does not accept a Battle object, team file, or any authoritative hidden
state, which keeps the inference boundary hard even though both projects share
a local machine.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
from typing import Any


class DamageLikelihoodError(RuntimeError):
    """The local inference calculator could not produce an auditable result."""


def _default_simulator_root() -> Path:
    configured = os.environ.get("PDL_SIMULATOR_ROOT")
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parents[3] / "pdl-s4-simulator"


def calculate_local_showdown_likelihood(
    hypothesis_payload: dict[str, Any], *, simulator_root: str | Path | None = None
) -> dict[str, Any]:
    """Return an exact local-Showdown likelihood for an explicit hypothesis.

    The payload is forwarded unchanged. In particular, this function must not
    enrich it from the live battle object or a submitted opponent team.
    """

    root = Path(simulator_root) if simulator_root is not None else _default_simulator_root()
    command = ["node", str(root / "dist/pdl/inference/showdown-damage-likelihood-cli.js")]
    completed = subprocess.run(
        command,
        input=json.dumps(hypothesis_payload),
        text=True,
        capture_output=True,
        check=False,
        cwd=root,
    )
    if completed.returncode != 0:
        raise DamageLikelihoodError(
            "Local Showdown damage likelihood process failed: " + completed.stderr.strip()
        )
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise DamageLikelihoodError("Local Showdown damage likelihood returned invalid JSON") from error
    if not isinstance(result, dict) or "outcomeKind" not in result:
        raise DamageLikelihoodError("Local Showdown damage likelihood returned an invalid result")
    return result
