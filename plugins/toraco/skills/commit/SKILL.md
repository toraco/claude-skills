---
name: commit
description: ステージ済み変更を確認し、プロジェクト慣例に沿ったコミットメッセージでコミットを作成する
---

# Create a commit with appropriate message: $ARGUMENTS

**使い方**: `/commit [message-hint]`

## Goal

Review staged changes, generate an appropriate commit message following the project's conventions, and create a commit.

## Steps (obey strictly)

### Step 1: Check current state

- Run `git status` to see staged and unstaged files.
- Run `git diff --cached` to review staged changes.
- If nothing is staged, inform the user and stop.

### Step 2: Analyze recent commit style

- Run `git log --oneline -10` to understand the project's commit message conventions.
- Identify patterns (emoji prefixes, language, format).

### Step 3: Generate commit message

- Summarize the nature of the staged changes.
- Draft a commit message following the project's conventions detected in Step 2.
- If `$ARGUMENTS` is provided, incorporate it as guidance for the message.
### Step 4: Commit

- Create the commit with the generated message without asking for user confirmation.
- Run `git status` after the commit to verify success.

Do NOT push. The user will handle push manually.
