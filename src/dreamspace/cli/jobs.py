"""Run the pipeline from the viewer, one job at a time.

The generators are already console scripts, so the viewer does not reimplement
any of them - it saves the uploaded image into inputs/ and runs the same command
you would have typed, capturing its output as it goes.

Serially, and deliberately. A 4 GB card fits one TripoSR at a time; two
concurrent generations do not fail politely, they OOM in the middle of whichever
was further along. Queueing costs nothing here because the bottleneck is a
single GPU either way.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from queue import Queue

# Uploads land here, so both the name and the extension have to be tame.
SAFE_CHARS = re.compile(r"[^A-Za-z0-9._-]+")
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
MAX_UPLOAD = 40 * 1024 * 1024

# `console.rule("2/4  reconstruct")` and friends, which is the only progress
# signal the CLIs emit in a machine-readable shape.
STAGE = re.compile(r"\b(\d+)\s*/\s*(\d+)\b\s+([A-Za-z][\w .-]*)")

KINDS = {
    "object": ("dreamspace.cli.generate", "image → mesh"),
    "room": ("dreamspace.cli.room", "photo → scene"),
    # Calls the *deployed* Modal app rather than `modal run`, which would create
    # and tear down a throwaway app on every single click. It obeys the same
    # outputs/<stem>.glb convention, so runs.py and the viewer treat what comes
    # back exactly like a locally generated mesh.
    "cloud": ("modal_app/call.py", "image → mesh · Hunyuan3D on Modal"),
}


def safe_filename(raw: str) -> str:
    """A file name that cannot escape the directory it is written into."""
    name = Path(raw.replace("\\", "/")).name          # drop any path component
    stem, dot, ext = name.rpartition(".")
    ext = ("." + ext.lower()) if dot else ""
    if ext not in IMAGE_EXT:
        raise ValueError(f"not an image: {raw!r}")
    stem = SAFE_CHARS.sub("-", stem).strip("-._")
    return (stem or "upload") + ext


def store_upload(inputs: Path, filename: str, data: bytes) -> Path:
    """Write an uploaded image into inputs/, without overwriting anything."""
    if len(data) > MAX_UPLOAD:
        raise ValueError(f"image is {len(data)/1e6:.0f} MB; the limit is "
                         f"{MAX_UPLOAD/1e6:.0f} MB")
    if not data:
        raise ValueError("empty upload")

    inputs.mkdir(parents=True, exist_ok=True)
    name = safe_filename(filename)
    target = inputs / name
    if target.is_file() and target.read_bytes() == data:
        return target                                  # same picture, same name
    stem, ext = target.stem, target.suffix
    n = 2
    while target.is_file():
        target = inputs / f"{stem}-{n}{ext}"
        n += 1
    target.write_bytes(data)
    return target


@dataclass
class Job:
    id: str
    kind: str
    image: Path
    options: dict
    state: str = "queued"          # queued | running | done | failed | cancelled
    stage: str = ""
    lines: deque = field(default_factory=lambda: deque(maxlen=400))
    queued_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    returncode: int | None = None
    error: str = ""
    _proc: subprocess.Popen | None = None

    @property
    def run_id(self) -> str:
        """Which run this job will produce, for the viewer to jump to."""
        return self.image.stem if self.kind == "room" else f"{self.image.stem}.glb"

    def snapshot(self) -> dict:
        end = self.finished_at or time.time()
        return {
            "id": self.id,
            "kind": self.kind,
            "label": KINDS[self.kind][1],
            "image": self.image.name,
            "image_url": f"/_inputs/{self.image.name}",
            "state": self.state,
            "stage": self.stage,
            "options": self.options,
            "run_id": self.run_id,
            "elapsed": round(end - self.started_at, 1) if self.started_at else 0.0,
            "waited": round((self.started_at or time.time()) - self.queued_at, 1),
            "returncode": self.returncode,
            "error": self.error,
            "log": list(self.lines)[-60:],
        }


class JobRunner:
    """A single worker thread and the queue feeding it."""

    def __init__(self, outputs: Path, inputs: Path, python: str | None = None):
        self.outputs = Path(outputs)
        self.inputs = Path(inputs)
        self.python = python or sys.executable
        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._queue: Queue[Job] = Queue()
        self._lock = threading.Lock()
        self._counter = 0
        self._worker = threading.Thread(target=self._run_forever, daemon=True)
        self._worker.start()

    # -- public ------------------------------------------------------------
    def submit(self, kind: str, image: Path, options: dict | None = None) -> Job:
        if kind not in KINDS:
            raise ValueError(f"unknown job kind: {kind!r}")
        with self._lock:
            self._counter += 1
            job = Job(id=f"j{self._counter}", kind=kind, image=Path(image),
                      options=options or {})
            self._jobs[job.id] = job
            self._order.append(job.id)
        self._queue.put(job)
        return job

    def snapshot(self) -> list[dict]:
        with self._lock:
            jobs = [self._jobs[i] for i in self._order]
        return [j.snapshot() for j in jobs]

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None or job.state in ("done", "failed", "cancelled"):
            return False
        if job.state == "queued":
            job.state = "cancelled"
            job.finished_at = time.time()
            return True
        proc = job._proc
        if proc and proc.poll() is None:
            # Blender, if this job got as far as assembly, is a grandchild and
            # outlives the terminate. It exits on its own once its input is gone.
            proc.terminate()
            job.state = "cancelled"
            return True
        return False

    # -- worker ------------------------------------------------------------
    def _command(self, job: Job) -> list[str]:
        module = KINDS[job.kind][0]
        opt = job.options

        if job.kind == "cloud":
            # A plain script, not a `modal run` target: it looks the deployed
            # class up by name and calls it. The path is relative to the repo
            # root, which is the cwd _run uses.
            cmd = [self.python, module,
                   "--image", str(job.image), "--out", str(self.outputs)]
            if opt.get("no_texture"):
                cmd.append("--no-texture")
            for flag, key in (("--octree-resolution", "octree_resolution"),
                              ("--steps", "steps")):
                if opt.get(key) not in (None, ""):
                    cmd += [flag, str(int(opt[key]))]
            return cmd

        cmd = [self.python, "-m", module, "--image", str(job.image)]

        if job.kind == "object":
            cmd += ["--out", str(self.outputs)]
            if opt.get("no_texture"):
                cmd.append("--no-texture")
            if opt.get("mc_resolution"):
                cmd += ["--mc-resolution", str(int(opt["mc_resolution"]))]
        else:
            for flag, key, cast in (("--fov", "fov", float),
                                    ("--threshold", "threshold", float),
                                    ("--decimate", "decimate", float)):
                if opt.get(key) not in (None, ""):
                    cmd += [flag, str(cast(opt[key]))]
            if opt.get("walls"):
                cmd += ["--walls", str(opt["walls"])]
            if opt.get("labels"):
                cmd += ["--labels", str(opt["labels"])]
        return cmd

    def _environment(self) -> dict:
        return {
            **os.environ,
            # The viewer may be serving a directory that is not the configured
            # one, and a result the viewer cannot see is not a result.
            "OUTPUT_DIR": str(self.outputs),
            "PYTHONUNBUFFERED": "1",
            # Without this the child encodes its output with the console
            # codepage - cp1252 here - and rich's rules and arrows kill the run
            # with a UnicodeEncodeError several minutes in. UTF-8 mode covers
            # stdio and every other text stream the pipeline opens.
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
            # rich formats for whatever terminal it thinks it has; through a
            # pipe that means escape codes and box-drawing in the log tail.
            "NO_COLOR": "1",
            "TERM": "dumb",
            "COLUMNS": "100",
        }

    def _run_forever(self) -> None:
        while True:
            job = self._queue.get()
            if job.state == "cancelled":
                continue
            self._run(job)

    def _run(self, job: Job) -> None:
        job.state = "running"
        job.started_at = time.time()
        cmd = self._command(job)
        # Drop the interpreter, and the -m with it, so the echoed line reads as
        # the command you would have typed. A script path is cmd[1] and has to
        # survive; `-m module` is cmd[1:3] and only the module is worth showing.
        shown = cmd[2:] if cmd[1:2] == ["-m"] else cmd[1:]
        job.lines.append("$ " + " ".join(shown))
        try:
            proc = subprocess.Popen(
                cmd, cwd=str(self.outputs.parent), env=self._environment(),
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1, encoding="utf-8", errors="replace",
            )
        except OSError as exc:
            job.state, job.error = "failed", str(exc)
            job.finished_at = time.time()
            return

        job._proc = proc
        for line in proc.stdout:
            line = line.rstrip()
            if not line:
                continue
            job.lines.append(line)
            match = STAGE.search(line)
            if match:
                job.stage = f"{match.group(1)}/{match.group(2)} {match.group(3).strip()}"
        proc.wait()

        job.returncode = proc.returncode
        job.finished_at = time.time()
        if job.state == "cancelled":
            return
        if proc.returncode == 0:
            job.state, job.stage = "done", "finished"
        else:
            job.state = "failed"
            job.stage = ""
            # The last thing printed is nearly always the reason.
            job.error = next((ln for ln in reversed(job.lines) if ln.strip()),
                             f"exited with {proc.returncode}")
