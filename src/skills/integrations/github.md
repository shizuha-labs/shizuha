# GitHub Integration

Use the `gh` CLI for GitHub operations. It's pre-installed and authenticated via GITHUB_TOKEN.

## Common Operations

### Issues
```bash
# List issues
gh issue list --repo OWNER/REPO --limit 10

# Create issue
gh issue create --repo OWNER/REPO --title "Title" --body "Description"

# View issue
gh issue view NUMBER --repo OWNER/REPO

# Comment on issue
gh issue comment NUMBER --repo OWNER/REPO --body "Comment text"

# Close issue
gh issue close NUMBER --repo OWNER/REPO
```

### Pull Requests
```bash
# List PRs
gh pr list --repo OWNER/REPO

# Create PR
gh pr create --repo OWNER/REPO --title "Title" --body "Description" --base main

# View PR (with diff)
gh pr view NUMBER --repo OWNER/REPO
gh pr diff NUMBER --repo OWNER/REPO

# Review PR
gh pr review NUMBER --repo OWNER/REPO --approve
gh pr review NUMBER --repo OWNER/REPO --comment --body "Feedback"

# Merge PR
gh pr merge NUMBER --repo OWNER/REPO --squash
```

### CI/Actions
```bash
# List workflow runs
gh run list --repo OWNER/REPO --limit 5

# View run details
gh run view RUN_ID --repo OWNER/REPO

# View run logs
gh run view RUN_ID --repo OWNER/REPO --log
```

### API
```bash
# Raw API call
gh api repos/OWNER/REPO
gh api repos/OWNER/REPO/issues --method POST -f title="Bug" -f body="Details"
```

## Authentication
- GITHUB_TOKEN env var is set automatically
- `gh auth status` to verify
- If not authenticated: `gh auth login --with-token <<< "$GITHUB_TOKEN"`
