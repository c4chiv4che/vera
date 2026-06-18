"""
Vera M2 Gateway — minimal stub entrypoint.

This is NOT the production SIP gateway. Its job is narrow:
  1. Prove that the Docker image is well-formed end-to-end
     (libs load, pjsua2 binds, the process stays alive).
  2. Open UDP 5060 so the ECS health check (or a manual `nc`)
     sees the port listening.
  3. Print a heartbeat to stdout so CloudWatch confirms log
     plumbing works.

It does NOT accept SIP INVITEs, does NOT process SDP, does NOT
talk to Nova Sonic, does NOT use Strands. The real production
gateway will live elsewhere — see docs/decisions.md (Phase D M2
plan) and the M1 verdict.

Replaced when the production gateway lands.
"""

from __future__ import annotations

import logging
import signal
import sys
import time
from typing import Any

# Configure logging to stdout so the awslogs driver picks it up.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [stub] %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("gateway_stub")


def _import_pjsua2() -> Any:
    """Import pjsua2 with a clear failure mode.

    If pjsua2 is missing or its .so can't link, we want a loud,
    explicit error in CloudWatch — not a silent crash that makes
    the Dockerfile look fine when it isn't.
    """
    try:
        import pjsua2 as pj
        log.info("pjsua2 imported successfully")
        return pj
    except ImportError as e:
        log.error("pjsua2 import failed: %s", e)
        log.error("This means the Docker image is broken — check builder stage.")
        sys.exit(1)


def _build_endpoint(pj: Any) -> Any:
    """Initialize a minimal pjsua2 Endpoint.

    Order matters here, learned from M1:
      libCreate() -> libInit() -> setNullDev() -> libStart() -> transportCreate()

    setNullDev() before libStart() is REQUIRED for headless environments
    (no audio device available, which is always the case on Fargate).
    """
    ep = pj.Endpoint()
    ep.libCreate()

    ep_cfg = pj.EpConfig()
    ep_cfg.logConfig.level = 3
    ep_cfg.logConfig.consoleLevel = 3
    ep.libInit(ep_cfg)

    # Headless: bind sound to a null device BEFORE starting the library.
    ep.audDevManager().setNullDev()

    ep.libStart()
    log.info("pjsua2 Endpoint started (libVersion=%s)", ep.libVersion().full)

    transport_cfg = pj.TransportConfig()
    transport_cfg.port = 5060
    transport_id = ep.transportCreate(pj.PJSIP_TRANSPORT_UDP, transport_cfg)
    log.info("UDP transport created on port 5060 (id=%s)", transport_id)

    return ep


def _install_signal_handlers(ep: Any) -> None:
    """Handle SIGTERM cleanly.

    ECS sends SIGTERM when the service does a Stop. Catching it lets us
    shut pjsua2 down properly instead of dying mid-loop. ECS will SIGKILL
    after 30s if we haven't exited by then.
    """
    def shutdown(signum: int, _frame: Any) -> None:
        log.info("Received signal %d, shutting down pjsua2", signum)
        try:
            ep.libDestroy()
        except Exception as e:
            log.warning("libDestroy raised during shutdown: %s", e)
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)


def main() -> None:
    log.info("vera-m2-gateway stub starting")
    pj = _import_pjsua2()
    ep = _build_endpoint(pj)
    _install_signal_handlers(ep)

    log.info("stub ready; entering heartbeat loop")
    while True:
        time.sleep(30)
        log.info("alive")


if __name__ == "__main__":
    main()
