---
name: check
description: テスト・リント・ビルドチェックを実行し、エラーがあれば修正する
---

# Run test, lint and dryrun-build

## Goal

Run the project's test, lint, and build checks. Fix any errors found.

## Steps (obey strictly)

### Step 1: Run tests

- Detect the test runner from the repository (e.g., `package.json` scripts).
- Run tests (e.g., `yarn test`).
- If any test fails, fix it before proceeding.

### Step 2: Run linter

- Run the linter (e.g., `yarn lint`).
- If any lint error is found, fix it before proceeding.

### Step 3: Run build dry-run

- Run a dry-run build (e.g., `yarn <workspace> build:dryrun`).
- If any build error is found, fix it.

### Step 4: Report

- Print a summary of results (all passed / issues fixed).

Note: Detect the correct commands from the repository configuration.
