#!/usr/bin/env python3
"""Servidor de suscripciones Web Push de Vigía. Solo librería estándar
(http.server + sqlite3 + json) — la excepción a "cero dependencias" es
pywebpush en `push/send.py`, no este servidor.

Expone /api/push/subscribe, /api/push/unsubscribe y /api/push/health en
la red interna de docker compose; nginx hace el proxy con HTTPS real.
"""
import json
import logging
import os
import sqlite3
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DB_PATH = Path(os.environ.get("PUSH_DB", Path(__file__).resolve().parent.parent / "data" / "push.db"))
HOST = "0.0.0.0"
PORT = 8300
MAX_BODY = 4096
RATE_LIMIT_N = 10
RATE_LIMIT_WINDOW_S = 60.0

# Hosts de push conocidos (navegadores mayoritarios). Firefox/Windows
# publican bajo subdominios variables, de ahí el match por sufijo.
ENDPOINT_HOSTS_EXACT = {"fcm.googleapis.com"}
ENDPOINT_HOSTS_SUFFIX = (
    ".push.services.mozilla.com",
    ".notify.windows.com",
    ".push.apple.com",
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [push] %(message)s")
log = logging.getLogger("push.server")

# Rate-limit en memoria: IP -> timestamps (monotonic) de sus POSTs recientes.
_rate: dict[str, list[float]] = {}


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.execute(
        "CREATE TABLE IF NOT EXISTS subs("
        "endpoint TEXT PRIMARY KEY, p256dh TEXT, auth TEXT, created TEXT)"
    )
    return con


def _client_ip(handler: BaseHTTPRequestHandler) -> str:
    xff = handler.headers.get("X-Forwarded-For")
    if xff:
        return xff.split(",")[0].strip()
    return handler.client_address[0]


def _rate_limited(ip: str) -> bool:
    now = time.monotonic()
    hits = [t for t in _rate.get(ip, []) if now - t < RATE_LIMIT_WINDOW_S]
    hits.append(now)
    _rate[ip] = hits
    return len(hits) > RATE_LIMIT_N


def _valid_endpoint(endpoint) -> bool:
    if not isinstance(endpoint, str) or not endpoint.startswith("https://"):
        return False
    host = urllib.parse.urlparse(endpoint).hostname or ""
    if host in ENDPOINT_HOSTS_EXACT:
        return True
    return any(host.endswith(suf) for suf in ENDPOINT_HOSTS_SUFFIX)


def _valid_subscription(payload) -> bool:
    if not isinstance(payload, dict) or not _valid_endpoint(payload.get("endpoint")):
        return False
    keys = payload.get("keys")
    return isinstance(keys, dict) and bool(keys.get("p256dh")) and bool(keys.get("auth"))


class Handler(BaseHTTPRequestHandler):
    server_version = "vigia-push/1.0"

    def log_message(self, fmt, *args):
        log.info("%s %s", self.client_address[0], fmt % args)

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            return None
        if length <= 0 or length > MAX_BODY:
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    def do_GET(self):
        if self.path == "/api/push/health":
            con = _connect()
            n = con.execute("SELECT COUNT(*) FROM subs").fetchone()[0]
            con.close()
            self._send_json(200, {"subs": n})
            return
        if self.path == "/api/push/vapid":
            self._send_json(200, {"publicKey": os.environ.get("VAPID_PUBLIC_KEY", "")})
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self):
        ip = _client_ip(self)
        if _rate_limited(ip):
            self._send_json(429, {"error": "rate limit"})
            return

        if self.path == "/api/push/subscribe":
            payload = self._read_json()
            if not _valid_subscription(payload):
                self._send_json(400, {"error": "invalid subscription"})
                return
            con = _connect()
            con.execute(
                "INSERT OR REPLACE INTO subs(endpoint, p256dh, auth, created) "
                "VALUES (?, ?, ?, datetime('now'))",
                (payload["endpoint"], payload["keys"]["p256dh"], payload["keys"]["auth"]),
            )
            con.commit()
            con.close()
            log.info("subscribe ok endpoint=%s...", payload["endpoint"][:48])
            self._send_json(201, {"ok": True})
            return

        if self.path == "/api/push/unsubscribe":
            payload = self._read_json()
            if not isinstance(payload, dict) or not payload.get("endpoint"):
                self._send_json(400, {"error": "invalid"})
                return
            con = _connect()
            con.execute("DELETE FROM subs WHERE endpoint = ?", (payload["endpoint"],))
            con.commit()
            con.close()
            log.info("unsubscribe endpoint=%s...", str(payload["endpoint"])[:48])
            self._send_json(200, {"ok": True})
            return

        self._send_json(404, {"error": "not found"})


def main() -> None:
    _connect().close()
    log.info("escuchando en %s:%d (db=%s)", HOST, PORT, DB_PATH)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
