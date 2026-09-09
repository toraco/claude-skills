---
name: create-pr
description: ブランチをpushしGitHub PRを適切なタイトル・説明で作成する
---

# Create a pull request: $ARGUMENTS

**使い方**: `/create-pr [additional-context]`

## Goal

Push the current branch and create a GitHub pull request with an appropriate title and description.

## Steps (obey strictly)

### Step 1: Analyze changes

- Identify the main branch (main or master) automatically.
- Run `git log <main>..HEAD --oneline` to see all commits on this branch.
- Run `git diff <main>...HEAD --stat` to see changed files summary.

### Step 2: Push branch

- Push the current branch to remote with `-u` flag: `git push -u origin HEAD`
- If push fails, inform the user and stop.

### Step 3: Check for existing PR

- Run `gh pr view` to check if a PR already exists for this branch.
- If a PR already exists, display its URL and ask if the user wants to update the title/body.
- If no PR exists, proceed to Step 4.

### Step 4: Create PR

- Generate a PR title (short, under 70 characters) from the branch commits.
- Generate a PR body with:
  - `## Summary` — bullet points summarizing the changes
  - `## Test plan` — checklist of testing steps
- If `$ARGUMENTS` is provided, use it as additional context for the PR description.
- Create the PR: `gh pr create --title "..." --body "..."`
- Display the created PR URL.
