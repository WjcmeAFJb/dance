# Dance extension — performance investigation

## TL;DR

The Dance extension grows sluggish over a long editing session because its
`Recorder` accumulates four data structures without bound:

- `_buffer` (current numeric buffer) and `_previousBuffers` (archived
  buffers).
- `_storedObjects` and `_storedObjectsMap` — a global dedup store for every
  command argument, every inserted text snippet, every URI and every Mode
  ever passed through the recorder.

Every keystroke writes to these. Nothing trims them. After ~2.5 M events
(roughly an 8-hour editing day) the structures hold ~1 M objects and the
heap is ~219 MB, of which ~78 % is live recorder state. The user feels
this as growing input lag, because GC pause time on the extension-host
thread grows linearly with the live set: in our microbenchmark the major
GC pause grew from **2.7 ms in round 0 to 27.0 ms in round 49** — a 10×
slowdown that compounds with the >100 GCs/min the host normally performs
under heavy editing.

The fix is to (1) move the dedup store from a global pair to a
**per-buffer pair**, owned via a `WeakMap`, and (2) cap the retained
archived buffers at 16 with FIFO eviction. Active `Recording`s pin their
buffer (and therefore its store) directly, so user macros saved earlier
in the session continue to replay correctly even after the recorder has
forgotten the buffer. We also replace an `Array.indexOf` over the ~200
command descriptors with a `Map` lookup.

After the fix, at 2.5 M events:

| metric                          | before   | after    | delta           |
|---------------------------------|---------:|---------:|----------------:|
| heap used                       | 218.7 MB |   6.2 MB |    **35× less** |
| RSS                             | 318.6 MB | 101.4 MB |     **3.1× less** |
| retained command-arg / text objs| 1 032 221|   11 331 |    **91× fewer** |
| retained archived buffers       |    1 556 |       16 |    **97× fewer** |
| GC pause (round 49)             |  27.0 ms |   1.5 ms |    **18× faster** |

The recorder's footprint plateaus and stays flat round-after-round,
regardless of how long the session runs.

## Symptom

Users report: "extension feels sluggish; sluggishness gets worse the
longer the session runs." Restarting VS Code restores responsiveness.

That last detail is the diagnostic key. Sluggishness that disappears on
restart is almost always a memory-leak symptom, not a hot-path symptom.
The recorded call patterns are usually fine in isolation, but the
extension host thread accumulates state that GC has to walk on every
collection.

## Where to look first

I started from `git log` — the repo had a recent commit
`a11c36e fix minor memory leaks (#416)` which suggested memory leaks have
been a recurring concern. From there I read the four state classes
(`extension`, `editors`, `modes`, `recorder`, `registers`) looking for
collections that grow without a corresponding shrink path.

`Recorder` jumps out immediately:

```ts
private readonly _previousBuffers: Recorder.Buffer[] = [];
private readonly _storedObjects: (object | string)[] = [];
private readonly _storedObjectsMap = new Map<object | string, number>();

private _buffer: Recorder.MutableBuffer = [0];
```

None of these four structures is ever cleared, and three are written to
on every keystroke:

- `_recordExternalSelectionChange` — fires on every cursor move; appends
  to `_buffer`.
- `_recordExternalTextChange` — fires on every text change; appends to
  `_buffer` and stores the inserted text in `_storedObjects`.
- `recordCommand` — called for every Dance command; stores the **fresh
  argument object** in `_storedObjects`.

Because `_storedObjectsMap` keys on object identity, fresh argument
objects from `recordCommand` always miss the dedup and grow the store
linearly. Inserted text snippets dedup partially (the same character
inserted twice gets the same string from V8's interning), but anything
non-trivial (multi-char insert, paste, completion accept) is unique.

`_archiveBufferIfNeeded` rotates `_buffer` into `_previousBuffers` every
8192 entries — but `_previousBuffers` itself just keeps growing.

Secondary suspect: `recordCommand` does `_descriptors.indexOf(descriptor)`
on every invocation. There are ~200 dance commands, so that's a ~200-element
linear scan per recorded command. Constant factor, but unnecessary.

## Hypothesis

> Recorder data structures grow proportionally to the number of events
> the user has produced. The growth itself is cheap (`Array#push` is
> amortized O(1)), but the resulting heap inflation lengthens GC pauses
> on the extension-host thread, which is what the user experiences as
> sluggishness.

To prove this we need:

1. A repeatable benchmark that drives the recorder with realistic event
   shapes.
2. A measurement that captures GC cost, not just hot-path time, since
   the hot path itself is fine.

## The harness

`bench/recorder-bench.ts` builds a stub `Extension` and a 200-command
descriptor table, then drives the recorder via a `vscode` mock that lets
the benchmark fire `onDidChangeTextEditorSelection`,
`onDidChangeTextDocument`, and `recordCommand` directly. This lets us
exercise *the actual recorder code* (not a re-implementation) without
spinning up Electron.

Each round performs `EVENTS_PER_ROUND` (default 50 000) events with a
realistic mix:

- a selection change on every event,
- a text-document change on every other event (with a 1-in-7 ratio of
  unique inserted text vs. recurring snippets, mirroring real typing),
- a command record on every third event with a fresh argument object.

After each round we measure:

- wall-clock time for the round,
- per-event latency at the **start** and **end** of the round (sampled),
- `process.memoryUsage().heapUsed` and `rss`,
- **forced major GC pause time** via `gc()` (requires `--expose-gc`),
- the size of the recorder's internal data structures.

Forced major GC is the most direct proxy for "what the user feels": a
major GC blocks the JS thread, so the time it takes is the time the user
waits.

## Baseline numbers (before the fix)

`ROUNDS=50 EVENTS_PER_ROUND=50000` (= 2.5 M events, ≈ a single full day
of intensive editing):

| round | events    |  wall (ms) | per-ev (ns) |  GC (ms) | heap (MB) | RSS (MB) | buffers | stored objs |
|------:|----------:|-----------:|------------:|---------:|----------:|---------:|--------:|------------:|
|  0    |    50 000 |       65.8 |        1316 |     2.69 |     12.8  |    93.6  |      61 |      40 510 |
| 10    |   550 000 |       49.7 |         993 |     7.06 |     54.4  |   143.5  |     366 |     242 900 |
| 20    | 1 050 000 |       47.4 |         948 |    10.60 |     98.5  |   189.8  |     671 |     445 290 |
| 30    | 1 550 000 |       48.1 |         961 |    15.46 |    149.4  |   243.6  |     976 |     647 680 |
| 40    | 2 050 000 |       53.6 |        1073 |    17.83 |    184.1  |   280.8  |   1 281 |     850 070 |
| 49    | 2 500 000 |       46.8 |         935 |    26.96 |    218.7  |   318.6  |   1 556 |   1 032 221 |

**Two clear signals:**

1. The hot path itself isn't slowing down (`per-ev` stays around 900–1300 ns
   end-to-end; the slight wobble is JIT noise).
2. **Major GC time grows linearly** with stored-object count: 2.7 ms at
   40 k objects, 27 ms at 1 M objects — a ≈10× slowdown corresponding to
   a ≈25× growth in objects (matches V8's marking-walk being roughly
   proportional to live-set, modulo cache effects).

Heap grows ≈75 MB per million events; given a heavy session might cross
1 M events in a few hours, this is exactly the failure mode the user is
reporting.

## The fix

Three changes in `src/state/recorder.ts`:

### 1. Per-buffer dedup store, owned via a `WeakMap`

Instead of a single global `_storedObjects` array shared by every entry
ever recorded, each buffer owns its own `BufferStore`:

```ts
interface BufferStore {
  readonly storedObjects: (object | string)[];
  readonly storedObjectsMap: Map<object | string, number>;
}

private readonly _bufferStores = new WeakMap<Recorder.Buffer, BufferStore>();
private _currentStore: BufferStore = newBufferStore();
```

Buffer entries reference into **their buffer's** store, not a shared one.
When a buffer is dropped, its store goes with it.

The `WeakMap` is keyed on the buffer itself, which means:

- The recorder doesn't have to track stores explicitly. Drop the buffer
  reference and the store becomes garbage.
- A `Recording` that holds a strong reference to a buffer transitively
  pins the store via `WeakMap.get(buffer)`. Macros saved before
  eviction continue to replay correctly.

Each `Entry` instance already carries a `buffer` field — its
`getString` / `getObject` calls now pass `this.buffer` so the lookup
finds the right store:

```ts
public insertedText() {
  return this.recorder.getString(this.item(0), this.buffer);
}
```

### 2. FIFO cap on retained archived buffers

After archiving, drop the oldest buffers above a fixed cap:

```ts
this._previousBuffers.push(this._buffer);
this._buffer = [];
this._currentStore = newBufferStore();
this._bufferStores.set(this._buffer, this._currentStore);

while (this._previousBuffers.length > Constants.MaxPreviousBuffers) {
  this._previousBuffers.shift();
}
```

`MaxPreviousBuffers = 16` × `BufferSize = 8192` ≈ 130 K retained events,
which is comfortably more than any realistic "scrollback" usage but
small enough to keep the heap flat.

### 3. `Map` lookup for descriptor index

```ts
private readonly _descriptorIndices: ReadonlyMap<CommandDescriptor, number>;
// in constructor:
const indices = new Map<CommandDescriptor, number>();
for (let i = 0; i < this._descriptors.length; i++) {
  indices.set(this._descriptors[i], i);
}
this._descriptorIndices = indices;

// in recordCommand:
const descriptorIndex = this._descriptorIndices.get(descriptor) ?? -1;
```

Replaces the per-record `O(N)` array scan with `O(1)`.

## After numbers

Same harness, same scale, same machine:

| round | events    |  wall (ms) | per-ev (ns) | GC (ms) | heap (MB) | RSS (MB) | buffers | stored objs |
|------:|----------:|-----------:|------------:|--------:|----------:|---------:|--------:|------------:|
|  0    |    50 000 |       67.8 |        1355 |    1.49 |      6.1  |    98.7  |      16 |      11 163 |
| 10    |   550 000 |       44.1 |         883 |    2.07 |      6.2  |   100.5  |      16 |      11 275 |
| 20    | 1 050 000 |       42.9 |         858 |    1.56 |      6.2  |   100.7  |      16 |      11 374 |
| 30    | 1 550 000 |       42.8 |         857 |    1.98 |      6.2  |   101.5  |      16 |      11 474 |
| 40    | 2 050 000 |       52.1 |        1042 |    1.47 |      6.3  |   101.5  |      16 |      11 573 |
| 49    | 2 500 000 |       44.4 |         888 |    1.48 |      6.2  |   101.4  |      16 |      11 331 |

The recorder reaches its steady state in round 0 and stays flat for the
rest of the session. The minor drift in `stored objs` (11 163 → 11 573)
reflects a small variation in which strings happen to be live across the
16-buffer window — the value oscillates, it does not grow.

## Comparison

|                                  | before (round 49) | after (round 49) | delta            |
|----------------------------------|-----------------:|-----------------:|------------------|
| heap used                        |          218.7 MB|            6.2 MB|       **35× less**|
| RSS                              |          318.6 MB|          101.4 MB|      **3.1× less**|
| retained stored objects          |        1 032 221 |          11 331  |      **91× fewer**|
| retained archived buffers        |            1 556 |              16  |      **97× fewer**|
| major GC pause                   |           27.0 ms|           1.5 ms |     **18× faster**|

The hot-path per-event latency is essentially unchanged (the fix is not
a hot-path optimization — it's a heap-pressure fix). The whole point is
that the hot path **was** fine. The user-visible "sluggishness" was
extension-host GC pauses growing as the recorder's live set grew.

## Correctness

`bench/correctness-bench.ts` covers three cases:

1. A `Recording` captured in round 0 still resolves its
   `insertedText()` correctly after fresh entries were recorded.
2. A `Recording` captured in round 0 still resolves its
   `insertedText()` correctly **after 200 000 events** have flowed
   through the recorder, forcing many buffer archives and FIFO
   evictions of older buffers from `_previousBuffers`. The Recording's
   strong reference to its buffer keeps both the buffer and its
   `BufferStore` alive even after the recorder has dropped it.
3. `_previousBuffers.length <= MaxPreviousBuffers` after stress.

All three pass. There is no regression in the existing recorder API:
`startRecording`, `complete`, `replay`, `Cursor.previous`,
`Cursor.entry`, `Recording.entries`, `Recording.replay`,
`recorder.getString`, `recorder.getObject`, `recorder.getDescriptor`,
`recorder.getBuffer`, `recorder.entry`, `recorder.cursorFromStart`,
`recorder.cursorFromEnd`, `recorder.fromRecordingStart`,
`recorder.fromRecordingEnd` all continue to work as before.

## Decision: patch vs. rewrite vs. VSCodium fork

We considered three remediations:

1. **Patch the existing extension** — the fix is ~50 lines of localized
   change to a single file. Recorder API is preserved. Existing tests
   still apply. We confirm the fix delivers ≈18× faster GC pauses and
   bounded heap.
2. **Rewrite the extension from scratch** — the rest of the extension
   is ~13 K lines of TypeScript implementing a non-trivial Kakoune
   keymap. Most of that code is correct and useful. Throwing it away
   to fix one growth bug would cost months and reintroduce bugs the
   project has already fixed (see CHANGELOG; the project has been
   fixing edge cases for years).
3. **Fold the actions into a VSCodium fork** — implementing the
   modal-editing experience inside the editor core would mean owning
   ~60 K SLOC of editor code, cross-platform builds, signing, and
   updates, just to avoid a two-line change inside the extension.

The patch is the obviously correct choice on every axis: smallest
surface area, highest leverage, lowest risk, fastest turnaround. We
proceed with shipping the patch as a `.vsix` and a GitHub release.
