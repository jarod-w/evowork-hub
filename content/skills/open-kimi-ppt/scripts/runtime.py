"""Resolve packaged dependencies and EvoWork's managed office interpreter."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent / "vendor"))


class ExportError(RuntimeError):
    pass


def office_candidates():
    override = os.environ.get("EVOWORK_OFFICE_PYTHON")
    if override:
        return [Path(override)]
    root = Path.home() / ".evowork/runtime/office"
    return [root / p for p in ("bin/python3", "bin/python", "python.exe", "Scripts/python.exe")]


def require_pillow():
    require_office(("PIL",))
    from PIL import Image, ImageDraw, ImageFont
    return Image, ImageDraw, ImageFont


def require_office(modules):
    missing = [name for name in modules if importlib.util.find_spec(name) is None]
    if not missing:
        return
    if os.environ.get("EVOWORK_PPT_REEXEC") != "1":
        interpreter = next((p for p in office_candidates() if p.is_file()), None)
        if interpreter:
            os.execve(str(interpreter), [str(interpreter), "-s", *sys.argv],
                      {**os.environ, "EVOWORK_PPT_REEXEC": "1"})
    raise ExportError("OFFICE_RUNTIME_REQUIRED：请在 EvoWork 设置中安装或修复办公组件，再重新执行。")


def chrome_binary():
    candidates = []
    if sys.platform == "darwin":
        for base in (Path("/Applications"), Path.home() / "Applications"):
            candidates.extend(base / p for p in (
                "Google Chrome.app/Contents/MacOS/Google Chrome",
                "Chromium.app/Contents/MacOS/Chromium",
                "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"))
    elif sys.platform == "win32":
        for key in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
            base = os.environ.get(key)
            if base:
                candidates.extend(Path(base) / p for p in (
                    "Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"))
    else:
        candidates.extend(Path(p) for name in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge")
                          if (p := shutil.which(name)))
    executable = next((p for p in candidates if p.is_file()), None)
    if not executable:
        raise ExportError("BROWSER_UNAVAILABLE：请安装 Chrome、Chromium 或 Edge 后重试，无需安装命令行浏览器工具。")
    return str(executable)


def diagnostic():
    require_office(("pptx", "PIL"))
    try:
        browser, warning = chrome_binary(), None
    except ExportError as error:
        browser, warning = None, str(error)
    return {"ok": True, "pptxReady": True, "imageQaReady": browser is not None,
            "browser": browser, "warning": warning, "python": sys.version.split()[0],
            "bundled": {"PyYAML": "6.0.2", "websocket-client": "1.7.0"},
            "officeInstalled": any(p.is_file() for p in office_candidates()),
            "networkRequired": ["www.kimi.com", "statics.moonshot.cn", "statics.kimi.ai"]}


if __name__ == "__main__":
    try:
        print(json.dumps(diagnostic(), ensure_ascii=False))
    except ExportError as error:
        print(json.dumps({"ok": False, "message": str(error)}, ensure_ascii=False))
        sys.exit(3)
