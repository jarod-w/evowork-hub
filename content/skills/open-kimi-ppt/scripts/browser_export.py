"""Fixed PPT export workflow; isolated Chrome profile, bundled CDP transport.

This is not a general browser tool. It accepts only the local export host and
selects the public editor's export controls. No user browser profile is opened.
"""
import json
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
import time
import urllib.parse
import urllib.request

from runtime import ExportError, chrome_binary
import websocket

TARGET_FILTER = [{"type": name, "exclude": True} for name in ("tab", "browser", "browser_ui")] + [{}]
EDITOR_RESOURCES = frozenset(json.loads(Path(__file__).with_name("editor-resources.json").read_text()))


def allowed_request(url, method, local_origin):
    if method != "GET":
        return False
    parsed = urllib.parse.urlsplit(url)
    if parsed.username or parsed.password:
        return False
    origin = f"{parsed.scheme}://{parsed.netloc}"
    if origin == local_origin:
        return parsed.path in ("/export_host.html", "/payload.json", "/favicon.ico") and not parsed.query
    if origin == "https://www.kimi.com":
        query = urllib.parse.parse_qs(parsed.query)
        expected = {"sdkMode": ["ppt-editor"], "pptPlatform": ["open-kimi-ppt-local-export"],
                    "sdkSaveMode": ["external"], "sdkImageMode": ["external"]}
        try:
            functional = json.loads(query.pop("functional", [""])[0])
        except (ValueError, IndexError):
            return False
        return parsed.path == "/neo-ppt/" and query == expected and functional == {
            "fullscreen": False, "present": False, "export": True, "close": False,
            "annotation": False, "feedback": False, "share": False, "versionHistory": False}
    if origin in ("https://statics.moonshot.cn", "https://statics.kimi.ai"):
        return url in EDITOR_RESOURCES
    return False


class ExportBrowser:
    def __init__(self, directory, downloads, url):
        self.directory = Path(directory)
        self.downloads = Path(downloads)
        self.url = url
        self.local_origin = url.rsplit("/", 1)[0]
        self.process = None
        self.socket = None
        self.counter = 0
        self.responses = {}
        self.sessions = {}
        self.main_target = None
        self.completed = None
        self.download_guid = None
        self.blocked = set()
        self.last_status = None
        self.user_agent = "EvoWork-PPT-QA"

    def _event(self, message):
        method = message.get("method")
        params = message.get("params", {})
        session = message.get("sessionId")
        if method == "Target.attachedToTarget":
            info = params["targetInfo"]
            sid = params["sessionId"]
            kind = info["type"]
            if kind not in ("page", "iframe") or (kind == "page" and info["targetId"] != self.main_target):
                self.call("Target.closeTarget", {"targetId": info["targetId"]})
                return
            self.sessions[sid] = info
            self.call("Network.enable", session=sid)
            self.call("Network.setBlockedURLs", {"urls": ["ws://*", "wss://*"]}, sid)
            self.call("Fetch.enable", {"patterns": [{"urlPattern": "*", "requestStage": "Request"}]}, sid)
            self.call("Runtime.enable", session=sid)
            self.call("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True, "filter": TARGET_FILTER}, sid)
            self.call("Runtime.runIfWaitingForDebugger", session=sid)
        elif method == "Target.detachedFromTarget":
            self.sessions.pop(params.get("sessionId"), None)
        elif method == "Fetch.requestPaused":
            request = params["request"]
            if allowed_request(request["url"], request["method"], self.local_origin):
                # Fixed URLs and fixed headers: page scripts cannot attach document
                # data through query strings, paths, cookies or custom headers.
                headers = [{"name": "Accept", "value": "*/*"},
                           {"name": "Accept-Language", "value": "zh-CN,zh;q=0.9"},
                           {"name": "User-Agent", "value": self.user_agent}]
                origin = next((v for k, v in request.get("headers", {}).items() if k.lower() == "origin"), None)
                if origin in (self.local_origin, "https://www.kimi.com", "https://statics.moonshot.cn", "https://statics.kimi.ai"):
                    headers.append({"name": "Origin", "value": origin})
                self.call("Fetch.continueRequest", {"requestId": params["requestId"], "headers": headers}, session)
            else:
                host = urllib.parse.urlsplit(request["url"]).hostname or "unknown"
                if host not in self.blocked:
                    print(f"[open-kimi-ppt] blocked resource host: {host}", file=sys.stderr, flush=True)
                self.blocked.add(host)
                self.call("Fetch.failRequest", {"requestId": params["requestId"], "errorReason": "BlockedByClient"}, session)
        elif method == "Browser.downloadWillBegin":
            if self.download_guid is not None:
                raise ExportError("EXPORT_FAILED：编辑器发起了多个下载，已停止。")
            self.download_guid = params["guid"]
        elif method == "Browser.downloadProgress":
            if params.get("guid") == self.download_guid:
                if params["state"] == "completed":
                    self.completed = self.downloads / params["guid"]
                elif params["state"] == "canceled":
                    raise ExportError("EXPORT_FAILED：浏览器取消了导出下载。")

    def pump(self):
        if not self.socket.frame_buffer.recv_buffer and not select.select([self.socket.sock], [], [], 0.25)[0]:
            return
        try:
            message = json.loads(self.socket.recv())
        except websocket.WebSocketTimeoutException:
            return
        except (websocket.WebSocketException, ValueError) as error:
            raise ExportError("BROWSER_CONNECTION_LOST：专用浏览器连接中断，请重试。") from error
        if "id" in message:
            self.responses[message["id"]] = message
        else:
            self._event(message)

    def call(self, method, params=None, session=None, timeout=30):
        self.counter += 1
        ident = self.counter
        self.socket.send(json.dumps({"id": ident, "method": method, "params": params or {},
                                     **({"sessionId": session} if session else {})}))
        deadline = time.monotonic() + timeout
        while ident not in self.responses:
            if time.monotonic() > deadline:
                raise ExportError(f"EXPORT_TIMEOUT：{method}")
            self.pump()
        result = self.responses.pop(ident)
        if "error" in result:
            raise ExportError(f"EXPORT_FAILED：{method} ({result['error'].get('code')})")
        return result.get("result", {})

    def start(self):
        profile = self.directory / "chrome-profile"
        self.process = subprocess.Popen([
            chrome_binary(), "--headless=new", "--remote-debugging-port=0",
            f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
            "--disable-background-networking", "--disable-extensions", "--disable-sync",
            "--disable-component-extensions-with-background-pages",
            "--disable-component-update", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=os.name != "nt")
        deadline = time.monotonic() + 15
        while not (profile / "DevToolsActivePort").is_file():
            if self.process.poll() is not None or time.monotonic() > deadline:
                raise ExportError("BROWSER_UNAVAILABLE：浏览器未能启动专用导出会话。")
            time.sleep(0.1)
        port = int((profile / "DevToolsActivePort").read_text().splitlines()[0])
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:{port}/json/version", timeout=5) as response:
            endpoint = json.load(response)["webSocketDebuggerUrl"]
        self.socket = websocket.create_connection(endpoint, timeout=0.5, suppress_origin=True,
                                                   http_no_proxy=["127.0.0.1", "localhost"])
        self.user_agent = self.call("Browser.getVersion")["userAgent"]
        targets = self.call("Target.getTargets")["targetInfos"]
        self.main_target = next(t["targetId"] for t in targets if t["type"] == "page")
        self.call("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True, "filter": TARGET_FILTER})
        self.call("Browser.setDownloadBehavior", {"behavior": "allowAndName", "downloadPath": str(self.downloads), "eventsEnabled": True})
        main = self.session("page")
        self.call("Emulation.setDeviceMetricsOverride", {"width": 1280, "height": 720, "deviceScaleFactor": 1, "mobile": False}, main)
        self.call("Page.navigate", {"url": self.url}, main)

    def session(self, kind):
        for sid, info in self.sessions.items():
            if info["type"] == kind:
                return sid
        raise ExportError(f"EXPORT_FAILED：尚未连接编辑器 ({kind})")

    def evaluate(self, expression, kind="iframe"):
        result = self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True,
                                                "awaitPromise": True, "userGesture": True}, self.session(kind))
        if result.get("exceptionDetails"):
            raise ExportError("EXPORT_FAILED：编辑器控件执行失败。")
        return result.get("result", {}).get("value")

    def wait(self, expression, kind="iframe", timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if kind == "page":
                status = self.evaluate("document.documentElement.dataset.deckStatus", kind)
                if status != self.last_status:
                    print(f"[open-kimi-ppt] editor status: {status}", file=sys.stderr, flush=True)
                    self.last_status = status
                if status == "error":
                    raise ExportError("EDITOR_UNAVAILABLE：在线编辑器加载失败，请检查网络或联系管理员。")
            if any(i["type"] == kind for i in self.sessions.values()):
                value = self.evaluate(expression, kind)
                if value:
                    return value
            self.pump()
            time.sleep(0.1)
        blocked = ", ".join(sorted(self.blocked))
        raise ExportError(f"EDITOR_TIMEOUT：在线编辑器未就绪；被拦截的资源域名：{blocked or '无'}。")

    def click_button(self, name):
        expression = """(() => { const button = [...document.querySelectorAll('button,[role=button]')]
          .find(b => b.textContent.trim() === NAME && b.getBoundingClientRect().width && !b.disabled);
          if (!button) return false; const r = button.getBoundingClientRect();
          return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()""".replace("NAME", json.dumps(name))
        self.click_point(self.wait(expression))

    def click_point(self, point):
        for kind in ("mousePressed", "mouseReleased"):
            self.call("Input.dispatchMouseEvent", {"type": kind, **point, "button": "left", "clickCount": 1}, self.session("iframe"))

    def download(self, image_format=False, embed_fonts=True):
        if not image_format:
            raise ExportError("CLOUD_PPTX_DISABLED：请使用 export_pptx.py 的本地转换器。")
        self.wait('document.documentElement.dataset.deckStatus === "ready"', "page", 120)
        self.click_button("导出")
        self.wait("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '下载')")
        if image_format:
            self.wait("""(() => { const item = [...document.querySelectorAll('.radio-group-item')]
              .find(e => e.textContent.trim() === '图片'); if (!item) return false;
              item.click(); return true; })()""")
            self.wait("document.querySelector('.radio-group-item.active')?.textContent.trim() === '图片'")
        else:
            self.evaluate("""(() => { const s = document.querySelector('[role=switch]');
              if (s && !s.disabled && s.getAttribute('aria-disabled') !== 'true' &&
                  (s.getAttribute('aria-checked') === 'true') !== EMBED) s.click(); })()""".replace("EMBED", json.dumps(embed_fonts)))
        self.click_button("下载")
        deadline = time.monotonic() + 240
        while not self.completed:
            if time.monotonic() > deadline:
                raise ExportError("EXPORT_TIMEOUT：等待文件下载超时。")
            self.pump()
        return self.completed

    def close(self):
        # Stop the owned process tree before disconnecting the debugger.
        if self.process and self.process.poll() is None:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            else:
                os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=10)
        if self.socket:
            self.socket.close()
