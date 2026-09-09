---
name: bugfix
description: バグの再現・原因特定・修正を行う
---

# Fix bug from user provided bug description: $ARGUMENTS

**使い方**: `/bugfix [bug-description]`

## Goal

Reproduce the bug, identify the root cause, and fix it.

## Steps (obey strictly)

### Step 1: Understand and reproduce

- Analyze the bug description: `$ARGUMENTS`
- Identify the relevant code paths and try to reproduce the issue.

### Step 2: Investigate root cause

- Use the `context7` MCP tools and native WebSearch to research the error.
- Run these searches via multiple subagents in parallel.

### Step 3: Fix and verify

- Apply the fix to the root cause.
- Run tests to verify the fix and check for regressions.
- If new errors appear, repeat from Step 1.

### Step 4: Report

- Explain the root cause and the solution applied.
