# CRC brief workflow

A reusable GitHub Actions workflow for Code Review Companion (CRC).
For one pull request, it writes a Review Brief with Claude Code and posts the brief as a PR comment.

A Review Brief gives reviewers the context of a change, an order to read the files in, and a short list of takeaways. A takeaway is a Learning (something to understand) or a Check (something to verify).

## Use it in a repository

1. Add this file to the repository's default branch as `.github/workflows/crc-brief.yml`:

   ```yaml
   name: CRC brief

   on:
     pull_request:
       types: [opened]
     workflow_dispatch:
       inputs:
         pr_number:
           description: Pull request number
           required: true
           type: string

   permissions:
     contents: read
     pull-requests: write

   jobs:
     brief:
       uses: Merd13/crc-brief-workflow/.github/workflows/brief.yml@v1
       with:
         model: claude-opus-5-5
         pr_number: ${{ inputs.pr_number }}
       secrets:
         anthropic_api_key: ${{ secrets.CRC_ANTHROPIC_API_KEY }}
         claude_code_oauth_token: ${{ secrets.CRC_CLAUDE_CODE_OAUTH_TOKEN }}
   ```

2. Set **one** repository secret (Settings → Secrets and variables → Actions):

   | Secret | Value | Who pays |
   | --- | --- | --- |
   | `CRC_ANTHROPIC_API_KEY` | An Anthropic API key (`sk-ant-…`). | Each run bills the key. |
   | `CRC_CLAUDE_CODE_OAUTH_TOKEN` | A Claude subscription token. Run `claude setup-token` to get one. | Runs use the subscription. |

   With the GitHub CLI: `gh secret set CRC_ANTHROPIC_API_KEY --repo OWNER/REPO`.

   A run fails before Claude Code starts when no secret is set, and also when both are set.
   To replace a credential, set the secret again. To change the kind, delete one secret and set the other.

3. Open a pull request. The workflow runs and posts the brief comment.

The caller file sets two things: the model and the credential.

### Runs

- **A pull request opens:** one run starts by itself.
- **Manual run:** start the `CRC brief` workflow from the Actions tab, or run `gh workflow run crc-brief.yml -f pr_number=123`. Each run posts a new brief comment; earlier comments stay.
- New commits do not start a run.
- Pull requests from forks are not supported. GitHub does not give repository secrets to those runs.

## What a run does

1. It checks that exactly one credential is set.
2. It reads the pull request from the GitHub API and checks out the head commit.
3. Claude Code reads the pull request and the repository. Its tools are read-only: `Read`, `Glob`, `Grep`, `git diff`, `git log` and `git show`. It returns the brief's context, reading path and takeaways as structured output.
4. The posting step adds the pull request facts and the metadata. It removes each code reference that does not exist at the head commit and records it in `meta.droppedAnchors`. Then it validates the brief against the contract.
5. The posting step posts the comment with the workflow's own token, so the author is `github-actions[bot]`.

A run that fails, or whose brief is not valid, posts nothing.

## Comment format

Tools that read the brief, such as the CRC extension, rely on this layout.

```text
<!-- crc-brief:v1 -->
## Review brief
…readable markdown…

<!-- crc-brief-data
{"schemaVersion":1,…}
-->
```

- The first line is exactly `<!-- crc-brief:v1 -->`.
- The data block is the last thing in the body: a line `<!-- crc-brief-data`, one line of JSON, and a line `-->`.
- The JSON is the brief in the contract format. Every `<` is written as `<` and every `>` as `>`, so the JSON cannot contain `-->`. `JSON.parse` reads it unchanged.
- In the readable part, `<!--` is written as `&lt;!--`. The body therefore holds exactly two HTML comments.
- In the readable part, each `@name` gets a zero-width space after the `@`, so a brief never notifies a user.
- The brief has `meta.source: "generated"` and no `published` block.
- A GitHub comment holds at most 65,536 characters. When the full body is longer, the readable part lists item titles only and the JSON stays complete. When that is still too long, the run fails.

`extractBrief` in [`lib/render.mjs`](lib/render.mjs) is a reference reader.

## The contract

`contract/` is generated from the CRC repository, where the brief contract is defined. Do not edit it here.

- `contract/contract.mjs` validates a brief (`parseBriefFile`).
- `contract/generation.schema.json` is the schema that Claude Code's output must follow.

To update both, run this in the CRC repository's `extension/` folder:

```sh
npm run workflow-contract -- <path to this repository>/contract
```

## Versions

Callers pin the `v1` tag. A change reaches every repository that is set up when `v1` moves to a new commit:

```sh
git tag -f v1 && git push -f origin v1
```

## Development

Node 22 or later. There are no dependencies to install.

```sh
node --test
```

| Path | Purpose |
| --- | --- |
| `.github/workflows/brief.yml` | The reusable workflow. |
| `prompt/brief-prompt.md` | The prompt for Claude Code. It follows CRC's extraction guidance, version `v0.2`. |
| `scripts/` | The entry point of each workflow step. |
| `lib/` | The logic behind the steps. |
| `test/` | Tests for `lib/` and `scripts/`. |
