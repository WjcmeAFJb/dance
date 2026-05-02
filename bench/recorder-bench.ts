/**
 * Synthetic benchmark for `Recorder`.
 *
 * Tests the hypothesis that the recorder's data structures grow without bound
 * during long sessions and produce two observable problems:
 *  (a) heap pressure → growing GC pause time
 *  (b) lookups / iteration over the structures get slower over time.
 *
 * The benchmark plays back rounds of synthetic activity and measures
 *  - wall-clock per round
 *  - per-event latency at the start vs end of each round
 *  - heap size before and after each round
 *  - **GC pause cost** explicitly: `gc()` is called and the time it takes is
 *    a direct readout of how expensive the live-set is to walk.
 *
 * Run with `node --expose-gc`. If `--expose-gc` is not present `gc()` is
 * unavailable and we fall back to a no-op (still useful for the timing data).
 */

import * as vscode from "vscode";

import { Recorder } from "../src/state/recorder";
import { CommandDescriptor } from "../src/commands";

interface MockHooks {
  fireSelectionChange(e: unknown): void;
  fireTextDocumentChange(e: unknown): void;
  fireActiveEditorChange(e: unknown): void;
  setActiveTextEditor(e: unknown): void;
}

const mockHooks: MockHooks = (vscode as unknown as { __hooks: MockHooks }).__hooks;

const ROUNDS = parseInt(process.env["ROUNDS"] ?? "20", 10);
const EVENTS_PER_ROUND = parseInt(process.env["EVENTS_PER_ROUND"] ?? "10000", 10);
const SAMPLE_SIZE = 500;

type GCFn = () => void;
const gc: GCFn = (globalThis as unknown as { gc?: GCFn }).gc ?? (() => undefined);

interface RoundResult {
  round: number;
  totalEventsAfter: number;
  wallClockMs: number;
  perEventNs: number;
  startSampleNs: number;
  endSampleNs: number;
  heapUsedMB: number;
  rssMB: number;
  gcPauseMs: number;
  bufferLen: number;
  previousBuffersLen: number;
  storedObjectsLen: number;
  storedObjectsMapSize: number;
}

function buildFakeExtension() {
  const descriptors: CommandDescriptor[] = [];
  // Real extension has ~200 dance.* commands.
  for (let i = 0; i < 200; i++) {
    descriptors.push(new CommandDescriptor(`dance.fake.${i}`, () => undefined as unknown, 0 as never));
  }
  const commands: Record<string, CommandDescriptor> = {};
  for (const d of descriptors) commands[d.identifier] = d;

  const onModeDidChange = new vscode.EventEmitter<unknown>();
  const statusBar = {
    recordingSegment: { setContent(_t?: string) {}, content: undefined },
    activeModeSegment: { setContent(_t?: string) {} },
    countSegment: { setContent(_t?: string) {} },
    registerSegment: { setContent(_t?: string) {} },
    errorSegment: { setContent(_t?: string) {}, content: undefined },
    dispose() {},
  };

  return {
    descriptors,
    extensionLike: {
      statusBar,
      editors: { onModeDidChange: onModeDidChange.event },
      commands,
    },
  };
}

function makeFakeDocument(uri: unknown) {
  return {
    uri,
    fileName: "/tmp/fake",
    eol: 1,
    lineCount: 1000,
    getText(_r?: unknown) { return ""; },
    offsetAt(p: vscode.Position) { return p.line * 80 + p.character; },
    positionAt(o: number) { return new vscode.Position(Math.floor(o / 80), o % 80); },
    lineAt(_l: number) { return { text: "", range: new vscode.Range(0, 0, 0, 0) }; },
  };
}

function makeFakeEditor(uri: unknown, document: unknown, selections: vscode.Selection[]) {
  return {
    document,
    selections,
    visibleRanges: [new vscode.Range(0, 0, 1000, 0)],
    options: {},
    setDecorations() {},
  };
}

function buildSelection(line: number, character: number) {
  return new vscode.Selection(line, character, line, character);
}

function nowNs(): bigint { return process.hrtime.bigint(); }

// Pre-compute somewhat realistic snippets to insert. Mix of short and long,
// some unique each call, some repeated — mirrors real typing. Call site picks
// a fresh-or-cached snippet via index modulo, so we exercise both interning
// and growth.
const SNIPPETS: string[] = [];
for (let i = 0; i < 64; i++) {
  SNIPPETS.push(`x_${i.toString(16)}_${"abcdefgh"[(i * 7) % 8]}`);
}

function runRound(recorder: Recorder, round: number, editor: ReturnType<typeof makeFakeEditor>): RoundResult {
  const document = editor.document;
  const eventsTotal = EVENTS_PER_ROUND;
  const sampleSize = Math.min(SAMPLE_SIZE, Math.floor(eventsTotal / 4));
  const descriptors = (recorder as unknown as { _descriptors: CommandDescriptor[] })._descriptors;

  const sampleEvent = (i: number) => {
    const lineNum = (i % 100);
    const colNum = (i % 79);

    const selections = [buildSelection(lineNum, colNum)];
    editor.selections = selections;

    // Selection change: very frequent, fires on every cursor move.
    mockHooks.fireSelectionChange({
      textEditor: editor,
      selections,
      kind: 1, // Keyboard
    });

    // Text change every 2 events. Mix unique / repeating insertions.
    if (i % 2 === 0) {
      const isUnique = (i % 7) === 0;
      const text = isUnique
        ? `u${i}_${Math.random().toString(36).slice(2, 7)}` // unique → grows _storedObjects
        : SNIPPETS[i % SNIPPETS.length];                    // dedup → exercises Map.get
      mockHooks.fireTextDocumentChange({
        document,
        contentChanges: [{
          range: new vscode.Range(lineNum, colNum, lineNum, colNum),
          rangeLength: 0,
          rangeOffset: lineNum * 80 + colNum,
          text,
        }],
        reason: undefined,
      });
    }

    // Command record: in a real session, dispatched on every Dance keybinding
    // — i.e. nearly every keystroke. Fresh argument object each time.
    if (i % 3 === 0) {
      const descriptor = descriptors[(i / 3) % descriptors.length];
      recorder.recordCommand(descriptor, { count: i, register: undefined, fresh: true });
    }
  };

  // sample at start of round
  const startSampleStart = nowNs();
  for (let i = 0; i < sampleSize; i++) sampleEvent(i);
  const startSampleEnd = nowNs();
  const startSampleNs = Number(startSampleEnd - startSampleStart) / sampleSize;

  // bulk middle
  const wallStart = nowNs();
  for (let i = sampleSize; i < eventsTotal - sampleSize; i++) sampleEvent(i);
  const wallEnd = nowNs();

  // sample at end of round
  const endSampleStart = nowNs();
  for (let i = eventsTotal - sampleSize; i < eventsTotal; i++) sampleEvent(i);
  const endSampleEnd = nowNs();
  const endSampleNs = Number(endSampleEnd - endSampleStart) / sampleSize;

  // Forced GC: directly proportional to live-set size, so this is the cleanest
  // signal of the heap-growth-induced cost.
  const gcStart = nowNs();
  gc();
  const gcEnd = nowNs();
  const gcPauseMs = Number(gcEnd - gcStart) / 1e6;

  const totalNs = Number((wallEnd - wallStart) + (startSampleEnd - startSampleStart) + (endSampleEnd - endSampleStart));
  const wallClockMs = totalNs / 1e6;
  const perEventNs = totalNs / eventsTotal;

  const mem = process.memoryUsage();
  // Reach into private state. The shape is best-effort: depending on which
  // version of the recorder we benchmark, either `_storedObjects` is a
  // global array (legacy, before the fix) OR `_currentStore` is the
  // per-buffer store with `_bufferStores` mapping previous buffers to
  // their own per-buffer stores (after the fix).
  const rec = recorder as unknown as {
    _buffer: number[];
    _previousBuffers: number[][];
    _storedObjects?: unknown[];
    _storedObjectsMap?: Map<unknown, number>;
    _currentStore?: { storedObjects: unknown[]; storedObjectsMap: Map<unknown, number> };
    _bufferStores?: WeakMap<number[], { storedObjects: unknown[] }>;
  };

  let storedObjectsLen: number, storedObjectsMapSize: number;
  if (rec._currentStore !== undefined) {
    let total = 0;
    total += rec._currentStore.storedObjects.length;
    for (const buf of rec._previousBuffers) {
      total += rec._bufferStores!.get(buf)?.storedObjects.length ?? 0;
    }
    storedObjectsLen = total;
    storedObjectsMapSize = rec._currentStore.storedObjectsMap.size;
  } else {
    storedObjectsLen = rec._storedObjects!.length;
    storedObjectsMapSize = rec._storedObjectsMap!.size;
  }

  return {
    round,
    totalEventsAfter: (round + 1) * eventsTotal,
    wallClockMs,
    perEventNs,
    startSampleNs,
    endSampleNs,
    heapUsedMB: mem.heapUsed / 1024 / 1024,
    rssMB: mem.rss / 1024 / 1024,
    gcPauseMs,
    bufferLen: rec._buffer.length,
    previousBuffersLen: rec._previousBuffers.length,
    storedObjectsLen,
    storedObjectsMapSize,
  };
}

function main() {
  const { extensionLike } = buildFakeExtension();
  const uri = vscode.Uri.file("/tmp/bench.ts");
  const document = makeFakeDocument(uri);
  const editor = makeFakeEditor(uri, document, [buildSelection(0, 0)]);
  mockHooks.setActiveTextEditor(editor);

  const recorder = new Recorder(extensionLike as never);

  // Warmup
  runRound(recorder, -1, editor);

  // Force GC after warmup so the first measured round starts cleanly.
  gc();

  const results: RoundResult[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const result = runRound(recorder, r, editor);
    results.push(result);

    if (process.env["QUIET"] !== "1") {
      const ratio = result.endSampleNs / result.startSampleNs;
      const ratioFmt = ratio.toFixed(2);
      console.error(
        `r=${r.toString().padStart(2)} events=${result.totalEventsAfter.toString().padStart(8)} `
        + `wall=${result.wallClockMs.toFixed(1).padStart(7)}ms `
        + `perEv=${result.perEventNs.toFixed(0).padStart(5)}ns `
        + `s/e=${result.startSampleNs.toFixed(0).padStart(5)}/${result.endSampleNs.toFixed(0).padStart(5)} `
        + `(x${ratioFmt}) `
        + `gc=${result.gcPauseMs.toFixed(2).padStart(6)}ms `
        + `heap=${result.heapUsedMB.toFixed(1)}MB rss=${result.rssMB.toFixed(1)}MB `
        + `bufs=${result.previousBuffersLen.toString().padStart(3)} `
        + `objs=${result.storedObjectsLen.toString().padStart(7)}`,
      );
    }
  }

  process.stdout.write(JSON.stringify({
    rounds: ROUNDS,
    eventsPerRound: EVENTS_PER_ROUND,
    sampleSize: SAMPLE_SIZE,
    results,
    summary: {
      firstRoundPerEventNs: results[0].perEventNs,
      lastRoundPerEventNs: results[results.length - 1].perEventNs,
      slowdownRatio: results[results.length - 1].perEventNs / results[0].perEventNs,
      firstRoundEndSampleNs: results[0].endSampleNs,
      lastRoundEndSampleNs: results[results.length - 1].endSampleNs,
      sampleSlowdownRatio: results[results.length - 1].endSampleNs / results[0].endSampleNs,
      firstRoundGCMs: results[0].gcPauseMs,
      lastRoundGCMs: results[results.length - 1].gcPauseMs,
      gcSlowdownRatio: results[results.length - 1].gcPauseMs / Math.max(results[0].gcPauseMs, 0.0001),
      finalHeapUsedMB: results[results.length - 1].heapUsedMB,
      finalRssMB: results[results.length - 1].rssMB,
      finalStoredObjects: results[results.length - 1].storedObjectsLen,
      finalPreviousBuffersLen: results[results.length - 1].previousBuffersLen,
    },
  }, null, 2));
  process.stdout.write("\n");
}

main();
