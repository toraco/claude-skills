#!/usr/bin/env python3
"""下書きに秘密情報が含まれていないかを検査する。値そのものは決して出力しない。

使い方: python3 -I secret-scan.py <draft.md> [<secret-file> ...]

1. <secret-file>（JSON / .env / PHP などの設定ファイル）から、秘密らしい値を集める
   - JSON: キー名が secret / key / token / pass / mail / to / from / cc / bcc / user などを含む文字列値と、
     キー名に関係なく「@」を含む文字列値
   - それ以外: KEY=VALUE、'KEY' => 'VALUE'、define('KEY', 'VALUE') の形で、キー名が上と同じ条件の値
   - 6 文字未満の値と、true / false / null などは照合しない
2. 下書きの各行に、1 の値がそのまま含まれていないかを調べる
3. 下書きの各行に、秘密らしい形（メールアドレス、reCAPTCHA / AWS / GitHub / Slack の鍵、秘密鍵のヘッダー）がないかを調べる

出力: 一致した行番号と種類（ファイル名・キー名・パターン名）だけ。値は出さない。
終了コード: 0 = 一致なし、1 = 一致あり（下書きを直して再実行する）、2 = 使い方の誤り
"""

import json
import re
import sys
from pathlib import Path

SECRET_KEY = re.compile(
    r"secret|key|token|pass|pwd|mail|^to$|^from$|^cc$|^bcc$|user|account|auth|credential|sitekey",
    re.IGNORECASE,
)
IGNORED_VALUES = {"true", "false", "null", "none", "undefined", "example", "localhost"}
MIN_LEN = 6

PATTERNS = {
    "メールアドレス": re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    "reCAPTCHA の鍵らしい文字列": re.compile(r"\b6L[0-9A-Za-z_-]{38}\b"),
    "AWS のアクセスキー": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "GitHub のトークン": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b"),
    "Slack のトークン": re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}\b"),
    "秘密鍵": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
}
# 下書きに出てよいメールアドレス（GitHub の bot など、公開されている定型のもの）
ALLOWED_EMAILS = re.compile(r"(noreply|no-reply)@(github\.com|users\.noreply\.github\.com|anthropic\.com)$", re.IGNORECASE)

KV_PATTERNS = [
    re.compile(r"""^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']?([^"'\s#]+)"""),
    re.compile(r"""['"]([A-Za-z_][A-Za-z0-9_-]*)['"]\s*=>\s*['"]([^'"]+)['"]"""),
    re.compile(r"""define\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*,\s*['"]([^'"]+)['"]"""),
]


def usable(value: str) -> bool:
    v = value.strip()
    return len(v) >= MIN_LEN and v.lower() not in IGNORED_VALUES


def collect_json(node, key, out):
    if isinstance(node, dict):
        for k, v in node.items():
            collect_json(v, str(k), out)
    elif isinstance(node, list):
        for v in node:
            collect_json(v, key, out)
    elif isinstance(node, str):
        if usable(node) and (SECRET_KEY.search(key or "") or "@" in node):
            out.append((key or "(配列)", node.strip()))


def collect(path: Path):
    values = []
    text = path.read_text(encoding="utf-8", errors="replace")
    if path.suffix.lower() == ".json":
        try:
            collect_json(json.loads(text), "", values)
            return values
        except json.JSONDecodeError:
            pass
    for line in text.splitlines():
        for pat in KV_PATTERNS:
            for m in pat.finditer(line):
                k, v = m.group(1), m.group(2)
                if usable(v) and (SECRET_KEY.search(k) or "@" in v):
                    values.append((k, v.strip()))
    return values


def main(argv):
    if len(argv) < 2:
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    draft = Path(argv[1])
    lines = draft.read_text(encoding="utf-8", errors="replace").splitlines()
    hits = []
    scanned = 0
    for f in argv[2:]:
        p = Path(f)
        if not p.is_file():
            print(f"skip: {f}（ファイルがない）")
            continue
        vals = collect(p)
        scanned += len(vals)
        for key, value in vals:
            for i, line in enumerate(lines, 1):
                if value in line:
                    hits.append((i, f"{p.name} のキー「{key}」の値"))
    for i, line in enumerate(lines, 1):
        for name, pat in PATTERNS.items():
            for m in pat.finditer(line):
                if name == "メールアドレス" and ALLOWED_EMAILS.search(m.group(0)):
                    continue
                hits.append((i, name))
    print(f"照合した設定値: {scanned} 件（{len(argv) - 2} ファイル）")
    if not hits:
        print("一致なし")
        return 0
    for i, what in sorted(set(hits)):
        print(f"一致: {draft.name} の {i} 行目 — {what}")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
