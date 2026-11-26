#!/usr/bin/env bash
# 公開ページを 1 件ずつ取得し、ステータスと本文を保存する（読み取り専用）。
#
# 使い方: http-check.sh <base-url> <out-dir> < targets.tsv
#   targets.tsv: 1 行 1 件、「ラベル<TAB>パスまたは URL」。空行と # で始まる行は無視する
# 出力: 1 行 1 件の JSON（stdout）。本文は <out-dir>/pages/<n>.html、ヘッダーは <out-dir>/pages/<n>.headers
#   {"n":1,"label":"...","url":"...","first_status":301,"final_status":200,
#    "final_url":"...","redirects":1,"seconds":0.42,"bytes":12345,"content_type":"text/html","body":"..."}
#
# - 認証情報（Basic 認証、Cookie）は送らない。Basic 認証のある環境は対象にしない
# - サーバーに負荷をかけないよう、1 件ずつ、間に待ち時間（既定 1 秒、MONTHLY_CHECK_DELAY で変更）を入れる
set -euo pipefail

base="${1:?base-url が必要です}"
out="${2:?out-dir が必要です}"
delay="${MONTHLY_CHECK_DELAY:-1}"
ua="${MONTHLY_CHECK_UA:-monthly-check/1.0 (Claude Code; read-only)}"
base="${base%/}"

mkdir -p "$out/pages"
n=0
while IFS=$'\t' read -r label target || [ -n "${label:-}" ]; do
  [ -z "${label:-}" ] && continue
  case "$label" in \#*) continue ;; esac
  [ -z "${target:-}" ] && { target="$label"; }
  n=$((n + 1))
  case "$target" in
    http://* | https://*) url="$target" ;;
    /*) url="$base$target" ;;
    *) url="$base/$target" ;;
  esac
  body="$out/pages/$n.html"
  headers="$out/pages/$n.headers"
  meta=$(curl -sS -L --max-redirs 5 --max-time 30 -A "$ua" \
    -o "$body" -D "$headers" \
    -w '%{http_code}\t%{url_effective}\t%{num_redirects}\t%{time_total}\t%{size_download}\t%{content_type}' \
    "$url" 2>/dev/null) || meta=$'000\t\t0\t0\t0\t'
  IFS=$'\t' read -r final_status final_url redirects seconds bytes ctype <<<"$meta"
  first_status=$(grep -m1 -E '^HTTP/' "$headers" 2>/dev/null | awk '{print $2}')
  [ -z "$first_status" ] && first_status="$final_status"
  jq -cn --argjson n "$n" --arg label "$label" --arg url "$url" \
    --arg first "$first_status" --arg final "$final_status" --arg final_url "$final_url" \
    --arg redirects "$redirects" --arg seconds "$seconds" --arg bytes "$bytes" \
    --arg ctype "$ctype" --arg body "$body" \
    '{n:$n,label:$label,url:$url,first_status:($first|tonumber? // 0),final_status:($final|tonumber? // 0),
      final_url:$final_url,redirects:($redirects|tonumber? // 0),seconds:($seconds|tonumber? // 0),
      bytes:($bytes|tonumber? // 0),content_type:$ctype,body:$body}'
  sleep "$delay"
done
