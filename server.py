#!/usr/bin/env python3
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
import hashlib
import json
import re
import secrets
import sqlite3
import time


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "app.db"
LEGACY_DB_PATH = DATA_DIR / "db.json"
HOST = "0.0.0.0"
PORT = 8080
SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
MAX_JSON_BYTES = 256 * 1024

DEFAULT_STATE = {
    "funds": ["161725", "110022", "005827", "003096"],
    "holdings": {
        "161725": 12000,
        "110022": 8000,
        "005827": 10000,
        "003096": 6000,
    },
    "alerts": [],
    "sort": "custom",
}

PRODUCTS = {
    "AI 收盘复盘": {"amountCents": 300, "label": "AI 收盘复盘"},
    "组合体检报告": {"amountCents": 900, "label": "组合体检报告"},
    "策略回测报告": {"amountCents": 1900, "label": "策略回测报告"},
    "提醒点数": {"amountCents": 1200, "label": "提醒点数"},
}

LOGIN_BUCKET = {}


def now_ms():
    return int(time.time() * 1000)


def iso_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def user_key(phone):
    return hashlib.sha256(phone.encode("utf-8")).hexdigest()[:24]


def db_connect():
    DATA_DIR.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=8)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    with db_connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              phone TEXT NOT NULL UNIQUE,
              credits INTEGER NOT NULL DEFAULT 30,
              state_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
              token TEXT PRIMARY KEY,
              user_id TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              expires_at INTEGER NOT NULL,
              FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS purchases (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL,
              product TEXT NOT NULL,
              amount_cents INTEGER NOT NULL,
              status TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """
        )
    migrate_legacy_json()


def migrate_legacy_json():
    marker = DATA_DIR / ".json_migrated"
    if marker.exists() or not LEGACY_DB_PATH.exists():
        return
    try:
        legacy = json.loads(LEGACY_DB_PATH.read_text("utf-8"))
    except Exception:
        marker.write_text(str(now_ms()), "utf-8")
        return

    with db_connect() as conn:
        for user_id, user in legacy.get("users", {}).items():
            state_json = json.dumps(user.get("state") or DEFAULT_STATE, ensure_ascii=False)
            conn.execute(
                """
                INSERT OR IGNORE INTO users
                (id, name, phone, credits, state_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    user_id,
                    str(user.get("name") or "养基用户")[:16],
                    str(user.get("phone") or ""),
                    int(user.get("credits") or 30),
                    state_json,
                    user.get("createdAt") or iso_now(),
                    now_ms(),
                ),
            )
        for token, session in legacy.get("sessions", {}).items():
            created_at = int(session.get("createdAt") or now_ms())
            conn.execute(
                """
                INSERT OR IGNORE INTO sessions (token, user_id, created_at, expires_at)
                VALUES (?, ?, ?, ?)
                """,
                (token, session.get("userId"), created_at, created_at + SESSION_TTL_MS),
            )
        for order in legacy.get("purchases", []):
            product = str(order.get("product") or "Pro 服务")[:40]
            conn.execute(
                """
                INSERT OR IGNORE INTO purchases
                (id, user_id, product, amount_cents, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    order.get("id") or secrets.token_hex(8),
                    order.get("userId"),
                    product,
                    PRODUCTS.get(product, {}).get("amountCents", 0),
                    order.get("status") or "demo_pending",
                    int(order.get("createdAt") or now_ms()),
                ),
            )
    marker.write_text(str(now_ms()), "utf-8")


def state_from_row(row):
    try:
        return json.loads(row["state_json"])
    except Exception:
        return DEFAULT_STATE


def public_user(row, token=None):
    payload = {
        "id": row["id"],
        "name": row["name"],
        "phone": row["phone"],
        "credits": row["credits"],
        "createdAt": row["created_at"],
    }
    if token:
        payload["token"] = token
    return payload


def public_order(row):
    return {
        "id": row["id"],
        "product": row["product"],
        "amountCents": row["amount_cents"],
        "status": row["status"],
        "createdAt": row["created_at"],
    }


def clean_state_payload(state):
    holdings = {}
    for code, amount in (state.get("holdings") or {}).items():
        code = str(code)[:6]
        if not code.isdigit():
            continue
        try:
            holdings[code] = max(0, round(float(amount), 2))
        except (TypeError, ValueError):
            holdings[code] = 0

    alerts = []
    for item in (state.get("alerts") or [])[:100]:
        code = str(item.get("code") or "")[:6]
        alert_type = str(item.get("type") or "")
        if not code.isdigit() or alert_type not in {"up", "down"}:
            continue
        try:
            value = max(0.1, min(99, round(abs(float(item.get("value"))), 2)))
        except (TypeError, ValueError):
            continue
        alerts.append({"code": code, "type": alert_type, "value": value})

    funds = []
    for code in state.get("funds", [])[:100]:
        code = str(code)[:6]
        if code.isdigit() and code not in funds:
            funds.append(code)

    sort = state.get("sort") if state.get("sort") in {"custom", "change", "profit", "name"} else "custom"
    return {"funds": funds, "holdings": holdings, "alerts": alerts, "sort": sort}


class AppHandler(SimpleHTTPRequestHandler):
    server_version = "JizhunxianServer/2.0"

    def translate_path(self, path):
        path = urlparse(path).path
        if path == "/":
            path = "/index.html"
        return str(ROOT / path.lstrip("/"))

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        super().end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            return self.json_response({"ok": True, "time": now_ms(), "store": "sqlite"})
        if path == "/api/me":
            user, _token = self.require_user()
            if not user:
                return self.error_response("unauthorized", "请重新登录", 401)
            return self.json_response({
                "user": public_user(user),
                "state": state_from_row(user),
                "orders": self.user_orders(user["id"]),
            })
        if path == "/api/orders":
            user, _token = self.require_user()
            if not user:
                return self.error_response("unauthorized", "请重新登录", 401)
            return self.json_response({"orders": self.user_orders(user["id"])})
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/login":
            return self.login()
        if path == "/api/logout":
            return self.logout()
        if path == "/api/state":
            return self.save_state()
        if path == "/api/purchase":
            return self.purchase()
        return self.error_response("not_found", "接口不存在", 404)

    def login(self):
        if not self.allow_login_attempt():
            return self.error_response("rate_limited", "操作太频繁，请稍后再试", 429)

        body = self.read_json()
        name = re.sub(r"\s+", "", str(body.get("name") or "养基用户"))[:16] or "养基用户"
        phone = "".join(ch for ch in str(body.get("phone") or "") if ch.isdigit())
        if not re.fullmatch(r"1[3-9]\d{9}", phone):
            return self.error_response("invalid_phone", "请输入 11 位中国大陆手机号", 422)

        user_id = user_key(phone)
        created = iso_now()
        token = secrets.token_urlsafe(32)
        expires_at = now_ms() + SESSION_TTL_MS
        with db_connect() as conn:
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            is_new_user = row is None
            if is_new_user:
                conn.execute(
                    """
                    INSERT INTO users (id, name, phone, credits, state_json, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        user_id,
                        name,
                        phone,
                        30,
                        json.dumps(DEFAULT_STATE, ensure_ascii=False),
                        created,
                        now_ms(),
                    ),
                )
            else:
                conn.execute(
                    "UPDATE users SET name = ?, phone = ?, updated_at = ? WHERE id = ?",
                    (name, phone, now_ms(), user_id),
                )
            conn.execute(
                "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                (token, user_id, now_ms(), expires_at),
            )
            conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now_ms(),))
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()

        return self.json_response({
            "user": public_user(row, token),
            "state": state_from_row(row),
            "orders": self.user_orders(user_id),
            "isNewUser": is_new_user,
        })

    def logout(self):
        token = self.auth_token()
        if token:
            with db_connect() as conn:
                conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        return self.json_response({"ok": True})

    def save_state(self):
        user, _token = self.require_user()
        if not user:
            return self.error_response("unauthorized", "请重新登录", 401)
        clean_state = clean_state_payload((self.read_json().get("state") or {}))
        with db_connect() as conn:
            conn.execute(
                "UPDATE users SET state_json = ?, updated_at = ? WHERE id = ?",
                (json.dumps(clean_state, ensure_ascii=False), now_ms(), user["id"]),
            )
        return self.json_response({"ok": True, "state": clean_state})

    def purchase(self):
        user, _token = self.require_user()
        if not user:
            return self.error_response("unauthorized", "请重新登录", 401)
        product = str(self.read_json().get("productName") or "")[:40]
        if product not in PRODUCTS:
            return self.error_response("invalid_product", "暂不支持该服务", 422)

        order = {
            "id": secrets.token_hex(8),
            "user_id": user["id"],
            "product": product,
            "amount_cents": PRODUCTS[product]["amountCents"],
            "status": "pending_payment",
            "created_at": now_ms(),
        }
        with db_connect() as conn:
            conn.execute(
                """
                INSERT INTO purchases (id, user_id, product, amount_cents, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    order["id"],
                    order["user_id"],
                    order["product"],
                    order["amount_cents"],
                    order["status"],
                    order["created_at"],
                ),
            )
        return self.json_response({"ok": True, "order": public_order(order)})

    def user_orders(self, user_id):
        with db_connect() as conn:
            rows = conn.execute(
                """
                SELECT id, product, amount_cents, status, created_at
                FROM purchases
                WHERE user_id = ?
                ORDER BY created_at DESC
                LIMIT 10
                """,
                (user_id,),
            ).fetchall()
        return [public_order(row) for row in rows]

    def require_user(self):
        token = self.auth_token()
        if not token:
            return None, None
        with db_connect() as conn:
            row = conn.execute(
                """
                SELECT users.*
                FROM sessions
                JOIN users ON users.id = sessions.user_id
                WHERE sessions.token = ? AND sessions.expires_at > ?
                """,
                (token, now_ms()),
            ).fetchone()
        return row, token

    def allow_login_attempt(self):
        ip = self.client_address[0]
        bucket = [ts for ts in LOGIN_BUCKET.get(ip, []) if now_ms() - ts < 60_000]
        if len(bucket) >= 12:
            LOGIN_BUCKET[ip] = bucket
            return False
        bucket.append(now_ms())
        LOGIN_BUCKET[ip] = bucket
        return True

    def auth_token(self):
        header = self.headers.get("Authorization", "")
        if header.startswith("Bearer "):
            return header[7:].strip()
        return None

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            return {}
        if length <= 0 or length > MAX_JSON_BYTES:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def error_response(self, code, message, status):
        return self.json_response({"error": code, "message": message}, status)

    def json_response(self, payload, status=200):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    init_db()
    print(f"Jizhunxian server listening on http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), AppHandler).serve_forever()
