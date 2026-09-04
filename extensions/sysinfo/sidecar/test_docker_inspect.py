"""docker_inspect() — allowlist BEFORE inspect, indistinguishable denial, bounded
safe projection, and zero secret/environment leakage.

Runnable directly (``python3 test_docker_inspect.py``) or via pytest. No docker
needed: subprocess.run is faked and ``docker inspect`` CALLS ARE COUNTED, so a
denial can be asserted to run ZERO inspects. The harness restores only the env
keys it touches — it never snapshots the full process environment.
"""
import json
import os
import tempfile

# Point sidecar state at a throwaway dir BEFORE import (docker_stats stamps
# .docker_op_epoch at import). Assign only this one key.
os.environ["HERMES_SYSINFO_STATE_DIR"] = tempfile.mkdtemp(prefix="sysinfo-insp-")

import docker_stats


class _FakeR:
    def __init__(self, rc=0, out="", err=""):
        self.returncode, self.stdout, self.stderr = rc, out, err


_FULL_ID = "abcd1234ef56" + "0" * 52          # 64-hex full id
_SHORT_ID = _FULL_ID[:12]                     # what the UI sends
_PS_LINE = (f"{_FULL_ID}\tAppDB\t"
            "com.docker.compose.project=acme,com.docker.compose.service=db")
_INSPECT = {
    "Name": "/AppDB",
    "Created": "2026-08-20T10:00:00.123456789Z",
    "Config": {
        "Image": "ghcr.io/acme/appdb:1.4",
        "Env": ["POSTGRES_PASSWORD=SUPERSECRET", "API_KEY=leakme"],   # must not leak
        "Cmd": ["postgres", "-c", "shared_buffers=256MB"],            # must not leak
        "Labels": {"com.docker.compose.project": "acme",
                   "com.docker.compose.service": "db"},
    },
    "State": {"Status": "running", "StartedAt": "2026-08-25T08:00:00.5Z",
              "ExitCode": 0, "Health": {"Status": "healthy"}},
    "HostConfig": {"RestartPolicy": {"Name": "unless-stopped"}},
    "Mounts": [{"Source": "/srv/secret/data", "Destination": "/var/lib/pg"}],  # must not leak
    "NetworkSettings": {
        "IPAddress": "",
        "Networks": {"acme_default": {"IPAddress": "172.20.0.4",
                                      "GlobalIPv6Address": "2001:db8::4"}},
        "Ports": {
            "5432/tcp": [{"HostIp": "0.0.0.0", "HostPort": "5432"},
                         {"HostIp": "::", "HostPort": "5432"}],
            "9100/tcp": None,                                     # exposed, unpublished
            "7000/tcp": [{"HostIp": "2001:db8::1", "HostPort": "7000"}],  # IPv6 host bind
        },
    },
}

_MC_KEYS = ("MC_DOCKER_SHOW_ALL", "MC_DOCKER_NAME_ALLOW", "MC_DOCKER_WORKDIR_PREFIX")


class _Harness:
    """Fake docker CLI + allowlist env, restoring ONLY what it touched. Counts
    ``docker inspect`` invocations so denials can be asserted to run zero."""
    def __init__(self, allow_env, ps_out=_PS_LINE + "\n", inspect_obj=None,
                 ps_rc=0, inspect_rc=0, unfiltered_ps_out=None):
        self.allow_env = allow_env
        self.ps_out = ps_out
        self.inspect_obj = _INSPECT if inspect_obj is None else inspect_obj
        self.ps_rc, self.inspect_rc = ps_rc, inspect_rc
        self.unfiltered_ps_out = unfiltered_ps_out
        self.inspect_calls = []

    def __enter__(self):
        self._saved_run = docker_stats.subprocess.run
        self._saved_present = docker_stats.docker_present
        self._saved_env = {k: os.environ.get(k) for k in _MC_KEYS}
        for k in _MC_KEYS:
            os.environ.pop(k, None)
        os.environ.update(self.allow_env)
        docker_stats.docker_present = lambda: True
        self.ps_calls = []

        def fake_run(argv, **kw):
            sub = argv[1] if len(argv) > 1 else ""
            if sub == "ps":
                self.ps_calls.append(list(argv))
                out = self.ps_out
                if self.unfiltered_ps_out is not None and "--filter" not in argv:
                    out = self.unfiltered_ps_out
                return _FakeR(self.ps_rc, out)
            if sub == "inspect":
                self.inspect_calls.append(list(argv))
                return _FakeR(self.inspect_rc, json.dumps(self.inspect_obj) + "\n")
            return _FakeR(0, "")
        docker_stats.subprocess.run = fake_run
        return self

    def __exit__(self, *exc):
        docker_stats.subprocess.run = self._saved_run
        docker_stats.docker_present = self._saved_present
        for k, v in self._saved_env.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)


def test_safe_fields_bounded_and_no_leak():
    with _Harness({"MC_DOCKER_SHOW_ALL": "1"}) as h:
        res = docker_stats.docker_inspect(_SHORT_ID)
    assert res.get("ok") is True, res
    d = res["detail"]
    assert d["name"] == "AppDB"
    assert d["image"] == "ghcr.io/acme/appdb:1.4"
    assert d["state"] == "running" and d["health"] == "healthy"
    assert d["restart_policy"] == "unless-stopped"
    assert d["compose_project"] == "acme" and d["compose_service"] == "db"
    assert d["networks"] == {"acme_default": "172.20.0.4 · 2001:db8::4"}   # IPv4 + IPv6
    assert "5432->5432/tcp" in d["ports"]                     # wildcard/:: collapsed + deduped
    assert "9100/tcp" in d["ports"]                           # exposed-only
    assert "[2001:db8::1]:7000->7000/tcp" in d["ports"]       # IPv6 host bind
    argv = h.inspect_calls[-1]
    assert argv[-1] == _FULL_ID and "--" in argv              # resolved full id + `--` guard
    blob = json.dumps(res)
    for secret in ("SUPERSECRET", "leakme", "shared_buffers", "/srv/secret", "POSTGRES_PASSWORD"):
        assert secret not in blob, f"LEAKED: {secret}"


def test_denial_runs_zero_inspects_and_is_indistinguishable():
    DENIED = {"ok": False, "error": "not_found"}
    # (a) present but not allow-listed
    with _Harness({}) as h:
        assert docker_stats.docker_inspect(_SHORT_ID) == DENIED
        assert h.inspect_calls == [], "denied id must run ZERO docker inspect"
    # (b) valid shape but absent from the daemon
    with _Harness({"MC_DOCKER_SHOW_ALL": "1"}, ps_out="") as h:
        assert docker_stats.docker_inspect("ffffffffffff") == DENIED
        assert h.inspect_calls == []
    # (c) invalid / option-like shapes -> same denial, zero inspects
    for bad in ("--format", "-x", "; rm -rf /", "abc", "ABCDEF012345",
                "abcd1234ef56;", "a" * 65, "", None):
        with _Harness({"MC_DOCKER_SHOW_ALL": "1"}) as h:
            assert docker_stats.docker_inspect(bad) == DENIED, bad
            assert h.inspect_calls == [], f"{bad!r} must run zero inspects"


def test_name_prefix_allowlist_matches_short_id():
    with _Harness({"MC_DOCKER_NAME_ALLOW": "appdb"}):        # case-insensitive prefix
        res = docker_stats.docker_inspect(_SHORT_ID)
    assert res.get("ok") is True, res


def test_lookup_pushes_validated_id_filter_into_docker():
    unrelated = "\n".join(
        f"{'f' * 52}{i:012x}\tunrelated-{i}\t" for i in range(300)
    )
    with _Harness(
        {"MC_DOCKER_SHOW_ALL": "1"},
        ps_out=_PS_LINE + "\n",
        unfiltered_ps_out=unrelated + "\n" + _PS_LINE + "\n",
    ) as h:
        res = docker_stats.docker_inspect(_SHORT_ID)
    assert res.get("ok") is True, res
    assert h.ps_calls, "the allowlist lookup must use docker ps"
    argv = h.ps_calls[-1]
    assert "--filter" in argv
    assert argv[argv.index("--filter") + 1] == f"id={_SHORT_ID}"


def test_one_port_with_many_bindings_stops_at_the_output_budget():
    class _ManyBindings:
        def __iter__(self):
            for i in range(docker_stats._MAX_DETAIL_PORTS + 1):
                yield {"HostIp": f"127.0.0.{i}", "HostPort": str(10000 + i)}
            raise AssertionError("bindings were consumed beyond the bounded budget")

    ports, truncated = docker_stats._bounded_ports(
        {"Ports": {"8080/tcp": _ManyBindings()}}
    )
    assert len(ports) == docker_stats._MAX_DETAIL_PORTS
    assert truncated is True


def test_duplicate_bindings_cannot_bypass_the_scan_budget():
    class _DuplicateBindings:
        def __iter__(self):
            duplicate = {"HostIp": "127.0.0.1", "HostPort": "10000"}
            for _ in range(docker_stats._MAX_DETAIL_PORTS + 1):
                yield duplicate
            raise AssertionError("duplicate bindings bypassed the bounded scan budget")

    ports, truncated = docker_stats._bounded_ports(
        {"Ports": {"8080/tcp": _DuplicateBindings()}}
    )
    assert ports == ["127.0.0.1:10000->8080/tcp"]
    assert truncated is True


def test_projection_is_bounded():
    nets = {f"net{i}": {"IPAddress": f"10.0.0.{i % 250}"} for i in range(300)}
    ports = {f"{9000 + i}/tcp": [{"HostIp": "0.0.0.0", "HostPort": str(9000 + i)}]
             for i in range(300)}
    obj = dict(_INSPECT)
    obj["NetworkSettings"] = {"IPAddress": "", "Networks": nets, "Ports": ports}
    with _Harness({"MC_DOCKER_SHOW_ALL": "1"}, inspect_obj=obj):
        res = docker_stats.docker_inspect(_SHORT_ID)
    d = res["detail"]
    assert len(d["networks"]) <= docker_stats._MAX_DETAIL_NETS
    assert len(d["ports"]) <= docker_stats._MAX_DETAIL_PORTS
    assert d.get("truncated") is True


def test_route_registered_as_get():
    import routes_impl
    seen = []
    class _App:
        def route(self, m, p):
            def deco(fn):
                seen.append((m, p)); return fn
            return deco
        def json(self, *a, **k): return ("json",)
        def gzip_json(self, *a, **k): return ("gzip",)
    routes_impl.register(_App())
    assert ("GET", "/api/system/docker/inspect") in seen


if __name__ == "__main__":
    test_safe_fields_bounded_and_no_leak()
    test_denial_runs_zero_inspects_and_is_indistinguishable()
    test_name_prefix_allowlist_matches_short_id()
    test_lookup_pushes_validated_id_filter_into_docker()
    test_one_port_with_many_bindings_stops_at_the_output_budget()
    test_duplicate_bindings_cannot_bypass_the_scan_budget()
    test_projection_is_bounded()
    test_route_registered_as_get()
    print("all docker_inspect tests passed")
