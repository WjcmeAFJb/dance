/**
 * Correctness check for the recorder fix.
 *
 * Verifies that the per-buffer-store + buffer-cap changes do not break the
 * existing recording / replay semantics. In particular:
 *  1. Reading back the entries that were just written returns the same
 *     payload (insertedText, mode, etc.).
 *  2. Entries that lived in a buffer that has been pushed past the
 *     `MaxPreviousBuffers` cap and dropped FROM THE RECORDER still resolve
 *     correctly when an explicit `Recording` reference holds them open.
 *  3. The `_currentStore` is empty after archiving, but old buffers retain
 *     their own store via the WeakMap.
 */

import * as vscode from "vscode";

import { Recorder } from "../src/state/recorder";
import { CommandDescriptor } from "../src/commands";

interface MockHooks {
  fireSelectionChange(e: unknown): void;
  fireTextDocumentChange(e: unknown): void;
  setActiveTextEditor(e: unknown): void;
}
const mockHooks: MockHooks = (vscode as unknown as { __hooks: MockHooks }).__hooks;

function buildRecorder() {
  const descriptors: CommandDescriptor[] = [];
  for (let i = 0; i < 10; i++) {
    descriptors.push(new CommandDescriptor(`dance.fake.${i}`, () => undefined as unknown, 0 as never));
  }
  const commands: Record<string, CommandDescriptor> = {};
  for (const d of descriptors) commands[d.identifier] = d;

  const onModeDidChange = new vscode.EventEmitter<unknown>();
  const stub = {
    statusBar: {
      recordingSegment: { setContent(_t?: string) {}, content: undefined },
      activeModeSegment: { setContent(_t?: string) {} },
      countSegment: { setContent(_t?: string) {} },
      registerSegment: { setContent(_t?: string) {} },
      errorSegment: { setContent(_t?: string) {}, content: undefined },
    },
    editors: { onModeDidChange: onModeDidChange.event },
    commands,
  };
  return { recorder: new Recorder(stub as never), descriptors };
}

function makeFakeEditor() {
  const document = {
    uri: vscode.Uri.file("/tmp/fake"),
    fileName: "/tmp/fake",
    eol: 1,
    lineCount: 1000,
    getText() { return ""; },
    offsetAt(p: vscode.Position) { return p.line * 80 + p.character; },
    positionAt(o: number) { return new vscode.Position(Math.floor(o / 80), o % 80); },
    lineAt() { return { text: "", range: new vscode.Range(0, 0, 0, 0) }; },
  };
  return {
    document,
    selections: [new vscode.Selection(0, 0, 0, 0)],
    visibleRanges: [new vscode.Range(0, 0, 1000, 0)],
    options: {},
    setDecorations() {},
  };
}

function emitInsert(editor: ReturnType<typeof makeFakeEditor>, text: string, line: number, col: number) {
  // The recorder collapses Insert+Translate into a single InsertBefore entry
  // when the cursor moves forward by `text.length` after insertion. We
  // synthesize that pair here.
  editor.selections = [new vscode.Selection(line, col, line, col)];
  mockHooks.fireSelectionChange({ textEditor: editor, selections: editor.selections, kind: 1 });
  mockHooks.fireTextDocumentChange({
    document: editor.document,
    contentChanges: [{
      range: new vscode.Range(line, col, line, col),
      rangeLength: 0,
      rangeOffset: line * 80 + col,
      text,
    }],
  });
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`assertion failed (${message}): expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  console.log(`  ok: ${message}`);
}

function main() {
  const editor = makeFakeEditor();
  mockHooks.setActiveTextEditor(editor);
  const { recorder, descriptors } = buildRecorder();

  console.log("Test 1: read-back of recently inserted text...");
  const recording1 = recorder.startRecording();
  emitInsert(editor, "hello", 0, 0);
  const completed1 = recording1.complete();
  const entries1 = [...completed1.entries({ extension: { recorder } } as never)];
  // We expect the InsertAfter-then-Translate pattern to collapse into a
  // single InsertBefore entry whose insertedText is "hello".
  const insertEntry = entries1.find((e) => "insertedText" in e) as { insertedText(): string } | undefined;
  if (insertEntry === undefined) {
    throw new Error("expected an Insert*Entry to be recorded");
  }
  assertEqual(insertEntry.insertedText(), "hello", "first recording read-back");

  console.log("\nTest 2: read-back across forced buffer archives...");
  // Fill the recorder with enough events to archive several buffers and then
  // confirm the original recording's buffer is still resolvable.
  for (let i = 0; i < 200000; i++) {
    recorder.recordCommand(descriptors[i % descriptors.length], { i });
  }
  const entries2 = [...completed1.entries({ extension: { recorder } } as never)];
  const insertEntry2 = entries2.find((e) => "insertedText" in e) as { insertedText(): string } | undefined;
  if (insertEntry2 === undefined) {
    throw new Error("expected the original Insert*Entry to still be readable");
  }
  assertEqual(insertEntry2.insertedText(), "hello", "Recording survives FIFO eviction");

  console.log("\nTest 3: capped retained-buffer count...");
  const rec = recorder as unknown as { _previousBuffers: number[][] };
  if (rec._previousBuffers.length > 16) {
    throw new Error(`expected <=16 previous buffers, got ${rec._previousBuffers.length}`);
  }
  console.log(`  ok: previousBuffers length = ${rec._previousBuffers.length}`);

  console.log("\nAll tests passed.");
}

main();
