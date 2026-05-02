# Achievements report

## What shipped

A bounded-history fix for Dance's `Recorder`, packaged as a `.vsix` and
attached to a GitHub release at:

**https://github.com/WjcmeAFJb/dance/releases/tag/v0.5.17-perf.1**

Direct download:
**https://github.com/WjcmeAFJb/dance/releases/download/v0.5.17-perf.1/dance-0.5.17-perf.1.vsix**

Install:
```sh
code --install-extension dance-0.5.17-perf.1.vsix
# or
codium --install-extension dance-0.5.17-perf.1.vsix
```

## What was wrong

Long Dance sessions got progressively laggier; restarting VS Code
restored responsiveness. That's a memory-leak fingerprint, not a
hot-path fingerprint.

`src/state/recorder.ts` kept four monotonically growing data structures:
`_buffer`, `_previousBuffers`, `_storedObjects`, `_storedObjectsMap`.
Every keystroke wrote to them. Nothing trimmed them. Across an 8-hour
editing day the live set grew to ~219 MB and major GC pauses on the
extension-host thread (the same thread that processes keypresses)
crossed 25 ms each.

## How we proved it

A standalone Node.js benchmark in `bench/recorder-bench.ts` mounts the
**actual** `Recorder` class against a minimal `vscode` mock and drives
realistic event mixes (selection changes + text inserts + command
records with fresh argument objects), then measures forced major-GC
pauses round-by-round. GC pause time is the cleanest proxy for what the
user feels, since every GC blocks the JS thread and so directly delays
the next keypress.

At 2.5 M events ("a single intensive day"):

```
BEFORE:  heap=218.7 MB  rss=318.6 MB  GC=27.0 ms  buffers=1556  storedObjects=1,032,221
 AFTER:  heap=  6.2 MB  rss=101.4 MB  GC= 1.5 ms  buffers=  16  storedObjects=   11,331
```

A second harness, `bench/correctness-bench.ts`, replays a `Recording`
captured early in the session **after** 200 k subsequent events have
forced repeated buffer archives and FIFO evictions, confirming the new
per-buffer dedup store + WeakMap correctly resolves stored objects
even when the recorder has forgotten the original buffer.

## How we fixed it

Three localized changes in `src/state/recorder.ts` (~50 lines diff):

1. **Per-buffer `BufferStore`** — each buffer carries its own
   `storedObjects` array and dedup `Map`, owned via a
   `WeakMap<Buffer, BufferStore>`. Buffer entries reference into their
   buffer's store; dropping a buffer also drops every object it held.
   `Recording` instances hold a strong reference to the buffer they
   were captured against, so saved macros keep replaying correctly
   even after eviction. Each `Entry`'s `getString`/`getObject` now
   passes `this.buffer` so lookups find the right store.
2. **FIFO cap** on `_previousBuffers` at `MaxPreviousBuffers = 16`
   (~131 k retained events).
3. **`Map`-based descriptor lookup** — replaces a per-record
   `Array#indexOf` over ~200 entries.

## Why patch, not rewrite, not VSCodium fork

The fix is ~50 lines in one file. The recorder's public API is
preserved exactly (`startRecording` / `Recording.replay` /
`recorder.getString` etc. all behave identically). Existing tests apply.
The rest of the extension — ~13 kLOC implementing a non-trivial
Kakoune keymap — works correctly; throwing it away to fix one growth
bug would be months of work that reintroduces edge cases the project
has spent years fixing. Forking VSCodium to bake the actions into the
editor core would mean owning ~60 kLOC of editor code, cross-platform
builds and signing, just to avoid a two-line change in an extension.
The patch is the obvious choice on every axis: smallest surface, lowest
risk, fastest turnaround.

## Files in this release

- `src/state/recorder.ts` — the fix.
- `bench/recorder-bench.ts` — performance harness.
- `bench/correctness-bench.ts` — replay-after-eviction sanity check.
- `bench/vscode-mock.ts` — minimal `vscode` mock that lets the bench
  drive the recorder without Electron.
- `bench/build.sh` — esbuild script for the harnesses.
- `bench/REPORT.md` — full investigation, hypothesis, before/after
  numbers, decision rationale.
- `bench/results/{before,after,before-large,after-large}.json` — raw
  data behind the numbers.
- `dance-0.5.17-perf.1.vsix` (attached to the release) — installable.

## Reproducing the numbers

```sh
git clone https://github.com/WjcmeAFJb/dance.git
cd dance
git checkout v0.5.17-perf.1
npm install
bench/build.sh

# After
ROUNDS=50 EVENTS_PER_ROUND=50000 node --expose-gc bench/out/recorder-bench.js \
  > bench/results/repro-after.json

# Before
git stash push -- src/state/recorder.ts
bench/build.sh
ROUNDS=50 EVENTS_PER_ROUND=50000 node --expose-gc bench/out/recorder-bench.js \
  > bench/results/repro-before.json
git stash pop
```

The summary block at the bottom of each JSON answers "did GC pauses
grow over the session?" — for `before.json` the ratio is ~10×, for
`after.json` it stays ~1×.
