#!/usr/bin/env python3
"""Export a PPTD project as page images through Kimi's public editor for visual QA.

Reuses the same isolated local browser flow as export_pptx.py, but
chooses 图片 in the export dialog, captures the images ZIP, unzips it, and stitches
all pages into a single overview image that a multimodal model can review.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from runtime import ExportError, require_pillow
from browser_export import ExportBrowser
from export_pptx import (
    HOST_TEMPLATE, build_payload, find_manifest, log, serve, temporary_directory,
)

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
OVERVIEW_COLUMNS = 3
OVERVIEW_THUMB_WIDTH = 640
OVERVIEW_LABEL_HEIGHT = 32
OVERVIEW_GAP = 12


def is_image_zip(path: Path) -> bool:
    if not path.is_file() or path.name.endswith(".crdownload"):
        return False
    try:
        with zipfile.ZipFile(path) as archive:
            return any(
                Path(name).suffix.lower() in IMAGE_SUFFIXES
                for name in archive.namelist()
            )
    except (OSError, zipfile.BadZipFile):
        return False


def page_sort_key(path: Path) -> Tuple[int, str]:
    match = re.match(r"(\d+)", path.stem)
    return (int(match.group(1)) if match else sys.maxsize, path.name)


def unzip_images(archive_path: Path, pages_dir: Path) -> List[Path]:
    pages_dir.mkdir(parents=True, exist_ok=True)
    images: List[Path] = []
    with zipfile.ZipFile(archive_path) as archive:
        for info in archive.infolist():
            if info.is_dir() or Path(info.filename).suffix.lower() not in IMAGE_SUFFIXES:
                continue
            name = Path(info.filename).name
            if not name:
                continue
            target = pages_dir / name
            with archive.open(info) as source, target.open("wb") as out:
                shutil.copyfileobj(source, out)
            images.append(target)
    images.sort(key=page_sort_key)
    if not images:
        raise ExportError(f"no page images found in: {archive_path}")
    return images


def label_font(image_font: Any) -> Any:
    try:
        return image_font.load_default(size=18)
    except TypeError:  # older Pillow without the size argument
        return image_font.load_default()


def stitch_overview(
    images: Sequence[Path],
    output: Path,
    image_cls: Any,
    draw_cls: Any,
    image_font: Any,
) -> Path:
    thumbs: List[Tuple[str, Any]] = []
    for index, path in enumerate(images, start=1):
        with image_cls.open(path) as opened:
            frame = opened.convert("RGB")
            ratio = OVERVIEW_THUMB_WIDTH / frame.width
            thumb = frame.resize(
                (OVERVIEW_THUMB_WIDTH, max(1, round(frame.height * ratio)))
            )
        thumbs.append((f"P{index}", thumb))

    columns = OVERVIEW_COLUMNS
    rows = math.ceil(len(thumbs) / columns)
    cell_height = OVERVIEW_LABEL_HEIGHT + max(thumb.height for _, thumb in thumbs)
    width = columns * OVERVIEW_THUMB_WIDTH + (columns + 1) * OVERVIEW_GAP
    height = rows * cell_height + (rows + 1) * OVERVIEW_GAP

    overview = image_cls.new("RGB", (width, height), "#e5e7eb")
    draw = draw_cls.Draw(overview)
    font = label_font(image_font)
    for position, (label, thumb) in enumerate(thumbs):
        column = position % columns
        row = position // columns
        x = OVERVIEW_GAP + column * (OVERVIEW_THUMB_WIDTH + OVERVIEW_GAP)
        y = OVERVIEW_GAP + row * (cell_height + OVERVIEW_GAP)
        draw.rectangle(
            (x, y, x + OVERVIEW_THUMB_WIDTH, y + OVERVIEW_LABEL_HEIGHT - 4),
            fill="#111827",
        )
        draw.text((x + 8, y + 5), label, fill="#ffffff", font=font)
        overview.paste(thumb, (x, y + OVERVIEW_LABEL_HEIGHT))

    overview.save(output, "JPEG", quality=85)
    return output


def export_images(
    source: Path,
    output: Path,
    keep_download: bool = False,
    force: bool = False,
) -> Dict[str, Any]:
    image_cls, draw_cls, image_font = require_pillow()
    manifest = find_manifest(source)
    payload = build_payload(manifest)
    output = output.expanduser().resolve()
    if manifest.is_relative_to(output):
        raise ExportError("INVALID_OUTPUT：图片输出目录不能包含源 PPTD 项目。")
    if output.exists() and any(output.iterdir()) and not force:
        raise ExportError(
            f"output directory already exists (pass --force to replace it): {output}"
        )
    if output.exists() and any(output.iterdir()) and not (output / ".open-kimi-qa.json").is_file():
        raise ExportError("INVALID_OUTPUT：只允许替换本脚本先前生成的图片校验目录。")

    log(f"manifest: {manifest}")
    with temporary_directory(prefix="open-kimi-ppt-images-") as temp_name:
        temp_dir = Path(temp_name)
        download_dir = temp_dir / "downloads"
        download_dir.mkdir()
        shutil.copy2(HOST_TEMPLATE, temp_dir / HOST_TEMPLATE.name)
        (temp_dir / "payload.json").write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )
        server, thread, url = serve(temp_dir)
        browser = ExportBrowser(temp_dir, download_dir, url)
        try:
            browser.start()
            downloaded = browser.download(image_format=True)
            if not is_image_zip(downloaded):
                raise ExportError("EXPORT_FAILED：编辑器没有生成有效的图片归档。")
        finally:
            browser.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        prepared = temp_dir / "qa"
        images = unzip_images(downloaded, prepared / "pages")
        if len(images) != len(payload["pages"]):
            raise ExportError("EXPORT_FAILED：导出的图片数量与 PPTD 页数不一致。")
        if keep_download:
            shutil.copy2(downloaded, prepared / "browser-raw.zip")
        overview = stitch_overview(
            images, prepared / "overview.jpg", image_cls, draw_cls, image_font
        )
        (prepared / ".open-kimi-qa.json").write_text(json.dumps({"pages": len(images)}))
        if output.exists():
            shutil.rmtree(output)
        shutil.copytree(prepared, output)
        overview = output / "overview.jpg"

    page_paths = [entry["path"] for entry in payload["pages"]]
    mapping = [
        {
            "index": index,
            "image": f"pages/{path.name}",
            "page": page_paths[index - 1] if index - 1 < len(page_paths) else None,
        }
        for index, path in enumerate(images, start=1)
    ]
    return {
        "pages": len(images),
        "overview": str(overview),
        "output": str(output),
        "images": mapping,
    }


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Export a PPTD project as page images via Kimi's public editor, unzip "
            "them, and stitch an overview image for visual QA."
        )
    )
    parser.add_argument("input", type=Path, help=".pptd manifest or project directory")
    parser.add_argument(
        "--output",
        "-o",
        type=Path,
        help="output directory (default: <project>/.qa-images)",
    )
    parser.add_argument(
        "--keep-browser-raw",
        action="store_true",
        help="also keep the downloaded images ZIP beside the overview",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="replace an existing output directory",
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    try:
        manifest = find_manifest(args.input)
        output = args.output or manifest.parent / ".qa-images"
        summary = export_images(args.input, output, args.keep_browser_raw, args.force)
    except (ExportError, OSError, subprocess.SubprocessError) as exc:
        print(f"open-kimi-ppt image export failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
