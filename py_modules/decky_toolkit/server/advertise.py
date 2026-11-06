"""DNS-SD advertisement of the HTTP server through the device's avahi-daemon (`avahi-publish`).

The OS image is immutable, so a static `/etc/avahi/services` file is not an option; `avahi-publish`
keeps the registration exactly as long as the process lives.
"""
import asyncio
import ctypes
import logging
import shutil
import signal
import socket

from ..system import clean_env

SERVICE_TYPE = "_decky-toolkit._tcp"
BACKOFF_SECONDS = (5, 30, 60)
PR_SET_PDEATHSIG = 1


def _die_with_parent() -> None:
    # A loader crash leaves the backend orphaned and our watchdog os._exit()s it; without this the
    # avahi-publish child would keep advertising a server that is gone.
    try:
        ctypes.CDLL(None, use_errno=True).prctl(PR_SET_PDEATHSIG, signal.SIGTERM)
    except (OSError, AttributeError):
        pass


def instance_name(hostname: str | None = None) -> str:
    name = (hostname or socket.gethostname()).split(".")[0].strip()
    return (name or "Decky Toolkit")[:63]


def txt_records(version: str, api: tuple[str, ...], device_id: str | None) -> list[str]:
    txt = [f"api={','.join(api)}", f"version={version}"]
    if device_id:
        txt.append(f"id={device_id}")
    return txt


class Advertiser:
    def __init__(self, logger: logging.Logger, port: int, txt: list[str], name: str | None = None,
                 binary: str = "avahi-publish", backoff: tuple[float, ...] = BACKOFF_SECONDS):
        self.log = logger
        self.port = port
        self.txt = txt
        self.name = name or instance_name()
        self.binary = binary
        self.backoff = backoff
        self.task: asyncio.Task | None = None
        self.proc: asyncio.subprocess.Process | None = None

    def argv(self, path: str) -> list[str]:
        return [path, "-s", self.name, SERVICE_TYPE, str(self.port), *self.txt]

    def start(self) -> None:
        if self.task is None:
            self.task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        task, self.task = self.task, None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def _run(self) -> None:
        path = shutil.which(self.binary)
        if path is None:
            self.log.info("%s not found; not advertising %s over mDNS", self.binary, SERVICE_TYPE)
            return
        failures = 0
        while True:
            try:
                self.proc = await asyncio.create_subprocess_exec(
                    *self.argv(path), stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE, env=clean_env(), preexec_fn=_die_with_parent)
            except OSError as e:
                self.log.warning("could not start %s: %s", self.binary, e)
                return
            self.log.info("advertising %s '%s' on port %s", SERVICE_TYPE, self.name, self.port)
            started = asyncio.get_running_loop().time()
            try:
                _, err = await self.proc.communicate()
            except asyncio.CancelledError:
                await self._terminate()
                raise
            # avahi-daemon restarts or name collisions end the process; publish again after a pause.
            if asyncio.get_running_loop().time() - started > self.backoff[-1]:
                failures = 0
            delay = self.backoff[min(failures, len(self.backoff) - 1)]
            failures += 1
            self.log.warning("%s exited with %s (%s); retrying in %ss", self.binary, self.proc.returncode,
                             err.decode(errors="replace").strip()[-200:], delay)
            await asyncio.sleep(delay)

    async def _terminate(self) -> None:
        proc = self.proc
        if proc is None or proc.returncode is not None:
            return
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), 2)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
