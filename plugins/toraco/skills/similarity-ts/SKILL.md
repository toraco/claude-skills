---
name: similarity-ts
description: TypeScriptコードの重複を検出しリファクタリング計画を作成する
---

# Detect TypeScript code duplication and plan refactoring

## Mode: `ultrathink` (Extended reasoning with maximum token usage)

## Goal

Analyze the codebase for duplicated TypeScript code and create a refactoring plan.

## Steps (obey strictly)

### Step 1: Install

- Check whether the tool is already installed: `which similarity-ts`.
- If not installed, run `cargo install similarity-ts`.

### Step 2: Analyze

- Run `similarity-ts .` in the current directory to detect duplicate code patterns.

### Step 3: Plan refactoring

Based on the analysis results, create a detailed refactoring plan:

- Prioritized list of refactoring opportunities
- Extract common functionality into reusable components
- Suggest appropriate design patterns for consolidation
- Estimated complexity and impact for each refactoring task

### Step 4: Report

- Complete duplication analysis report
- Step-by-step refactoring plan with code examples
