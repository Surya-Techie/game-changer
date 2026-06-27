"""Tiny key-value cache facade with a Redis-or-in-memory fallback.

Why a facade?
-------------
The pattern engine wants to cache `/patterns/detect` responses for 60s so
a Scanner that polls 50 symbols every few seconds isn't hammering yfinance
or re-running ML inference. The Node backend already uses Redis; we keep
parity by trying Redis here too, but a fresh dev machine without Redis
shouldn't have to start one to run the ai-service — so we transparently
fall back to a thread-safe in-process dict with per-key TTLs.

Configuration
-------------
Two env vars (either works):
  - PATTERN_REDIS_URL  (preferred — namespaced to this engine)
  - REDIS_URL          (fallback — shared with Node backend if present)

If neither is set, or the Redis connection fails on first use, all calls
silently degrade to the in-memory store. The behaviour is identical from
the caller's perspective.
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any, Optional


class _InMemoryCache:
    def __init__(self) -> None:
        self._store: dict[str, tuple[str, float]] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> Optional[str]:
        now = time.time()
        with self._lock:
            tup = self._store.get(key)
            if tup is None:
                return None
            value, expires_at = tup
            if expires_at <= now:
                self._store.pop(key, None)
                return None
            return value

    def set(self, key: str, value: str, ttl_seconds: int) -> None:
        with self._lock:
            self._store[key] = (value, time.time() + max(1, ttl_seconds))

    def delete(self, key: str) -> None:
        with self._lock:
            self._store.pop(key, None)

    def info(self) -> dict:
        with self._lock:
            return {"backend": "in_memory", "size": len(self._store)}


class PatternCache:
    """Public cache facade. Lazy on Redis: we try connecting on first call
    and stick with whichever backend works."""

    _instance: Optional["PatternCache"] = None
    _instance_lock = threading.Lock()

    def __init__(self) -> None:
        self._inmem = _InMemoryCache()
        self._redis_client: Any = None  # populated lazily
        self._redis_attempted = False
        self._redis_url = os.environ.get("PATTERN_REDIS_URL") or os.environ.get("REDIS_URL")

    @classmethod
    def shared(cls) -> "PatternCache":
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    # ─── Redis lazy init ────────────────────────────────────────────────

    def _try_init_redis(self) -> None:
        if self._redis_attempted:
            return
        self._redis_attempted = True
        if not self._redis_url:
            return
        try:
            import redis  # type: ignore
            client = redis.from_url(self._redis_url, decode_responses=True, socket_timeout=2.0)
            client.ping()
            self._redis_client = client
        except Exception:  # noqa: BLE001 — falling back to in-memory is fine.
            self._redis_client = None

    # ─── API ────────────────────────────────────────────────────────────

    def get(self, key: str) -> Optional[Any]:
        self._try_init_redis()
        if self._redis_client is not None:
            try:
                raw = self._redis_client.get(key)
                return json.loads(raw) if raw else None
            except Exception:  # noqa: BLE001
                # Connection died mid-flight — drop back to in-memory until next process restart.
                self._redis_client = None
        raw = self._inmem.get(key)
        return json.loads(raw) if raw else None

    def set(self, key: str, value: Any, ttl_seconds: int = 60) -> None:
        payload = json.dumps(value, default=str)
        self._try_init_redis()
        if self._redis_client is not None:
            try:
                self._redis_client.setex(key, ttl_seconds, payload)
                return
            except Exception:  # noqa: BLE001
                self._redis_client = None
        self._inmem.set(key, payload, ttl_seconds)

    def delete(self, key: str) -> None:
        self._try_init_redis()
        if self._redis_client is not None:
            try:
                self._redis_client.delete(key)
            except Exception:  # noqa: BLE001
                pass
        self._inmem.delete(key)

    def info(self) -> dict:
        self._try_init_redis()
        if self._redis_client is not None:
            try:
                self._redis_client.ping()
                return {"backend": "redis", "url": self._redis_url}
            except Exception:  # noqa: BLE001
                self._redis_client = None
        return self._inmem.info()
