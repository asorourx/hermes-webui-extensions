"""docker_inspect() returns SAFE per-container detail for the info (ⓘ) panel and
NOTHING sensitive. Guards three things:
  1. network IPs + published/exposed ports are extracted from `docker inspect`,
  2. env vars, mounts, and command lines are NEVER forwarded (privacy stance),
  3. the operator opt-in allowlist is re-checked, so an un-opted-in container
     can't be probed by feeding its id straight to the endpoint.

Runnable directly (``python3 test_docker_inspect.py``) or via pytest. No docker
needed: subprocess.run is faked with a realistic `inspect --format {{json .}}`.
"""
import json
import os
import tempfile

os.environ["HERMES_SYSINFO_STATE_DIR"] = tempfile.mkdtemp(prefix="sysinfo-insp-")

import docker_stats


class _FakeR:
    def __init__(self, rc=0, out="", err=""):
        self.returncode, self.stdout, self.stderr = rc, out, err


# A realistic `docker inspect` object, including fields that MUST NOT leak.
_INSPECT = {
    "Name": "/AppDB",
    "Created": "2026-08-20T10:00:00.123456789Z",
    "Config": {
        "Image": "ghcr.io/acme/appdb:1.4",
        "Env": ["POSTGRES_PASSWORD=SUPERSECRET", "API_KEY=leakme"],   # must not leak
        "Cmd": ["postgres", "-c", "shared_buffers=256MB"],            # must not leak
        "Labels": {
            "com.docker.compose.project": "acme",
            "com.docker.compose.service": "db",
        },
    },
    "State": {"Status": "running", "StartedAt": "2026-08-25T08:00:00.5Z",
              "ExitCode": 0, "Health": {"Status": "healthy"}},
    "HostConfig": {"RestartPolicy": {"Name": "unless-stopped"}},
    "Mounts": [{"Source": "/srv/secret/data", "Destination": "/var/lib/pg"}],  # must not leak
    "NetworkSettings": {
        "IPAddress": "",
        "Networks": {"acme_default": {"IPAddress": "172.20.0.4"}},
        "Ports": {
            "5432/tcp": [{"HostIp": "0.0.0.0", "HostPort": "5432"},
                         {"HostIp": "::", "HostPort": "5432"}],
            "9100/tcp": None,   # exposed but not published
        },
    },
}


def _patch(inspect_obj, allow_env):
    saved = (docker_stats.subprocess.run, docker_stats.docker_present,
             dict(os.environ))

    def fake_run(argv, **kw):
        if len(argv) > 1 and argv[1] == "inspect":
            return _FakeR(0, json.dumps(inspect_obj) + "\n")
        return _FakeR(1, "")

    docker_stats.subprocess.run = fake_run
    docker_stats.docker_present = lambda: True
    for k in ("MC_DOCKER_SHOW_ALL", "MC_DOCKER_NAME_ALLOW", "MC_DOCKER_WORKDIR_PREFIX"):
        os.environ.pop(k, None)
    os.environ.update(allow_env)
    return saved


def _restore(saved):
    run, present, env = saved
    docker_stats.subprocess.run = run
    docker_stats.docker_present = present
    os.environ.clear(); os.environ.update(env)


def test_safe_fields_and_no_leak():
    saved = _patch(_INSPECT, {"MC_DOCKER_SHOW_ALL": "1"})
    try:
        res = docker_stats.docker_inspect("AppDB")
    finally:
        _restore(saved)
    assert res.get("ok") is True, res
    d = res["detail"]
    assert d["name"] == "AppDB"
    assert d["image"] == "ghcr.io/acme/appdb:1.4"
    assert d["state"] == "running" and d["health"] == "healthy"
    assert d["restart_policy"] == "unless-stopped"
    assert d["compose_project"] == "acme" and d["compose_service"] == "db"
    assert d["networks"] == {"acme_default": "172.20.0.4"}
    # published port collapses 0.0.0.0/:: to host->container; 9100 is exposed-only
    assert "5432->5432/tcp" in d["ports"]
    assert "9100/tcp" in d["ports"]
    # NOTHING sensitive may appear anywhere in the serialized payload
    blob = json.dumps(res)
    for secret in ("SUPERSECRET", "leakme", "shared_buffers", "/srv/secret", "POSTGRES_PASSWORD"):
        assert secret not in blob, f"LEAKED: {secret}"


def test_allowlist_denies_unlisted():
    # nothing opted in → deny, even though the id resolves in docker
    saved = _patch(_INSPECT, {})
    try:
        res = docker_stats.docker_inspect("AppDB")
    finally:
        _restore(saved)
    assert res == {"ok": False, "error": "not_allowed"}, res


def test_name_prefix_allowlist():
    saved = _patch(_INSPECT, {"MC_DOCKER_NAME_ALLOW": "appdb"})   # case-insensitive prefix
    try:
        res = docker_stats.docker_inspect("AppDB")
    finally:
        _restore(saved)
    assert res.get("ok") is True, res


def test_bad_input():
    assert docker_stats.docker_inspect("")["error"] == "bad_request"
    assert docker_stats.docker_inspect(None)["error"] == "bad_request"


if __name__ == "__main__":
    test_safe_fields_and_no_leak()
    test_allowlist_denies_unlisted()
    test_name_prefix_allowlist()
    test_bad_input()
    print("all docker_inspect tests passed")
