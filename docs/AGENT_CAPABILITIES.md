# What Ulla Britta can do on GitHub

This is the map of the agent's capability surface: what it can reach, what it
cannot, and why. The inventory table is generated from the tool registry, so it
cannot drift from the code — if a tool exists, it is listed here; if it is listed
here, it exists.

```
npm run docs:capabilities          # regenerate the inventory
npm run docs:capabilities:check    # fail if it is stale (runs in the test suite)
```

---

## How the agent reaches GitHub

Two credentials, and they are not interchangeable.

**The installation token** is the GitHub App acting on repositories the user has
granted it. It does almost everything: reading and writing files, issues, pull
requests, Actions, releases, collaborators, security alerts. It is resolved from
the acting user through `github_installations`, so a user can never reach an
account they have not connected.

**The user token** is the agent acting *as the person*. GitHub refuses a specific
set of endpoints to anything that is not the user themselves:

| Endpoint | What it is for |
| --- | --- |
| `POST /user/repos` | Creating a repository on a **personal** account |
| `PUT /user/starred/…` | Starring |
| `PUT /user/following/…` | Following |
| `GET /notifications` | The notification inbox |
| `POST /gists` | Creating a gist |

This is why "start a new repo and push it to my github" could not work with the
installation token alone, and why creating a repository inside an *organization*
always could — `POST /orgs/{org}/repos` accepts an installation token.

User tokens are optional. Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, turn
on *Request user authorization (OAuth) during installation* on the GitHub App, and
the user connects their account once from the dashboard. Without it, the seven
user-scoped tools fail with an instruction rather than a 403, and everything else
is unaffected.

| Route | Purpose |
| --- | --- |
| `GET /github/oauth/url` | The authorize link, with a signed state |
| `GET /github/oauth/callback` | Exchanges the code, stores the token |
| `GET /github/oauth/status` | Whether the agent can act as this user |
| `POST /github/oauth/disconnect` | Revokes it locally |

Tokens live in `github_user_tokens` (migration `005`), which has row level
security enabled with **no policy at all** — the browser cannot read it under any
role. Only the backend, holding the service key, can. They are refreshed
automatically five minutes before expiry.

---

## Naming a repository

Every repository argument accepts:

- `owner/repo` — used as given
- `repo` — resolved against the repositories this installation can see
- `https://github.com/owner/repo` — parsed

A bare name resolves to the user's own account first, then to any accessible
repository whose name matches, case-insensitively. Two matches raise
`AMBIGUOUS_REPO_NAME` with both names, so the agent asks rather than picks.

When a repository cannot be reached, the error says what *is* reachable:

> `"IronicRayquaza/glyph"` is not visible to your installation. Either it does not
> exist, or the app was not granted access to it. I can currently see 6
> repositories, and that is not one of them: …

This matters because a GitHub App installed on *selected repositories* sees only
those. A repository that is missing from the list very often exists — the app
simply was not granted it. The agent is told the difference, and told to point at
<https://github.com/settings/installations> rather than to conclude the repository
is gone.

---

## Cross-repository questions

Questions like *"do I have any open PRs"*, *"what is assigned to me"*, *"which PRs
are waiting on my review"* are not per-repository questions. `search_issues` takes
GitHub's own search syntax and answers them in one call:

```
is:pr is:open author:USERNAME
is:issue is:open assignee:USERNAME label:bug
is:pr is:open review-requested:USERNAME
is:pr is:open repo:owner/name
```

`search_code`, `search_repositories` and `search_users` cover the same ground for
file contents, projects and people.

---

## Safety

**Confirmation.** `delete_repository` is the only tool gated behind an explicit
confirmation. The first call is refused with `CONFIRMATION_REQUIRED`; the user must
confirm on a *later* turn, so the agent cannot raise and satisfy its own
confirmation inside one loop.

Branch deletion, file deletion, merges and collaborator removal are not gated —
they are recoverable from git or from GitHub's own history — but they are marked
side-effecting, and the prompt requires the agent to say what it is about to do.

**Idempotency.** Every tool that writes is marked `sideEffecting`. A retried run
will not push the same file twice, open a duplicate pull request, or send the same
email again: the registry returns the earlier result with `alreadyApplied: true`.

**Honesty.** Tools distinguish *"there is nothing"* from *"I could not look"*.
`list_security_alerts` reports `couldNotRead` when Dependabot is not enabled rather
than reporting zero alerts as a clean bill of health; `get_repository_stats` names
the metrics it lacks permission for. `delete_branch` refuses the default branch,
`merge_pull_request` reads the PR's state first so a refusal explains itself
instead of surfacing a raw 405.

---

## Deliberately not covered

Not everything GitHub exposes belongs in an agent's hands.

| Area | Why not |
| --- | --- |
| Secrets and variables (`/actions/secrets`) | Writing secrets an agent can be talked into reading back is not a risk worth taking. |
| Branch protection rules | Silently weakening a protection rule is the kind of change that must be a human decision. |
| Webhooks and deploy keys | Same: they change who can reach the repository. |
| Organization and team administration | Membership changes belong to an org owner. |
| Repository transfer | Irreversible in practice, and moves ownership out of the user's account. |
| Projects v2 | GraphQL-only with a substantially different model; not started rather than half-done. |
| Secret scanning alerts | Requires GitHub Advanced Security; would fail for nearly every user. |

Adding any of these is a decision, not an oversight — record it in the table above
when it changes.

---

## Adding a tool

1. Put it in the module for its GitHub domain under `src/agent/tools/`.
2. Give it a description that says what it *does*, not what it is called. The model
   only ever sees the description.
3. Mark `sideEffecting: true` if it writes. Mark `destructive: true` only if it
   destroys something git cannot recover.
4. Return `ok()` / `fail()` from `providers/messages.mjs`, never a bare string.
5. Turn a raw GitHub error into a sentence a person can act on — a 422 from
   `pulls.create` means "that branch has no new commits", not "422".
6. Add a narrator in `src/agent/narration.mjs` if the generic one reads poorly.
7. `npm run docs:capabilities` and `npm test`.

---

<!-- BEGIN GENERATED: tool inventory -->

**88 tools across 9 domains.** Arguments marked `*` are required.

| Domain | Tools |
| --- | ---: |
| [Repositories](#repositories) | 14 |
| [Files and code](#files-and-code) | 8 |
| [Branches, commits and history](#branches-commits-and-history) | 8 |
| [Issues, labels and milestones](#issues-labels-and-milestones) | 13 |
| [Pull requests](#pull-requests) | 14 |
| [GitHub Actions and CI](#github-actions-and-ci) | 7 |
| [Releases](#releases) | 3 |
| [People and accounts](#people-and-accounts) | 14 |
| [Insight, discovery and delivery](#insight-discovery-and-delivery) | 7 |
| **Total** | **88** |

### Repositories

| Tool | Does | Arguments | |
| --- | --- | --- | --- |
| `list_repositories` | Lists the repositories this user has granted access to, most recently pushed first. Use this when you need to know what the user has before acting, or when a repository name they gave you does not resolve. | `limit`, `sort` | read-only |
| `get_repository` | Reads a repository's facts: visibility, default branch, stars, forks, open issue count, topics, licence, size and when it was last pushed. Use this to answer questions about a repository rather than guessing from its name. | `repoName`* | read-only |
| `create_repository` | Creates an empty repository, optionally with a README, .gitignore and licence. This is the tool for "make me a new repo" — it writes no code. Use scaffold_repository instead when the user wants a working project generated. | `name`*, `description`, `private`, `owner`, `autoInit`, `readmeContent`, `gitignoreTemplate`, `licenseTemplate` | writes |
| `scaffold_repository` | Creates a repository AND generates a starter project in it from a description and a tech stack. Use only when the user wants code written; for an empty repository use create_repository. | `name`, `prompt`*, `techStack`*, `private`, `owner` | writes |
| `update_repository` | Changes a repository's settings: description, homepage, default branch, visibility, whether issues/wiki/projects are enabled, and whether it is archived. | `repoName`*, `description`, `homepage`, `defaultBranch`, `private`, `hasIssues`, `hasWiki`, `hasProjects`, `archived` | writes |
| `set_repository_topics` | Replaces a repository's topics with the list given. Topics are how a repository is found on GitHub. | `repoName`*, `topics`* | writes |
| `fork_repository` | Forks a repository into the user's account or an organization. | `repoName`*, `organization` | writes |
| `star_repository` | Stars a repository as the user. Requires the user to have connected their GitHub account. | `repoName`* | writes, needs user auth |
| `unstar_repository` | Removes the user's star from a repository. | `repoName`* | writes, needs user auth |
| `list_collaborators` | Lists who has access to a repository and at what permission level. | `repoName`*, `limit` | read-only |
| `add_collaborator` | Invites someone to a repository at a given permission level. They receive an invitation they must accept. | `repoName`*, `username`*, `permission` | writes |
| `remove_collaborator` | Removes someone's access to a repository. | `repoName`*, `username`* | writes |
| `get_repository_stats` | Reads a repository's language breakdown, top contributors and — where the app has permission — page views and clones. Reports which parts it could not read rather than leaving them out. | `repoName`* | read-only |
| `delete_repository` | PERMANENTLY deletes a repository. Irreversible. The system requires explicit user confirmation before this can run. | `repoName`* | **destructive** |

### Files and code

| Tool | Does | Arguments | |
| --- | --- | --- | --- |
| `get_readme` | Fetches the README of a repository so you can understand what a project actually is before acting on it. | `repoName`* | read-only |
| `get_file` | Reads a single file from a repository. Use this to inspect real code before proposing a change, rather than guessing at its contents. | `repoName`*, `path`*, `ref` | read-only |
| `list_directory` | Lists the files and folders at a path in a repository. Use this to explore a project you have not read before, instead of guessing at file paths. | `repoName`*, `path`, `ref` | read-only |
| `get_repository_tree` | Lists every file path in a repository in one call. Use this when you need the shape of a whole project rather than one directory at a time. | `repoName`*, `ref`, `limit` | read-only |
| `push_file` | Creates or replaces one file in a repository and commits it. Use for CI workflows, config files and other single-file changes. | `repoName`*, `path`*, `content`*, `commitMessage`*, `branch` | writes |
| `push_files` | Writes several files in ONE commit. Use this instead of calling push_file repeatedly, so a multi-file change lands atomically rather than as a half-applied series of commits. | `repoName`*, `files`*, `commitMessage`*, `branch` | writes |
| `delete_file` | Deletes one file from a repository and commits the removal. | `repoName`*, `path`*, `commitMessage`*, `branch` | writes |
| `search_code` | Searches file contents across repositories for a string or symbol. Use this to find where something is defined or used, instead of opening files one at a time. | `query`*, `repoName`, `language`, `path`, `filename`, `limit` | read-only |

### Branches, commits and history

| Tool | Does | Arguments | |
| --- | --- | --- | --- |
| `list_branches` | Lists the branches of a repository, marking the default one and which are protected. | `repoName`*, `limit` | read-only |
| `create_branch` | Creates a branch from another branch or commit. Use this before making a set of changes you intend to open a pull request for. | `repoName`*, `branch`*, `from` | writes |
| `delete_branch` | Deletes a branch. Refuses to delete the default branch. | `repoName`*, `branch`* | writes |
| `list_commits` | Lists recent commits, optionally filtered by branch, file path, author or date. Use this to see what has actually been happening in a repository. | `repoName`*, `branch`, `path`, `author`, `since`, `until`, `limit` | read-only |
| `get_commit` | Reads one commit in full: its message, its stats, and which files it changed with their diffs. | `repoName`*, `sha`*, `includePatches` | read-only |
| `compare_branches` | Compares two branches, tags or commits: how far ahead or behind, which commits differ and which files changed. Use this to answer "what is on this branch that is not on main". | `repoName`*, `base`*, `head`* | read-only |
| `list_tags` | Lists a repository's git tags, newest first. | `repoName`*, `limit` | read-only |
| `generate_changelog` | Generates a changelog from the recent commits on a repository. | `repoName`* | read-only |

### Issues, labels and milestones

| Tool | Does | Arguments | |
| --- | --- | --- | --- |
| `list_issues` | Lists issues on a repository, filtered by state, label, assignee or age. Pull requests are excluded — use list_pull_requests for those. | `repoName`*, `state`, `labels`, `assignee`, `creator`, `since`, `sort`, `limit` | read-only |
| `get_issue` | Reads one issue in full, including its body and its most recent comments. Works for pull requests too. | `repoName`*, `issueNumber`*, `includeComments` | read-only |
| `create_issue` | Opens an issue on a repository, optionally with labels, assignees and a milestone. | `repoName`*, `title`*, `body`, `labels`, `assignees`, `milestone` | writes |
| `update_issue` | Changes an issue: its title, body, state, labels, assignees or milestone. Closing and reopening are done here — pass state. Works for pull requests too. | `repoName`*, `issueNumber`*, `title`, `body`, `state`, `stateReason`, `labels`, `assignees`, `milestone` | writes |
| `comment_on_issue` | Posts a comment on an issue or a pull request. This is how you reply to a discussion or explain something you did. | `repoName`*, `issueNumber`*, `comment`* | writes |
| `list_labels` | Lists the labels defined on a repository, with their colours and descriptions. | `repoName`*, `limit` | read-only |
| `create_label` | Creates a label on a repository, or updates its colour and description if it already exists. | `repoName`*, `name`*, `color`, `description` | writes |
| `add_labels` | Adds labels to an issue or pull request, keeping the ones already on it. Use update_issue if you want to replace them instead. | `repoName`*, `issueNumber`*, `labels`* | writes |
| `remove_label` | Removes one label from an issue or pull request. | `repoName`*, `issueNumber`*, `label`* | writes |
| `list_milestones` | Lists a repository's milestones with their due dates and how many issues each still has open. | `repoName`*, `state` | read-only |
| `create_milestone` | Creates a milestone that issues and pull requests can be grouped under. | `repoName`*, `title`*, `description`, `dueOn` | writes |
| `search_issues` | Searches issues and pull requests across ALL of GitHub using its search syntax. This is the tool for questions that are not about one repository: "my open PRs", "issues assigned to me", "PRs waiting on my review", "issues mentioning me". | `query`*, `sort`, `limit` | read-only |
| `flag_stale_issues` | Finds issues with no activity for over 30 days and posts a warning comment on each. Reports exactly how many were flagged. It warns only, it never closes anything. | `repoName`*, `dryRun` | writes |

### Pull requests

| Tool | Does | Arguments | |
| --- | --- | --- | --- |
| `list_pull_requests` | Lists pull requests on a repository so you can decide which ones need attention. | `repoName`*, `state`, `base`, `head`, `sort`, `limit` | read-only |
| `get_pull_request` | Reads a pull request in full: metadata, changed files, whether it merges cleanly, and which checks are failing. Use this before reviewing or fixing one. | `repoName`*, `prNumber`* | read-only |
| `create_pull_request` | Opens a pull request from one branch into another. The head branch must already exist and have commits the base does not. | `repoName`*, `title`*, `head`*, `base`, `body`, `draft` | writes |
| `update_pull_request` | Changes a pull request: title, body, base branch, or open/closed state. To mark a draft ready for review, use mark_pull_request_ready. | `repoName`*, `prNumber`*, `title`, `body`, `base`, `state` | writes |
| `list_pull_request_files` | Lists the files a pull request changes, with additions and deletions per file, and optionally the diff itself. | `repoName`*, `prNumber`*, `includePatches` | read-only |
| `list_pull_request_reviews` | Lists the reviews left on a pull request and what each reviewer decided. Use this to see whether a PR is approved or blocked. | `repoName`*, `prNumber`* | read-only |
| `submit_pull_request_review` | Submits a review on a pull request with a decision you have already made: approve it, request changes, or leave a comment. Use review_pull_request instead when you want the changes analysed first. | `repoName`*, `prNumber`*, `event`*, `body` | writes |
| `review_pull_request` | Reviews a pull request against its real diff and posts a GitHub review with inline comments anchored to specific lines. | `repoName`*, `prNumber`* | writes |
| `request_reviewers` | Asks specific people or teams to review a pull request. | `repoName`*, `prNumber`*, `reviewers`, `teamReviewers` | writes |
| `mark_pull_request_ready` | Takes a pull request out of draft and marks it ready for review. | `repoName`*, `prNumber`* | writes |
| `update_pull_request_branch` | Merges the latest base branch into a pull request's branch, bringing an out-of-date PR up to date. | `repoName`*, `prNumber`* | writes |
| `merge_pull_request` | Merges a pull request. Check first that it is mergeable and its checks pass — this changes the base branch and is awkward to undo. Say what you are merging before you do it. | `repoName`*, `prNumber`*, `method`, `commitTitle`, `commitMessage` | writes |
| `get_check_failures` | Reads the failing CI checks for a commit or branch, with their annotations, so you can see why a build actually broke. | `repoName`*, `ref`* | read-only |
| `fix_pull_request` | Reads a pull request, its failing checks and its real file contents, then pushes a fix to the PR branch and comments explaining what changed. Only touches files the PR already changed, and refuses rather than guessing when it cannot determine a correct fix. | `repoName`*, `prNumber`*, `instruction` | writes |

### GitHub Actions and CI

| Tool | Does | Arguments | |
| --- | --- | --- | --- |
| `list_workflows` | Lists the GitHub Actions workflows defined in a repository and whether each is active. | `repoName`* | read-only |
| `list_workflow_runs` | Lists recent workflow runs with their conclusions. Use this to answer "is CI passing" or to find the run that broke. | `repoName`*, `workflow`, `branch`, `status`, `limit` | read-only |
| `get_workflow_run` | Reads one workflow run and its jobs, naming exactly which jobs and which steps failed. | `repoName`*, `runId`* | read-only |
| `get_workflow_run_logs` | Reads the actual log output of a failed workflow job. This is how you find the real error message instead of guessing from a check name. Returns the tail of the log, where failures appear. | `repoName`*, `runId`*, `jobName`, `lines` | read-only |
| `rerun_workflow` | Runs a workflow run again, optionally only the jobs that failed. Use this after pushing a fix, or when a run failed for a transient reason. | `repoName`*, `runId`*, `failedOnly` | writes |
| `cancel_workflow_run` | Cancels a workflow run that is still in progress. | `repoName`*, `runId`* | writes |
| `dispatch_workflow` | Triggers a workflow manually. The workflow must declare a workflow_dispatch trigger in its YAML. | `repoName`*, `workflow`*, `ref`, `inputs` | writes |

### Releases

| Tool | Does | Arguments | |
| --- | --- | --- | --- |
| `list_releases` | Lists a repository's releases, newest first, with their tags and publication dates. | `repoName`*, `limit` | read-only |
| `get_latest_release` | Reads the most recent published release, including its release notes. Use this to answer "what version is it on" or "what changed in the last release". | `repoName`* | read-only |
| `create_release` | Publishes a release against a tag, creating the tag if it does not exist. Can generate the release notes from the commits since the previous release. | `repoName`*, `tag`*, `name`, `body`, `target`, `draft`, `prerelease`, `generateNotes` | writes |

### People and accounts

| Tool | Does | Arguments | |
| --- | --- | --- | --- |
| `get_user_profile` | Reads a GitHub profile: follower and following counts, public repository count, bio, company, location and when the account was created. With no username it reads the user's own account. This is the tool for "how many followers do I have". | `username` | read-only |
| `list_followers` | Lists the accounts following a user. With no username it lists the user's own followers. | `username`, `limit` | read-only |
| `list_following` | Lists the accounts a user follows. With no username it lists who the user themselves follows. | `username`, `limit` | read-only |
| `follow_user` | Follows a GitHub user as the user. Requires the user to have connected their GitHub account. | `username`* | writes, needs user auth |
| `unfollow_user` | Stops following a GitHub user. | `username`* | writes, needs user auth |
| `list_public_repositories` | Lists the public repositories belonging to any GitHub user or organization — including accounts the app is not installed on. Use this to look at someone else's work. | `username`*, `sort`, `limit` | read-only |
| `list_starred_repositories` | Lists the repositories a user has starred. With no username it lists the user's own stars. | `username`, `limit` | read-only |
| `list_organizations` | Lists the organizations a user belongs to publicly. With no username it lists the user's own. | `username` | read-only |
| `list_organization_members` | Lists the public members of an organization. | `org`*, `limit` | read-only |
| `search_users` | Searches GitHub for people and organizations by name, location, language or follower count. | `query`*, `limit` | read-only |
| `list_notifications` | Reads the user's GitHub notification inbox: mentions, review requests, and activity on things they subscribe to. Requires the user to have connected their GitHub account. | `all`, `limit` | needs user auth |
| `mark_notifications_read` | Marks the user's GitHub notifications as read, optionally only for one repository. | `repoName` | writes, needs user auth |
| `list_gists` | Lists a user's public gists. With no username it lists the user's own, including private ones when they have connected their account. | `username`, `limit` | read-only |
| `create_gist` | Creates a gist owned by the user — a good way to share a snippet or a generated file without putting it in a repository. Requires the user to have connected their GitHub account. | `description`, `filename`*, `content`*, `public` | writes, needs user auth |

### Insight, discovery and delivery

| Tool | Does | Arguments | |
| --- | --- | --- | --- |
| `search_repositories` | Searches public GitHub repositories by topic, keyword, language or star count. Use this to find projects, not to find the user's own — list_repositories does that. | `topic`, `keyword`, `language`, `minStars`, `limit` | read-only |
| `check_dependencies` | Compares the package.json of a repository against the live npm registry and the OSV advisory database. Reports real version drift and real advisories, not recollection. | `repoName`* | read-only |
| `check_repo_health` | Measures repository health from real signals: CI pass rate, test setup, backlog age, commit recency. States which signals it could not read rather than scoring them as fine. | `repoName`* | read-only |
| `list_security_alerts` | Reads a repository's open security alerts: Dependabot advisories on its dependencies and code-scanning findings. Says plainly when a feature is not enabled rather than reporting zero alerts as though it were clean. | `repoName`*, `kind`, `severity`, `limit` | read-only |
| `get_rate_limit` | Reports how much GitHub API quota is left. Useful when calls start failing and you need to know whether it is a rate limit rather than a permission problem. | — | read-only |
| `send_email` | Emails content to the user: a report, generated code, or a summary. Use this when they ask to be sent something, not as a substitute for answering here. | `subject`*, `content`* | writes |
| `build_feature` | Opens a labelled issue that triggers the build pipeline: it analyses the repository, writes the change on a branch and opens a pull request. The work happens in the background. | `repoName`*, `featureDescription`* | writes |

_This section is generated by `npm run docs:capabilities`. Edit the tools, not the table._

<!-- END GENERATED: tool inventory -->
