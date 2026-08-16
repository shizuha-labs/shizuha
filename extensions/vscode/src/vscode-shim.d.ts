declare module 'vscode' {
  export enum StatusBarAlignment { Left = 1, Right = 2 }
  export enum ViewColumn { Active = -1, Beside = -2, One = 1, Two = 2, Three = 3 }
  export interface Disposable { dispose(): unknown }
  export class EventEmitter<T> implements Disposable {
    event: Event<T>;
    fire(data: T): void;
    dispose(): unknown;
  }
  export type Event<T> = (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: Disposable[]) => Disposable;
  export enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }
  export class TreeItem {
    label?: string;
    description?: string | boolean;
    tooltip?: string;
    contextValue?: string;
    command?: Command;
    constructor(label: string, collapsibleState?: TreeItemCollapsibleState);
  }
  export interface Command { command: string; title: string; arguments?: unknown[] }
  export interface TreeDataProvider<T> {
    onDidChangeTreeData?: Event<T | undefined | null | void>;
    getTreeItem(element: T): TreeItem | Thenable<TreeItem>;
    getChildren(element?: T): T[] | Thenable<T[]>;
  }
  export interface StatusBarItem extends Disposable {
    text: string;
    tooltip?: string;
    command?: string;
    show(): void;
  }
  export interface Uri { toString(): string; fsPath: string; scheme: string; }
  export const Uri: {
    joinPath(base: Uri, ...pathSegments: string[]): Uri;
    file(path: string): Uri;
    parse(value: string): Uri;
  };
  export class Position {
    readonly line: number;
    readonly character: number;
    constructor(line: number, character: number);
  }
  export class Range {
    readonly start: Position;
    readonly end: Position;
    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
    constructor(start: Position, end: Position);
  }
  export class WorkspaceEdit {
    replace(uri: Uri, range: Range, newText: string): void;
    insert(uri: Uri, position: Position, newText: string): void;
    createFile(uri: Uri, options?: { overwrite?: boolean; ignoreIfExists?: boolean }): void;
    deleteFile(uri: Uri, options?: { recursive?: boolean }): void;
    renameFile(oldUri: Uri, newUri: Uri, options?: { overwrite?: boolean }): void;
  }
  export interface TextDocument {
    uri: Uri;
    fileName: string;
    isUntitled: boolean;
    languageId: string;
    lineCount: number;
    getText(): string;
    save(): Thenable<boolean>;
  }
  export interface WorkspaceFolder { uri: Uri }
  export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
  export interface WorkspaceConfiguration {
    get<T>(section: string): T | undefined;
    update(section: string, value: unknown, configurationTarget?: ConfigurationTarget): Thenable<void>;
  }
  export interface SecretStorage {
    get(key: string): Thenable<string | undefined>;
    store(key: string, value: string): Thenable<void>;
    delete(key: string): Thenable<void>;
  }
  export interface ExtensionContext { subscriptions: Disposable[]; extensionUri: Uri; secrets: SecretStorage }
  export interface Webview {
    html: string;
    cspSource: string;
    asWebviewUri(localResource: Uri): Uri;
    postMessage(message: unknown): Thenable<boolean>;
    onDidReceiveMessage(listener: (message: unknown) => unknown, thisArgs?: unknown, disposables?: Disposable[]): Disposable;
  }
  export interface WebviewPanel extends Disposable {
    webview: Webview;
    reveal(viewColumn?: ViewColumn): void;
    onDidDispose(listener: () => unknown, thisArgs?: unknown, disposables?: Disposable[]): Disposable;
  }
  export interface WebviewOptions {
    enableScripts?: boolean;
    localResourceRoots?: readonly Uri[];
  }
  export interface WebviewPanelOptions {
    retainContextWhenHidden?: boolean;
  }
  export const window: {
    createStatusBarItem(alignment: StatusBarAlignment, priority?: number): StatusBarItem;
    createWebviewPanel(viewType: string, title: string, showOptions: ViewColumn, options?: WebviewOptions & WebviewPanelOptions): WebviewPanel;
    showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    showErrorMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    showInputBox(options?: { title?: string; prompt?: string; value?: string; password?: boolean; ignoreFocusOut?: boolean; placeHolder?: string }): Thenable<string | undefined>;
    showQuickPick<T extends { label: string }>(items: readonly T[], options?: { placeHolder?: string; ignoreFocusOut?: boolean }): Thenable<T | undefined>;
    registerTreeDataProvider<T>(viewId: string, treeDataProvider: TreeDataProvider<T>): Disposable;
    showTextDocument(document: TextDocument, options?: { preview?: boolean; preserveFocus?: boolean }): Thenable<unknown>;
  };
  export const workspace: {
    readonly isTrusted: boolean;
    workspaceFolders?: readonly WorkspaceFolder[];
    getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined;
    getConfiguration(section?: string): WorkspaceConfiguration;
    openTextDocument(options?: { content?: string; language?: string }): Thenable<TextDocument>;
    openTextDocument(uri: Uri): Thenable<TextDocument>;
    applyEdit(edit: WorkspaceEdit): Thenable<boolean>;
  };
  export const commands: {
    registerCommand(command: string, callback: (...args: unknown[]) => unknown): Disposable;
    executeCommand(command: string, ...rest: unknown[]): Thenable<unknown>;
  };
}
