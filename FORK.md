# Fork contract

This fork carries desktop-app changes on top of upstream T3 Code nightlies.
Servers and the phone app stay stock; only the Linux desktop app is built from
here. Every change lives on `custom` and is replayed onto each new upstream
nightly.

## Branches

| Branch            | What it is                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `custom`          | Default branch. The upstream nightly in `upstream-mirror` plus this fork's commits on top.                                          |
| `upstream-mirror` | The exact upstream nightly commit `custom` sits on. Never commit to it.                                                             |
| `fork/candidate`  | Scratch output of the nightly run. Never base work on it.                                                                           |
| `<type>/<slug>`   | A change to this fork, based on `custom`, merged by PR.                                                                             |
| `upstream/<slug>` | An upstream pull request branch, based on upstream `main`. `feat/desktop-local-theme` (pingdotgg/t3code#17883) predates the naming. |

## Rolling rebase

- `custom` is a patch stack: upstream history, then one commit per customization.
  Upstream never gets merged into it. Replay the stack with
  `git rebase --onto <new-nightly-tag> upstream-mirror custom`.
- A change lands as a pull request into `custom`, rebased onto `custom` and
  merged by squash (or rebase, for a few self-contained commits). The
  repository refuses merge commits, which would break the next replay.
- When upstream ships a customization, drop its commit at the next rebase and
  remove its entry below.
- Resolve a conflict by reading both sides and keeping the intent of each
  customization below. The `custom` force-push uses
  `--force-with-lease=custom:<tip you rebased>`, so a change merged in the
  meantime is never lost.

## Nightly pipeline

`.github/workflows/fork-nightly.yml` runs daily at 07:35 UTC and on demand.

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

## Holds

- **Conflict:** replay the stack by hand on a `rebase/<tag>` branch, resolving
  each conflict by the intent in Customizations. Show
  `git range-diff upstream-mirror..custom <tag>..rebase/<tag>` to the owner.
  After approval, push it to `custom` and `<tag>` to `upstream-mirror`, both
  with `--force-with-lease`. Then run the workflow with `target_tag=<tag>`.
- **Check or build:** fix the customization in a pull request into `custom`,
  then run the workflow. If upstream fails on its own, the next nightly
  retries.
- **Protocol:** the owner decides; see Nightly pipeline, step 2.

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
with its reason in that customization's entry below.

## Customizations

One entry per customization. "Must still be true" lists the behaviour the
customization exists for, in terms a reviewer can check against the code,
tests and app. A pull request that adds or changes a customization updates
its entry in the same PR and adds itself under Detail. Reviewing a pull
request, resolving a conflict or fixing a hold means confirming every entry
the change touches still holds; when an entry and the code disagree, the
entry is the intent and the code is the bug, unless the owner rules
otherwise.

### Local desktop theme

- **Commits:** `feat(desktop): follow system colors or a local palette file`
- **Must still be true:**
  - Choosing **System theme** in Settings → Appearance makes the desktop app
    follow the computer's light/dark appearance and accent, with local
    environments disabled and when connected to remote servers only.
  - With no accent exposed, both appearances use T3's standard colors. An
    accent recolours actions only, never app surfaces or error colours.
  - On Linux, Omarchy's generated T3 palette is found with no launcher,
    environment variable or broker, and an Omarchy theme switch is followed.
  - **Choose theme file** follows that file through atomic replacements and
    across restarts; **Use automatic colors** returns to detection.
  - A missing or invalid file keeps the last valid palette from that source,
    or native colours until one arrives. Files over 32 KiB, non-regular files
    and symlinks to files are refused.
  - A manually chosen theme survives file updates, a change of source, server
    theme pushes, delayed startup responses, navigation and restarts.
    Changing the source never replaces it.
  - Web and mobile clients and the stock servers see no change; nothing the
    desktop app sends a server changes.
- **Rebase footprint:** every nightly replays this commit, so it edits
  upstream files only where it must hook in. The desktop keeps its own copy
  of the server's guarded theme-file reader (`apps/desktop/src/theme/themeFile.ts`)
  and declares the two culori calls it uses (`culori.d.ts`), leaving
  `apps/server`, `packages/shared/package.json` and the lockfile's
  `@types/culori` entry stock: upstream appends to the shared exports and
  bumps the dependency next to that entry about weekly, and replayed against
  the 90 days to 2026-10-14 those edits would have held 14 and 12 nightlies.
- **Detail:** pingdotgg/t3code#17883 (pushed before fork PRs were required);
  slimmed to one commit in not-compromised/t3code#18 (2026-10-14);
  user guide in `docs/user/appearance.md`, Desktop colors.
- **Retire when:** upstream merges pingdotgg/t3code#17883.

### Fork pipeline

- **Commits:** `chore(fork): nightly rolling rebase and release pipeline`,
  `fix(fork): revive the nightly schedule GitHub dropped`,
  `chore(fork): dispatch the nightly from the owner's server`
- **Must still be true:**
  - On each dispatch, the newest upstream nightly gets `custom` replayed onto
    it, checked and built; it ships only when every step is green. GitHub
    never starts it on a schedule: the owner's server dispatches it once a
    night, or by day after the owner approves.
  - A changed `ORCHESTRATION_PROTOCOL_VERSION` never ships without
    `allow_protocol_change`.
  - A release carries the upstream version unchanged, and fork builds update
    from this repository's releases.
  - Any failure ships nothing and opens or updates one `rebase-hold` issue;
    the next success closes it.
  - The boundary check runs on every pull request and nightly and refuses the
    refused zone except listed exceptions.
  - Upstream's own workflows stay disabled.
  - The push key lives only in the two push steps, which run no repository
    code; write access stays out of jobs that run repository code,
    and `custom` is replaced only under a lease on the tip that was rebased.
- **Tests:** `node --test .github/fork/*.test.cjs` (Check job), one test per
  promise above that can be checked without running Actions.
- **Detail:** this file and `.github/workflows/fork-nightly.yml`;
  not-compromised/t3code#6 (nightly schedule revival),
  not-compromised/t3code#12 (dispatch from the owner's server).
- **Retire when:** never.

### Dependency security fixes

- **Commits:** `fix(fork): update dependencies with released security fixes`
- **Must still be true:**
  - The workspace lockfile resolves the dependencies named in #8 to releases
    that fix the reported advisories.
  - Security overrides use compatible minimum-version ranges, allowing newer
    patch/minor releases within the chosen compatibility line. Remove them
    when upstream raises its dependency requirements to fixed versions.
  - The desktop build, markdown rendering, D-Bus integration and bundled
    provider SDK consumers remain compatible. Navigation keeps query-string
    7's namespace API while its decoder resolves to a fixed ESM release.
- **Boundary exception:** the owner's dependency-update request permits
  security overrides in `pnpm-workspace.yaml` and regenerated `pnpm-lock.yaml`.
  Stock npm servers and the TestFlight app still receive dependencies from
  upstream; this fork update changes their bundled fork counterparts only.
- **Detail:** not-compromised/t3code#8, not-compromised/t3code#10.
- **Retire when:** upstream's dependency requirements exclude the vulnerable versions.

### Write guard for protected checkouts

- **Commits:** `feat(desktop): refuse editor writes into protected checkouts`
- **Must still be true:**
  - Off by default: with no `write-guard.json` in the desktop's state
    directory (`~/.t3/userdata` for the packaged app), every file write the
    desktop app makes reaches the server exactly as it would without this
    customization. Outside the desktop app nothing is wrapped.
  - On while that file exists and names repositories
    (`{"protectedRepositories": ["github.com/<owner>/<repo>"]}`): a write from
    the file editor or the plan card's save whose real destination, after
    every link, lies inside any checkout or worktree with a remote that is
    one of them is refused before the server is asked. A notice names the file,
    where it really leads and the checkout, and carries the attempted change
    as a diff that copies in full.
  - A destination the guard cannot establish, a settings file it cannot use
    (including a link to a missing file, or an entry that is not
    host/owner/repo), or a desktop that cannot report the guard's state
    refuses the write; none of them lets it through.
  - The file is read on every write, so adding or removing it switches the
    guard without a restart. Writes to one file still land in the order made.
  - A link whose target does not exist yet looks like a new file to a stock
    server, so that write goes ahead; the guard checks it again once written,
    shows a notice if it landed in a protected checkout, and refuses every
    later write to it. A file link it cannot trace is refused.
  - Nothing the desktop app sends a server changes, except that while the
    guard is on it first sends `projects.readFile` and `projects.listEntries`
    requests, which stock servers already answer.
- **Limits:** agents' own file edits run in provider processes on the
  servers, and T3's server-side tools are stock, so neither passes through
  this guard; hooks in the agents themselves and a commit check cover them.
  Stock servers expose no link counts, devices or git settings, so hardlinks,
  bind mounts, a `.git` kept outside the working tree, SSH host aliases,
  `insteadOf` and `[include]`d remotes go unseen. A file allowed in the last
  10 seconds is not checked again on its next save. POSIX servers only.
- **Tests:** `apps/web/src/writeGuard/*.test.ts`,
  `apps/web/src/state/projects.writeGuard.test.ts`,
  `apps/desktop/src/writeGuard/DesktopWriteGuard.test.ts`.
- **Detail:** not-compromised/tools#615.
- **Retire when:** never; it guards this fleet's own checkouts.

## Verification

A run is good when the release exists with `T3-Code-*.AppImage` and
`nightly-linux.yml`, and an installed fork build finds it through
Settings → Updates. Before moving `custom` by hand, run
`node --test .github/fork/*.test.cjs`, the boundary check against
`upstream-mirror`, and the client-side tests from the workflow.

## Rollback

Every release stays published, and its tag points at the exact stack it
shipped. Roll a desktop back by installing an older release's AppImage; the
next release moves it forward again. Servers are never moved backward
automatically.
