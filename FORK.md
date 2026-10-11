# Fork contract

This fork carries desktop-app changes on top of upstream T3 Code nightlies.
Servers and the phone app stay stock; only the Linux desktop app is built from
here. Every change lives on `custom` and is replayed onto each new upstream
nightly.

## Branches

| Branch | What it is |
|---|---|
| `custom` | Default branch. The upstream nightly in `upstream-mirror` plus this fork's commits on top. |
| `upstream-mirror` | The exact upstream nightly commit `custom` sits on. Never commit to it. |
| `fork/candidate` | Scratch output of the nightly run. Never base work on it. |
| `feat/*`, `fix/*` | Upstream pull request branches, based on upstream `main`. |

## Rolling rebase

- `custom` is a patch stack: upstream history, then one commit per customization.
  Upstream never gets merged into it. Replay the stack with
  `git rebase --onto <new-nightly-tag> upstream-mirror custom`.
- A change lands as a pull request into `custom`, squashed to one commit (or a
  few self-contained ones). Rebase the branch onto `custom` before merging; a
  merge commit breaks the next replay.
- When upstream ships a customization, drop its commit at the next rebase and
  remove its row below.
- Resolve a conflict by reading both sides and keeping the intent of each
  customization below. The `custom` force-push uses
  `--force-with-lease=custom:<tip you rebased>`, so a change merged in the
  meantime is never lost.

## Nightly pipeline

`.github/workflows/fork-nightly.yml` runs at 08:45 UTC and on demand.

1. It picks the newest upstream nightly release tag.
2. It refuses to ship by itself if `ORCHESTRATION_PROTOCOL_VERSION` changed,
   because the phone app refuses a server whose protocol number differs. That
   run ships only by hand (`allow_protocol_change`), timed with the phone update.
3. It rebases `custom`, typechecks, runs the client-side tests and the
   boundary check, and builds the Linux AppImage. The version is the upstream
   version unchanged, and the update feed is this repository's releases.
4. On success it moves `custom` and `upstream-mirror` and publishes the release
   `v<upstream version>`. Desktop apps update from it.
5. Any failure ships nothing and opens or updates a `rebase-hold` issue. The
   next successful run closes it.

The same check job runs on every pull request into `custom`. The workflow
also keeps upstream's own workflows disabled, since they need runners this
fork does not have.

## Boundaries

The desktop app must keep speaking the stock servers' protocol.
`.github/fork/check-boundaries.sh` enforces this:

- **Free:** `apps/desktop`, `apps/web`, desktop IPC in `packages/contracts/src/ipc.ts`.
- **Careful (warning):** `packages/shared`. Additions are fine. Before
  changing existing behavior, confirm that servers and the phone keep it.
- **Refused:** `apps/server`, `apps/mobile`, `packages/client-runtime`, the
  rest of `packages/contracts`, `packages/provider-*`, `packages/source-control-*`,
  `packages/effect-*`. Server code changed here never runs on a stock server,
  and wire changes break the link to it. Changing the version scheme or the
  update channel is also off limits.

An owner-approved exception is listed in `.github/fork/boundary-exceptions`
with its reason in the table below.

## Customizations

| Commit subject | Purpose | Retire when |
|---|---|---|
| `feat(desktop): follow a local palette file independently of servers`, `fix(desktop): preserve local theme ownership during startup`, `feat(desktop): match system colors and configure local palettes` | The desktop app follows a local palette file (the system theme) whatever the server publishes. Exception: `apps/server/src/environmentTheme.ts` only moves its guarded file reader into `packages/shared/src/themeFile.ts` and re-exports it, with no behavior change. | Upstream merges pingdotgg/t3code#17883. |
| `chore(fork): nightly rolling rebase and release pipeline` | This file, the workflow, the boundary check. | Never. |

## Verification

A run is good when the release exists with `T3-Code-*.AppImage` and
`nightly-linux.yml`, and an installed fork build finds it through
Settings → Updates. Before moving `custom` by hand, run the boundary
check against `upstream-mirror` and the client-side tests from the workflow.

## Rollback

Every release stays published. Install the previous release's AppImage, or
re-run the workflow with `target_tag` set to an older nightly. `custom` history
before a rebase is kept in the workflow run's `old_custom` output.
