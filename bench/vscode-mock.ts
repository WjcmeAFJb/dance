/**
 * Minimal `vscode` mock that exposes hook points so a benchmark can fire the
 * events the Recorder cares about. Anything outside the Recorder's reach is
 * either a no-op or a stub returning empty values.
 *
 * The hooks (`__hooks`) are how the benchmark drives the recorder: it calls
 * `__hooks.fireSelectionChange(event)` and the listener registered by the
 * recorder runs synchronously.
 */

class MockEvent<T> {
  public readonly listeners: Array<(arg: T) => void> = [];

  public emit(arg: T): void {
    for (let i = 0, len = this.listeners.length; i < len; i++) {
      this.listeners[i](arg);
    }
  }
}

class EventEmitter<T> {
  private readonly _ev = new MockEvent<T>();
  public readonly event = (handler: (arg: T) => void, thisArg?: unknown, disposables?: { dispose(): void }[]) => {
    const bound = thisArg ? handler.bind(thisArg) : handler;
    this._ev.listeners.push(bound);
    const disposable = { dispose: () => {
      const idx = this._ev.listeners.indexOf(bound);
      if (idx >= 0) this._ev.listeners.splice(idx, 1);
    }};
    if (disposables) disposables.push(disposable);
    return disposable;
  };
  public fire(arg: T): void { this._ev.emit(arg); }
  public dispose(): void {}
}

class Disposable {
  public static from(...d: { dispose(): void }[]) { return { dispose() { d.forEach((x) => x.dispose()); } }; }
  public constructor(private readonly _fn: () => void) {}
  public dispose(): void { this._fn(); }
}

class CancellationTokenSource {
  private readonly _onCancel = new EventEmitter<void>();
  public readonly token = {
    isCancellationRequested: false,
    onCancellationRequested: this._onCancel.event,
  };
  public cancel(): void { (this.token as { isCancellationRequested: boolean }).isCancellationRequested = true; this._onCancel.fire(); }
  public dispose(): void {}
}

class Position {
  public constructor(public readonly line: number, public readonly character: number) {}
  public isEqual(o: Position): boolean { return this.line === o.line && this.character === o.character; }
  public isBefore(o: Position): boolean { return this.line < o.line || (this.line === o.line && this.character < o.character); }
  public isAfter(o: Position): boolean { return this.line > o.line || (this.line === o.line && this.character > o.character); }
  public isBeforeOrEqual(o: Position): boolean { return !this.isAfter(o); }
  public isAfterOrEqual(o: Position): boolean { return !this.isBefore(o); }
  public translate(l = 0, c = 0): Position { return new Position(this.line + l, this.character + c); }
  public with(l?: number, c?: number): Position { return new Position(l ?? this.line, c ?? this.character); }
  public compareTo(o: Position): number { return this.line !== o.line ? this.line - o.line : this.character - o.character; }
}

class Range {
  public readonly start: Position;
  public readonly end: Position;
  public constructor(s: Position, e: Position);
  public constructor(sl: number, sc: number, el: number, ec: number);
  public constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    if (typeof a === "number") {
      this.start = new Position(a, b as number);
      this.end = new Position(c as number, d as number);
    } else {
      this.start = a;
      this.end = b as Position;
    }
  }
  public get isEmpty(): boolean { return this.start.line === this.end.line && this.start.character === this.end.character; }
  public get isSingleLine(): boolean { return this.start.line === this.end.line; }
  public contains(p: Position | Range): boolean {
    if (p instanceof Position) return p.isAfterOrEqual(this.start) && p.isBeforeOrEqual(this.end);
    return p.start.isAfterOrEqual(this.start) && p.end.isBeforeOrEqual(this.end);
  }
}

class Selection extends Range {
  public readonly anchor: Position;
  public readonly active: Position;
  public constructor(a: Position, b: Position);
  public constructor(al: number, ac: number, bl: number, bc: number);
  public constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    let anchor: Position, active: Position;
    if (typeof a === "number") {
      anchor = new Position(a, b as number);
      active = new Position(c as number, d as number);
    } else {
      anchor = a;
      active = b as Position;
    }
    super(anchor.isBeforeOrEqual(active) ? anchor : active, anchor.isBeforeOrEqual(active) ? active : anchor);
    this.anchor = anchor;
    this.active = active;
  }
  public get isReversed(): boolean { return this.anchor.isAfter(this.active); }
}

const onDidChangeActiveTextEditor = new EventEmitter<unknown>();
const onDidChangeTextEditorSelection = new EventEmitter<unknown>();
const onDidChangeTextEditorVisibleRanges = new EventEmitter<unknown>();
const onDidChangeVisibleTextEditors = new EventEmitter<unknown[]>();
const onDidChangeConfiguration = new EventEmitter<unknown>();
const onDidChangeTextDocument = new EventEmitter<unknown>();
const onDidOpenTextDocument = new EventEmitter<unknown>();
const onDidCloseTextDocument = new EventEmitter<unknown>();

let activeTextEditor: unknown = undefined;

const exportedNamespace = {
  Disposable,
  EventEmitter,
  CancellationTokenSource,
  Position,
  Range,
  Selection,
  Uri: {
    parse(s: string) { return { toString() { return s; }, scheme: "file", path: s, fsPath: s }; },
    file(p: string) { return { toString() { return `file://${p}`; }, scheme: "file", path: p, fsPath: p }; },
  },
  EndOfLine: { LF: 1, CRLF: 2 },
  TextEditorCursorStyle: { Line: 1, Block: 2, Underline: 3, LineThin: 4, BlockOutline: 5, UnderlineThin: 6 },
  TextEditorLineNumbersStyle: { Off: 0, On: 1, Relative: 2 },
  TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
  TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2, Command: 3 },
  ThemeColor: class { public constructor(public readonly id: string) {} },
  ThemeIcon: class { public constructor(public readonly id: string) {} },
  TreeItem: class { public constructor(public readonly label: string) {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  commands: {
    registerCommand(_id: string, _handler: (...args: unknown[]) => unknown) { return new Disposable(() => undefined); },
    executeCommand<T>(_id: string, ..._args: unknown[]) { return Promise.resolve(undefined as unknown as T); },
    getCommands(_filter?: boolean) { return Promise.resolve([] as string[]); },
  },
  window: {
    get activeTextEditor() { return activeTextEditor; },
    set activeTextEditor(v: unknown) { activeTextEditor = v; },
    visibleTextEditors: [] as unknown[],
    onDidChangeActiveTextEditor: onDidChangeActiveTextEditor.event,
    onDidChangeTextEditorSelection: onDidChangeTextEditorSelection.event,
    onDidChangeTextEditorVisibleRanges: onDidChangeTextEditorVisibleRanges.event,
    onDidChangeVisibleTextEditors: onDidChangeVisibleTextEditors.event,
    createStatusBarItem() { return { text: "", tooltip: undefined, show() {}, hide() {}, dispose() {} }; },
    showInformationMessage(_m: string) { return Promise.resolve(undefined); },
    showWarningMessage(_m: string) { return Promise.resolve(undefined); },
    showErrorMessage(_m: string) { return Promise.resolve(undefined); },
    showInputBox() { return Promise.resolve(undefined); },
    showQuickPick() { return Promise.resolve(undefined); },
    createTextEditorDecorationType(_o: unknown) { return { key: Math.random().toString(), dispose() {} }; },
    createTreeView(_id: string, _o: unknown) { return { dispose() {} }; },
  },
  workspace: {
    workspaceFolders: undefined as unknown,
    isTrusted: true,
    getConfiguration() {
      return {
        get(_k: string, dv?: unknown) { return dv; },
        inspect(_k: string) { return { defaultValue: undefined, globalValue: undefined, workspaceValue: undefined, workspaceFolderValue: undefined }; },
        update(_k: string, _v: unknown) { return Promise.resolve(); },
      };
    },
    onDidChangeConfiguration: onDidChangeConfiguration.event,
    onDidChangeTextDocument: onDidChangeTextDocument.event,
    onDidOpenTextDocument: onDidOpenTextDocument.event,
    onDidCloseTextDocument: onDidCloseTextDocument.event,
    openTextDocument() { return Promise.reject(new Error("not implemented in mock")); },
  },
  extensions: {
    all: [] as unknown[],
    getExtension(_id: string) { return undefined; },
  },
  env: {
    clipboard: {
      readText() { return Promise.resolve(""); },
      writeText(_t: string) { return Promise.resolve(); },
    },
    remoteName: undefined,
  },
  // Hooks used by the benchmark to drive the recorder.
  __hooks: {
    fireSelectionChange(e: unknown) { onDidChangeTextEditorSelection.fire(e); },
    fireTextDocumentChange(e: unknown) { onDidChangeTextDocument.fire(e); },
    fireActiveEditorChange(e: unknown) { onDidChangeActiveTextEditor.fire(e); },
    setActiveTextEditor(e: unknown) { activeTextEditor = e; },
  },
};

module.exports = exportedNamespace;
