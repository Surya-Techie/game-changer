"""In-process background training jobs for the pattern ML models.

Why not Celery / RQ?
--------------------
This service runs a single uvicorn worker for the trading desk; a single
in-process thread + a JSON-file checkpoint is the simplest thing that
correctly survives the use case (one admin clicks "Retrain" once a week).
For multi-worker deployments we'd swap this for a real queue.

Job lifecycle
-------------
  queued → running → completed | failed | cancelled

State is held in memory (the canonical source-of-truth for the duration
of the process) and mirrored to a JSON sidecar so /patterns/train/{id}
survives a fast uvicorn reload during development.

Progress fan-out
----------------
Each progress tick is also POSTed to `BACKEND_PROGRESS_WEBHOOK` if
configured (e.g. `http://backend:4000/internal/patterns/train-progress`).
Phase 5 will wire the Node backend to forward those payloads to the WS
as `pattern_training_progress` for the admin panel UI.
"""

from __future__ import annotations

import json
import os
import threading
import traceback
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .train_models import NSE_TOP_50, TrainResult, train_timeframe


JOB_STATE_PATH = Path(os.environ.get("PATTERN_JOB_STATE", "/tmp/qti_pattern_jobs.json"))
PROGRESS_WEBHOOK = os.environ.get("BACKEND_PROGRESS_WEBHOOK", "").strip()


@dataclass
class TrainingJob:
    job_id: str
    timeframe: str
    symbols: List[str]
    fast: bool
    status: str = "queued"  # queued | running | completed | failed | cancelled
    percent: int = 0
    message: str = ""
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    error: Optional[str] = None
    result: Optional[dict] = None

    def to_dict(self) -> dict:
        return asdict(self)


_JOBS: Dict[str, TrainingJob] = {}
_JOBS_LOCK = threading.Lock()


def _persist() -> None:
    """Best-effort snapshot of all jobs to disk — fine if it fails."""
    try:
        JOB_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with _JOBS_LOCK:
            payload = {jid: j.to_dict() for jid, j in _JOBS.items()}
        JOB_STATE_PATH.write_text(json.dumps(payload, indent=2, default=str))
    except Exception:  # noqa: BLE001 — not critical.
        pass


def _restore() -> None:
    if not JOB_STATE_PATH.exists():
        return
    try:
        data = json.loads(JOB_STATE_PATH.read_text())
        with _JOBS_LOCK:
            for jid, payload in data.items():
                if jid in _JOBS:
                    continue
                _JOBS[jid] = TrainingJob(**payload)
    except Exception:  # noqa: BLE001
        pass


_restore()


def _push_progress(job: TrainingJob) -> None:
    """Mirror state to the JSON sidecar + (optionally) POST to backend."""
    _persist()
    if not PROGRESS_WEBHOOK:
        return
    try:
        import httpx  # type: ignore
        with httpx.Client(timeout=2.0) as client:
            client.post(PROGRESS_WEBHOOK, json=job.to_dict())
    except Exception:  # noqa: BLE001 — webhook is best-effort.
        pass


def _set(job: TrainingJob, **kwargs: Any) -> None:
    """Merge fields onto a job and broadcast the new state. Held under the
    jobs lock so observers always see a coherent snapshot."""
    with _JOBS_LOCK:
        for k, v in kwargs.items():
            setattr(job, k, v)
    _push_progress(job)


# ─── Worker ────────────────────────────────────────────────────────────────

def _runner(job: TrainingJob) -> None:
    """Thread body. Wraps train_timeframe with progress + error handling."""
    _set(job, status="running", percent=0, message="starting", started_at=datetime.now(timezone.utc).isoformat())
    try:
        def progress(msg: str) -> None:
            # The trainer doesn't have a real percent — assign coarse milestones
            # based on the message keywords. Good enough for a UI bar.
            txt = msg.lower()
            if "fetching" in txt:
                _set(job, percent=10, message=msg)
            elif "fetched" in txt:
                _set(job, percent=30, message=msg)
            elif "built" in txt:
                _set(job, percent=55, message=msg)
            elif "fitting" in txt:
                _set(job, percent=75, message=msg)
            else:
                _set(job, message=msg)

        result: TrainResult = train_timeframe(
            timeframe=job.timeframe,
            symbols=job.symbols or NSE_TOP_50,
            aug_factor=1,
            fast=job.fast,
            progress=progress,
        )
        _set(
            job,
            status="completed",
            percent=100,
            message="done",
            finished_at=datetime.now(timezone.utc).isoformat(),
            result={
                "timeframe": result.timeframe,
                "n_samples": result.n_samples,
                "n_train": result.n_train,
                "n_val": result.n_val,
                "n_test": result.n_test,
                "train_metrics": result.train_metrics,
                "val_metrics": result.val_metrics,
                "test_metrics": result.test_metrics,
                "saved_paths": result.saved_paths,
            },
        )
    except Exception as e:  # noqa: BLE001
        _set(
            job,
            status="failed",
            error=f"{type(e).__name__}: {e}",
            message="training failed (see error)",
            finished_at=datetime.now(timezone.utc).isoformat(),
        )
        # Stash a short traceback for debugging — not exposed to the API.
        try:
            (JOB_STATE_PATH.parent / f"qti_pattern_{job.job_id}.traceback.txt").write_text(traceback.format_exc())
        except Exception:  # noqa: BLE001
            pass


# ─── Public API ────────────────────────────────────────────────────────────

def submit(timeframe: str, symbols: Optional[List[str]] = None, fast: bool = False) -> TrainingJob:
    """Start training a timeframe in a background thread. Returns the job
    immediately so the caller can return job_id to the client."""
    job_id = uuid.uuid4().hex[:12]
    job = TrainingJob(
        job_id=job_id,
        timeframe=timeframe,
        symbols=list(symbols) if symbols else [],
        fast=fast,
    )
    with _JOBS_LOCK:
        _JOBS[job_id] = job
    _persist()
    threading.Thread(target=_runner, args=(job,), name=f"pattern-train-{job_id}", daemon=True).start()
    return job


def get(job_id: str) -> Optional[TrainingJob]:
    with _JOBS_LOCK:
        return _JOBS.get(job_id)


def list_jobs(limit: int = 25) -> List[TrainingJob]:
    with _JOBS_LOCK:
        jobs = sorted(_JOBS.values(), key=lambda j: j.started_at or "", reverse=True)
    return jobs[:limit]


def estimate_seconds(timeframe: str, n_symbols: int, fast: bool) -> int:
    """Rough wall-clock estimate so the API can include an ETA hint."""
    per_symbol_fetch = 1.0  # yfinance with polite pause
    base_fit = 30 if fast else 180  # seconds
    return int(per_symbol_fetch * n_symbols + base_fit)
