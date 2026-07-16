"""Narrow mihomo fake-IP fallback for Crawl4AI's existing egress broker.

The pinned upstream image rejects every non-global address and routes Chromium
through a localhost proxy that dials the validated IP. On this Ubuntu host,
mihomo returns 198.18/15 for every public DNS query, so the correct guard rejects
all public sites. This adapter changes only resolution: if and only if every
system answer is in 198.18/15, resolve A/AAAA through a fixed DoH endpoint and
hand those answers back to the upstream global-address check and pinning proxy.

Real private, metadata, loopback, mixed fake/private, redirects and rebinding are
still decided by the upstream broker. This module never has an allow-internal
mode and never marks an address safe itself.
"""

from __future__ import annotations

import ipaddress
import json
import os
import socket
import threading
import time
import urllib.parse
import urllib.request
from typing import Callable

_FAKE_IP_NETWORK = ipaddress.ip_network("198.18.0.0/15")
_DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query"
_MAX_DOH_RESPONSE = 64 * 1024
_CACHE_TTL_CAP_SECONDS = 60
_CACHE: dict[tuple[str, int], tuple[float, list[tuple]]] = {}
_CACHE_LOCK = threading.Lock()

Resolver = Callable[[str, int], list[tuple]]


def _sockaddr_ip(answer: tuple) -> str | None:
    try:
        return answer[4][0]
    except (IndexError, TypeError):
        return None


def _all_fake_ip(answers: list[tuple]) -> bool:
    if not answers:
        return False
    ips = [_sockaddr_ip(answer) for answer in answers]
    if any(ip is None for ip in ips):
        return False
    try:
        return all(ipaddress.ip_address(ip) in _FAKE_IP_NETWORK for ip in ips if ip)
    except ValueError:
        return False


def _query(host: str, record_type: str) -> tuple[list[str], int]:
    query = urllib.parse.urlencode({"name": host, "type": record_type})
    request = urllib.request.Request(
        f"{_DOH_ENDPOINT}?{query}", headers={"Accept": "application/dns-json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            raw = response.read(_MAX_DOH_RESPONSE + 1)
    except Exception as error:
        raise socket.gaierror("DoH lookup failed") from error
    if len(raw) > _MAX_DOH_RESPONSE:
        raise socket.gaierror("DoH response too large")
    try:
        payload = json.loads(raw)
    except (TypeError, ValueError) as error:
        raise socket.gaierror("DoH response invalid") from error
    if payload.get("Status") not in (0, 3):
        raise socket.gaierror("DoH lookup failed")

    wanted = 1 if record_type == "A" else 28
    addresses: list[str] = []
    ttls: list[int] = []
    for answer in payload.get("Answer") or []:
        if answer.get("type") != wanted or not isinstance(answer.get("data"), str):
            continue
        try:
            parsed = ipaddress.ip_address(answer["data"])
        except ValueError:
            continue
        if (wanted == 1 and parsed.version != 4) or (wanted == 28 and parsed.version != 6):
            continue
        addresses.append(str(parsed))
        if isinstance(answer.get("TTL"), int):
            ttls.append(answer["TTL"])
    return addresses, min(ttls) if ttls else 5


def doh_lookup(host: str, port: int) -> list[tuple]:
    cache_key = (host.lower().rstrip("."), port)
    now = time.monotonic()
    with _CACHE_LOCK:
        cached = _CACHE.get(cache_key)
        if cached and cached[0] > now:
            return list(cached[1])

    v4, ttl4 = _query(cache_key[0], "A")
    v6, ttl6 = _query(cache_key[0], "AAAA")
    answers: list[tuple] = []
    for address in v4:
        answers.append(
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (address, port))
        )
    for address in v6:
        answers.append(
            (
                socket.AF_INET6,
                socket.SOCK_STREAM,
                socket.IPPROTO_TCP,
                "",
                (address, port, 0, 0),
            )
        )
    if not answers:
        raise socket.gaierror("DoH returned no address")

    ttl = max(1, min(ttl4, ttl6, _CACHE_TTL_CAP_SECONDS))
    with _CACHE_LOCK:
        _CACHE[cache_key] = (now + ttl, list(answers))
    return answers


def make_resolver(
    system_resolver: Resolver,
    *,
    doh_lookup: Resolver = doh_lookup,
    enabled: bool | None = None,
) -> Resolver:
    if enabled is None:
        enabled = os.environ.get("CRAWL4AI_FAKEIP_DOH_FALLBACK", "false").lower() == "true"

    def resolve(host: str, port: int):
        answers = system_resolver(host, port)
        if enabled and _all_fake_ip(answers):
            return doh_lookup(host, port)
        return answers

    return resolve
