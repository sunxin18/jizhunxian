#!/usr/bin/env python3
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
import hashlib
import json
import os
import re
import secrets
import sqlite3
import time
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "app.db"
LEGACY_DB_PATH = DATA_DIR / "db.json"


def load_env_file():
    env_path = DATA_DIR / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text("utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


load_env_file()

HOST = "0.0.0.0"
PORT = 8080
SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
MAX_JSON_BYTES = 256 * 1024
EMAIL_CODE_TTL_MS = 10 * 60 * 1000
EMAIL_CODE_RESEND_MS = 60 * 1000
EMAIL_CODE_MAX_ATTEMPTS = 5
RESEND_API_URL = "https://api.resend.com/emails"
RESEND_FROM = os.environ.get("RESEND_FROM", "基准线 <onboarding@resend.dev>")
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
RESEND_DRY_RUN = os.environ.get("RESEND_DRY_RUN", "") == "1"

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

LOGIN_BUCKET = {}
EMAIL_BUCKET = {}


def now_ms():
    return int(time.time() * 1000)


def iso_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def user_key(account_type, account_value):
    if account_type == "phone":
        return hashlib.sha256(account_value.encode("utf-8")).hexdigest()[:24]
    return hashlib.sha256(f"{account_type}:{account_value}".encode("utf-8")).hexdigest()[:24]


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
              email TEXT NOT NULL DEFAULT '',
              account_type TEXT NOT NULL DEFAULT 'phone',
              account_value TEXT NOT NULL DEFAULT '',
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

            CREATE TABLE IF NOT EXISTS email_codes (
              id TEXT PRIMARY KEY,
              email TEXT NOT NULL,
              code_hash TEXT NOT NULL,
              expires_at INTEGER NOT NULL,
              attempts INTEGER NOT NULL DEFAULT 0,
              consumed_at INTEGER,
              created_at INTEGER NOT NULL
            );
            """
        )
        ensure_column(conn, "users", "email", "TEXT NOT NULL DEFAULT ''")
        ensure_column(conn, "users", "account_type", "TEXT NOT NULL DEFAULT 'phone'")
        ensure_column(conn, "users", "account_value", "TEXT NOT NULL DEFAULT ''")
        conn.execute(
            """
            UPDATE users
            SET account_type = 'phone', account_value = phone
            WHERE account_value = ''
            """
        )
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_account
            ON users(account_type, account_value)
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email, created_at)")
    migrate_legacy_json()


def ensure_column(conn, table, column, definition):
    columns = [row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


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
                (id, name, phone, email, account_type, account_value, state_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    user_id,
                    str(user.get("name") or "养基用户")[:16],
                    str(user.get("phone") or ""),
                    str(user.get("email") or ""),
                    "email" if user.get("email") else "phone",
                    str(user.get("email") or user.get("phone") or ""),
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
    marker.write_text(str(now_ms()), "utf-8")


def state_from_row(row):
    try:
        return json.loads(row["state_json"])
    except Exception:
        return DEFAULT_STATE


def public_user(row, token=None):
    phone = row["phone"]
    if str(phone).startswith("__email__"):
        phone = ""
    payload = {
        "id": row["id"],
        "name": row["name"],
        "phone": phone,
        "email": row["email"] if "email" in row.keys() else "",
        "accountType": row["account_type"] if "account_type" in row.keys() else "phone",
        "createdAt": row["created_at"],
    }
    if token:
        payload["token"] = token
    return payload


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


def clean_email(value):
    email = str(value or "").strip().lower()
    if len(email) > 120:
        return ""
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return ""
    return email


def code_hash(email, code):
    pepper = RESEND_API_KEY or os.environ.get("CODE_PEPPER", "jizhunxian-dev")
    return hashlib.sha256(f"{email}:{code}:{pepper}".encode("utf-8")).hexdigest()


def send_email_code(email, code):
    if RESEND_DRY_RUN:
        return {"id": "dry-run", "dryRun": True}
    if not RESEND_API_KEY:
        raise RuntimeError("Resend API Key 未配置")

    payload = json.dumps({
        "from": RESEND_FROM,
        "to": [email],
        "subject": "基准线登录验证码",
        "html": f"""
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;line-height:1.6">
            <h2>基准线登录验证码</h2>
            <p>你的验证码是：</p>
            <p style="font-size:30px;font-weight:800;letter-spacing:6px;margin:20px 0">{code}</p>
            <p>验证码 10 分钟内有效。若不是你本人操作，可以忽略这封邮件。</p>
          </div>
        """,
        "text": f"你的基准线登录验证码是 {code}，10 分钟内有效。",
    }, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        RESEND_API_URL,
        data=payload,
        headers={
            "Authorization": f"Bearer {RESEND_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "ignore")
        raise RuntimeError(f"邮件发送失败：{detail[:120]}")


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
            })
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/login":
            return self.login()
        if path == "/api/email-code":
            return self.send_email_code_endpoint()
        if path == "/api/email-login":
            return self.email_login()
        if path == "/api/logout":
            return self.logout()
        if path == "/api/state":
            return self.save_state()
        return self.error_response("not_found", "接口不存在", 404)

    def login(self):
        if not self.allow_login_attempt():
            return self.error_response("rate_limited", "操作太频繁，请稍后再试", 429)

        body = self.read_json()
        name = re.sub(r"\s+", "", str(body.get("name") or "养基用户"))[:16] or "养基用户"
        phone = "".join(ch for ch in str(body.get("phone") or "") if ch.isdigit())
        if not re.fullmatch(r"1[3-9]\d{9}", phone):
            return self.error_response("invalid_phone", "请输入 11 位中国大陆手机号", 422)
        return self.create_login_session("phone", phone, name)

    def send_email_code_endpoint(self):
        body = self.read_json()
        email = clean_email(body.get("email"))
        if not email:
            return self.error_response("invalid_email", "请输入正确的邮箱地址", 422)
        if not self.allow_email_attempt(email):
            return self.error_response("rate_limited", "验证码发送太频繁，请稍后再试", 429)

        with db_connect() as conn:
            latest = conn.execute(
                """
                SELECT created_at
                FROM email_codes
                WHERE email = ? AND consumed_at IS NULL
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (email,),
            ).fetchone()
            if latest and now_ms() - latest["created_at"] < EMAIL_CODE_RESEND_MS:
                return self.error_response("rate_limited", "请 60 秒后再获取验证码", 429)

        code = f"{secrets.randbelow(1_000_000):06d}"
        try:
            send_result = send_email_code(email, code)
        except RuntimeError as exc:
            return self.error_response("email_send_failed", str(exc), 502)

        code_id = secrets.token_hex(12)
        with db_connect() as conn:
            conn.execute(
                """
                INSERT INTO email_codes
                (id, email, code_hash, expires_at, attempts, consumed_at, created_at)
                VALUES (?, ?, ?, ?, 0, NULL, ?)
                """,
                (code_id, email, code_hash(email, code), now_ms() + EMAIL_CODE_TTL_MS, now_ms()),
            )
            conn.execute("DELETE FROM email_codes WHERE expires_at < ?", (now_ms() - EMAIL_CODE_TTL_MS,))

        payload = {"ok": True, "email": email, "expiresIn": EMAIL_CODE_TTL_MS // 1000}
        if send_result.get("dryRun"):
            payload["debugCode"] = code
        return self.json_response(payload)

    def email_login(self):
        if not self.allow_login_attempt():
            return self.error_response("rate_limited", "操作太频繁，请稍后再试", 429)

        body = self.read_json()
        name = re.sub(r"\s+", "", str(body.get("name") or "养基用户"))[:16] or "养基用户"
        email = clean_email(body.get("email"))
        code = "".join(ch for ch in str(body.get("code") or "") if ch.isdigit())[:6]
        if not email:
            return self.error_response("invalid_email", "请输入正确的邮箱地址", 422)
        if not re.fullmatch(r"\d{6}", code):
            return self.error_response("invalid_code", "请输入 6 位邮箱验证码", 422)

        with db_connect() as conn:
            row = conn.execute(
                """
                SELECT *
                FROM email_codes
                WHERE email = ? AND consumed_at IS NULL
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (email,),
            ).fetchone()
            if not row or row["expires_at"] < now_ms():
                return self.error_response("code_expired", "验证码已过期，请重新获取", 422)
            if row["attempts"] >= EMAIL_CODE_MAX_ATTEMPTS:
                return self.error_response("too_many_attempts", "验证码错误次数过多，请重新获取", 422)
            if row["code_hash"] != code_hash(email, code):
                conn.execute("UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?", (row["id"],))
                return self.error_response("invalid_code", "验证码不正确", 422)
            conn.execute("UPDATE email_codes SET consumed_at = ? WHERE id = ?", (now_ms(), row["id"]))

        return self.create_login_session("email", email, name)

    def create_login_session(self, account_type, account_value, name):
        user_id = user_key(account_type, account_value)
        created = iso_now()
        token = secrets.token_urlsafe(32)
        expires_at = now_ms() + SESSION_TTL_MS
        phone = account_value if account_type == "phone" else f"__email__{user_id}"
        email = account_value if account_type == "email" else ""
        with db_connect() as conn:
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            is_new_user = row is None
            if is_new_user:
                conn.execute(
                    """
                    INSERT INTO users
                    (id, name, phone, email, account_type, account_value, state_json, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        user_id,
                        name,
                        phone,
                        email,
                        account_type,
                        account_value,
                        json.dumps(DEFAULT_STATE, ensure_ascii=False),
                        created,
                        now_ms(),
                    ),
                )
            else:
                conn.execute(
                    """
                    UPDATE users
                    SET name = ?, phone = ?, email = ?, account_type = ?, account_value = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (name, phone, email, account_type, account_value, now_ms(), user_id),
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

    def allow_email_attempt(self, email):
        key = f"{self.client_address[0]}:{email}"
        bucket = [ts for ts in EMAIL_BUCKET.get(key, []) if now_ms() - ts < 10 * 60_000]
        if len(bucket) >= 5:
            EMAIL_BUCKET[key] = bucket
            return False
        bucket.append(now_ms())
        EMAIL_BUCKET[key] = bucket
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
