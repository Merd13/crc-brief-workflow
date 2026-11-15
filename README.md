# CRC brief workflow

The brief generator of Code Review Companion (CRC).
For one pull request, it writes a Review Brief with Claude Code and returns it as a PR comment.

It runs in two ways, with the same prompt, schema, validation and comment format:

- **In GitHub Actions**, as a reusable workflow. A run starts when a pull request opens, and the workflow posts the comment. It needs a generation credential as a repository secret.
- **On your own machine**, as a helper that the CRC browser extension starts. It uses the Claude Code you are signed in to. It needs no API key and no repository secret.

A Review Brief gives reviewers the context of a change, an order to read the files in, and a short list of takeaways. A takeaway is a Learning (something to understand) or a Check (something to verify).

## Use it in a repository (GitHub Actions)

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
- Pull requests from forks are refused, for every kind of run. A fork's branch is code from outside the repository.

## Generate on your own machine

The CRC extension can start a helper on your machine through Chrome's native messaging. The helper runs your local Claude Code and hands the brief comment back to the extension, which posts it under your GitHub name.

You need macOS or Linux, Node 22 or later, [Claude Code](https://code.claude.com) installed and signed in, and `git`.

1. Clone this repository and keep the folder.
2. Open the extension's Settings. The **Local Claude Code** section shows the install command with your extension id. Run it in the cloned folder:

   ```sh
   node host/install.mjs --extension-id <id>
   ```

3. In Settings, select **Check again**. Then use **Generate brief** on a pull request.

What the installer writes:

- A manifest in Chrome's `NativeMessagingHosts` folder. It names the one extension that may start the helper.
- A launcher with the full paths of Node, this folder and Claude Code. Chrome starts a helper without your shell's `PATH`.

Run the installer again after you move this folder, or after Node or Claude Code moves. For another Chromium browser, give its folder with `--manifest-dir`. To remove the helper, run `node host/install.mjs --uninstall`.

What a local run does on your machine:

- It fetches the pull request into its own cache (`~/Library/Caches/crc-brief-host` on macOS, `~/.cache/crc-brief-host` on Linux) with the GitHub token the extension sends. The token goes to `git` in the environment of that one command. It is not written to disk. Your own clones are not touched.
- It makes a temporary checkout, removes symbolic links that point outside it, and deletes the checkout when the run ends.
- While git handles the pull request's files, it ignores your git configuration. A `.gitattributes` file in a pull request can therefore not start a filter, a text converter or a hook that you have set up. Only the fetch reads your configuration, for a proxy, and it runs no hooks.
- Every git command and Claude Code itself have a time limit, and they stop when Chrome closes the connection.
- It runs Claude Code with the limits below. Your Claude settings, plugins, hooks and MCP servers are not loaded, and neither are the repository's.
- Chrome must stay open until the run ends. A small pull request takes about a minute. Usage counts against your own Claude plan.

The helper accepts two requests, a status check and a brief for one pull request. It runs no other command for the extension.

## What a run does

1. In GitHub Actions, it checks that exactly one credential is set.
2. It reads the pull request from the GitHub API and checks out the head commit.
3. It writes the pull request's text, the diff and the commit messages into a `.crc-brief` folder in the checkout.
4. Claude Code reads those files and the repository, and returns the brief's context, reading path and takeaways as structured output.
5. The next step adds the pull request facts and the metadata. It removes each code reference that does not exist at the head commit and records it in `meta.droppedAnchors`. Then it validates the brief against the contract and renders the comment.
6. In GitHub Actions, the workflow posts the comment with its own token, so the author is `github-actions[bot]`. On your machine, the extension posts it, so the author is you.

A run that fails, or whose brief is not valid, posts nothing.

### What Claude Code may do

- Its only tools are `Read`, `Grep` and `Glob`, and each is allowed only inside the checkout. It has no shell, cannot write, and cannot reach the network.
- It loads no Claude settings, hooks or MCP servers from the repository.
- Text in a pull request can try to steer a model. These limits keep such a run from reading anything outside the checkout or changing anything at all.

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
- The readable part treats brief text as untrusted. Each sequence that GitHub would make live gets a zero-width space inside it: an HTML tag or comment, an `@name`, a link or image, a character entity, and a code fence. The text looks the same. A brief therefore cannot add HTML, embed an image, hide a link's address, notify a user or open a code block, and the body always holds exactly two HTML comments.
- A brief from GitHub Actions links to its run. A brief from a reviewer's machine says `Generated locally`. A brief that a reviewer imported from a file says `Imported`.
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
| `lib/` | The logic both runners share. |
| `host/` | The local helper: message format, checkout, one run, entry point and installer. |
| `test/` | Tests for all of the above. |

The helper's messages are JSON, framed as Chrome native messaging requires. Requests: `{ id, type: "ping" }` and `{ id, type: "generate", pr: { org, repo, number }, token, model? }`. Replies: `{ id, type: "progress", stage }`, then `{ id, ok: true, value }` or `{ id, ok: false, error: { code, message } }`.
