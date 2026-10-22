#!/bin/bash
# GitHub の PR レビューを submit する操作を止め、pending review（下書き）の作成までに留める。
# 下書きのコメントは GitHub 上で本人が確認してから submit する。
# 許可: pending review の作成・削除、下書きへのコメント追加、スレッドへの返信、resolve / unresolve
# 拒否: GitHub MCP の submit 系、gh pr review、gh api / curl でのレビュー submit・単独の行コメント作成
input=$(cat)

reason=$(jq -r '
  .tool_name as $tool
  | .tool_input as $in
  | def has_event: (($in.event // "") | tostring | length) > 0;
  if $tool == "Bash" then
    ($in.command // "") as $cmd
    | if ($cmd | test("(^|[^A-Za-z0-9_-])gh\\s+pr\\s+review(\\s|$)")) then
        "gh pr review"
      elif ($cmd | test("pulls/[^/\\s]+/reviews/[^/\\s]+/events")) then
        "REST の pending review submit (reviews/{id}/events)"
      elif ($cmd | test("pulls/[^/\\s]+/reviews(?![/\\w])")) and ($cmd | test("\\bevent\\b")) then
        "REST の event 付きレビュー作成"
      elif ($cmd | test("submitPullRequestReview")) then
        "GraphQL の submitPullRequestReview"
      elif ($cmd | test("addPullRequestReview(?!\\w)")) and ($cmd | test("\\bevent\\s*:")) then
        "GraphQL の event 付き addPullRequestReview"
      elif ($cmd | test("pulls/[^/\\s]+/comments(?![/\\w])"))
        and ($cmd | test("in_reply_to") | not)
        and ($cmd | test("(-X|--method)\\s*GET") | not)
        and ($cmd | test("\\s(-f|-F|-d|--field|--raw-field|--input|--data[\\w-]*)(\\s|=)|(-X|--method)\\s*POST")) then
        "REST の単独レビューコメント作成 (pulls/{n}/comments)"
      else empty end
  elif ($tool | endswith("__pull_request_review_write")) then
    if $in.method == "submit_pending" then "pull_request_review_write (submit_pending)"
    elif $in.method == "create" and has_event then "pull_request_review_write (create + event)"
    else empty end
  elif ($tool | test("__(create_and_submit_pull_request_review|submit_pending_pull_request_review)$")) then
    $tool
  elif ($tool | endswith("__create_pull_request_review")) and has_event then
    "\($tool) (event 付き)"
  elif ($tool | test("__(add|create)_pull_request_review_comment$"))
    and ((($in.in_reply_to // $in.inReplyTo // "") | tostring | length) == 0) then
    $tool
  else empty end
  | "PR レビューの submit は禁止されています（検出: \(.)）。レビューは pending review（下書き）の作成までに留めてください。GitHub MCP なら pull_request_review_write を method: \"create\"・event なしで呼んで pending review を作り、add_comment_to_pending_review でコメントを追加します。submit はユーザーが GitHub 上で内容を確認してから行うので、下書きを作ったら PR の URL を伝えて submit を依頼してください。"
' <<<"$input" 2>/dev/null)

[ -z "$reason" ] && exit 0

jq -n --arg reason "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
