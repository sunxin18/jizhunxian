#!/usr/bin/env python3
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
import hashlib
import json
import secrets
import time


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "db.json"
HOST = "0.0.0.0"
PORT = 8080

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


def now_ms():
    return int(time.time() * 1000)


def read_db():
    DATA_DIR.mkdir(exist_ok=True)
    if not DB_PATH.exists():
        return {"users": {}, "sessions": {}, "purchases": []}
    try:
        return json.loads(DB_PATH.read_text("utf-8"))
    except Exception:
        return {"users": {}, "sessions": {}, "purchases": []}


def write_db(db):
    DATA_DIR.mkdir(exist_ok=True)
    tmp_path = DB_PATH.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(db, ensure_ascii=False, indent=2), "utf-8")
    tmp_path.replace(DB_PATH)


def public_user(user, token=None):
    payload = {
        "id": user["id"],
        "name": user["name"],
        "phone": user.get("phone", ""),
        "credits": user.get("credits", 30),
        "createdAt": user.get("createdAt"),
    }
    if token:
        payload["token"] = token
    return payload


def user_key(name, phone):
    raw = (phone or name or "guest").strip().lower()
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


class AppHandler(SimpleHTTPRequestHandler):
    server_version = "JizhunxianServer/1.0"

    def translate_path(self, path):
        path = urlparse(path).path
        if path == "/":
            path = "/index.html"
        return str(ROOT / path.lstrip("/"))

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        super().end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            return self.json_response({"ok": True, "time": now_ms()})
        if path == "/api/me":
            user, _token = self.require_user()
            if not user:
                return self.json_response({"error": "unauthorized"}, 401)
            return self.json_response({"user": public_user(user), "state": user.get("state", DEFAULT_STATE)})
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
        return self.json_response({"error": "not_found"}, 404)

    def login(self):
        body = self.read_json()
        name = str(body.get("name") or "养基用户").strip()[:16]
        phone = "".join(ch for ch in str(body.get("phone") or "") if ch.isdigit())[:11]
        db = read_db()
        key = user_key(name, phone)
        user = db["users"].get(key)
        is_new_user = user is None
        if not user:
            user = {
                "id": key,
                "name": name,
                "phone": phone,
                "credits": 30,
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "state": DEFAULT_STATE,
            }
        else:
            user["name"] = name
            user["phone"] = phone
        token = secrets.token_urlsafe(32)
        db["users"][key] = user
        db["sessions"][token] = {"userId": key, "createdAt": now_ms()}
        write_db(db)
        return self.json_response({
            "user": public_user(user, token),
            "state": user.get("state", DEFAULT_STATE),
            "isNewUser": is_new_user,
        })

    def logout(self):
        token = self.auth_token()
        if token:
            db = read_db()
            db["sessions"].pop(token, None)
            write_db(db)
        return self.json_response({"ok": True})

    def save_state(self):
        user, _token = self.require_user()
        if not user:
            return self.json_response({"error": "unauthorized"}, 401)
        body = self.read_json()
        state = body.get("state") or {}
        clean_state = {
            "funds": [str(code)[:6] for code in state.get("funds", []) if str(code).isdigit()],
            "holdings": state.get("holdings", {}),
            "alerts": state.get("alerts", []),
            "sort": state.get("sort", "custom"),
        }
        db = read_db()
        db["users"][user["id"]]["state"] = clean_state
        write_db(db)
        return self.json_response({"ok": True, "state": clean_state})

    def purchase(self):
        user, _token = self.require_user()
        if not user:
            return self.json_response({"error": "unauthorized"}, 401)
        body = self.read_json()
        product = str(body.get("productName") or "Pro 服务")[:40]
        db = read_db()
        order = {
            "id": secrets.token_hex(8),
            "userId": user["id"],
            "product": product,
            "status": "demo_pending",
            "createdAt": now_ms(),
        }
        db["purchases"].append(order)
        write_db(db)
        return self.json_response({"ok": True, "order": order})

    def require_user(self):
        token = self.auth_token()
        if not token:
            return None, None
        db = read_db()
        session = db["sessions"].get(token)
        if not session:
            return None, token
        return db["users"].get(session["userId"]), token

    def auth_token(self):
        header = self.headers.get("Authorization", "")
        if header.startswith("Bearer "):
            return header[7:].strip()
        return None

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def json_response(self, payload, status=200):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    print(f"Jizhunxian server listening on http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), AppHandler).serve_forever()
