import * as vscode from 'vscode';
import { ObjectCatalog } from './objectCatalog';
import { BusinessCentralObject } from './types';

const digitTriggers = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const autoReloadDelayInMs = 1500;

type InsertContext = 'variableDeclaration' | 'objectReference';
type CatalogChangeKind = 'update' | 'delete';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const catalog = new ObjectCatalog(context.extensionUri, context.globalStorageUri);
  const outputChannel = vscode.window.createOutputChannel('Business Central Object Lookup');
  const catalogReloader = new CatalogReloader(catalog, outputChannel);
  await catalogReloader.reload(false);

  const completionProvider = vscode.languages.registerCompletionItemProvider(
    { language: 'al' },
    new BusinessCentralObjectCompletionProvider(catalog),
    ...digitTriggers
  );

  const reloadCommand = vscode.commands.registerCommand('businessCentralObjectLookup.reloadCatalog', async () => {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Loading Business Central object catalog...',
        cancellable: false
      },
      async () => catalogReloader.reload(true)
    );
  });

  context.subscriptions.push(
    outputChannel,
    catalogReloader,
    completionProvider,
    reloadCommand,
    new CatalogWatcherManager(catalogReloader)
  );
}

export function deactivate(): void {}

class BusinessCentralObjectCompletionProvider implements vscode.CompletionItemProvider {
  public constructor(private readonly catalog: ObjectCatalog) {}

  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const range = document.getWordRangeAtPosition(position, /\d+/);
    if (!range) {
      return [];
    }

    const typedNumber = document.getText(range);
    if (!/^\d+$/.test(typedNumber)) {
      return [];
    }

    const objectId = Number(typedNumber);
    if (!Number.isSafeInteger(objectId)) {
      return [];
    }

    const insertContext = this.getInsertContext(document, position, range);
    return this.catalog
      .findById(objectId)
      .map((object) => this.createCompletionItem(object, range, insertContext));
  }

  private createCompletionItem(
    object: BusinessCentralObject,
    range: vscode.Range,
    insertContext: InsertContext
  ): vscode.CompletionItem {
    const effectiveInsertContext = insertContext === 'variableDeclaration' && this.canCreateVariableDeclaration(object.type)
      ? 'variableDeclaration'
      : 'objectReference';
    const insertText = effectiveInsertContext === 'variableDeclaration'
      ? this.formatVariableDeclaration(object)
      : this.formatObjectReference(object);
    const label = `${object.type} ${object.id} -> ${insertText}`;
    const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Reference);
    item.detail = `${object.type} object ${object.id}`;
    item.documentation = new vscode.MarkdownString(`Replace the object ID with \`${insertText}\`.`);
    item.insertText = insertText;
    item.range = range;
    item.sortText = `${object.type.padEnd(20, ' ')}${object.id.toString().padStart(10, '0')}`;
    return item;
  }

  private canCreateVariableDeclaration(type: string): boolean {
    return ['table', 'page', 'codeunit', 'report', 'xmlport', 'query', 'enum', 'interface']
      .includes(type.toLowerCase());
  }

  private getInsertContext(
    document: vscode.TextDocument,
    position: vscode.Position,
    range: vscode.Range
  ): InsertContext {
    const linePrefix = document.lineAt(position.line).text.slice(0, range.start.character);
    if (!/^\s*$/.test(linePrefix)) {
      return 'objectReference';
    }

    return this.isInsideVarBlock(document, position.line) ? 'variableDeclaration' : 'objectReference';
  }

  private isInsideVarBlock(document: vscode.TextDocument, lineNumber: number): boolean {
    const firstLineToCheck = Math.max(0, lineNumber - 200);

    for (let index = lineNumber; index >= firstLineToCheck; index -= 1) {
      const line = document.lineAt(index).text.trim().toLowerCase();
      if (line.length === 0 || line.startsWith('//')) {
        continue;
      }

      if (/^var\b/.test(line)) {
        return true;
      }

      if (/^(begin|procedure|local procedure|trigger|internal procedure|protected procedure|actions|layout|requestpage|keys|fieldgroups|fields)\b/.test(line)) {
        return false;
      }
    }

    return false;
  }

  private formatVariableDeclaration(object: BusinessCentralObject): string {
    const variableType = this.getVariableType(object.type);
    const variableName = this.toVariableName(object.name, object.type, object.id);
    const objectName = this.formatAlName(object.name);

    return `${variableName}: ${variableType} ${objectName};`;
  }

  private getVariableType(type: string): string {
    const normalizedType = type.toLowerCase();
    const typeNames: Record<string, string> = {
      table: 'Record',
      page: 'Page',
      codeunit: 'Codeunit',
      report: 'Report',
      xmlport: 'XmlPort',
      query: 'Query',
      enum: 'Enum',
      interface: 'Interface'
    };

    return typeNames[normalizedType] ?? type;
  }

  private formatObjectReference(object: BusinessCentralObject): string {
    const qualifier = this.getObjectReferenceQualifier(object.type);
    return `${qualifier}::${this.formatAlName(object.name)}`;
  }

  private getObjectReferenceQualifier(type: string): string {
    const normalizedType = type.toLowerCase();
    const qualifiers: Record<string, string> = {
      table: 'Database',
      page: 'Page',
      codeunit: 'Codeunit',
      report: 'Report',
      xmlport: 'XmlPort',
      query: 'Query',
      enum: 'Enum'
    };

    return qualifiers[normalizedType] ?? type;
  }

  private formatAlName(name: string): string {
    const escapedName = name.replaceAll('"', '""');
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${escapedName}"`;
  }

  private toVariableName(name: string, type: string, id: number): string {
    const words = name.match(/[A-Za-z0-9]+/g) ?? [];
    const variableName = words
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join('');

    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(variableName)) {
      return variableName;
    }

    return `${type.replace(/[^A-Za-z0-9_]/g, '')}${id}`;
  }
}

class CatalogReloader implements vscode.Disposable {
  private reloadTimer: NodeJS.Timeout | undefined;
  private isReloading = false;
  private pendingFullReload = false;
  private readonly pendingSourceChanges = new Map<string, { uri: vscode.Uri; kind: CatalogChangeKind }>();

  public constructor(
    private readonly catalog: ObjectCatalog,
    private readonly outputChannel: vscode.OutputChannel
  ) {}

  public scheduleFullReload(): void {
    this.pendingFullReload = true;
    this.schedule();
  }

  public scheduleSourceChange(uri: vscode.Uri, kind: CatalogChangeKind): void {
    this.pendingSourceChanges.set(uri.fsPath.toLowerCase(), { uri, kind });
    this.schedule();
  }

  private schedule(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }

    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.flushPendingChanges();
    }, autoReloadDelayInMs);
  }

  public async reload(showSuccess: boolean): Promise<void> {
    if (this.isReloading) {
      this.pendingFullReload = true;
      return;
    }

    this.isReloading = true;
    this.pendingFullReload = false;
    this.pendingSourceChanges.clear();

    try {
      const result = await this.catalog.load();
      this.reportResult('Business Central object catalog reloaded', result, showSuccess);
    } catch (error) {
      this.reportError(error, showSuccess);
    } finally {
      this.isReloading = false;

      if (this.pendingFullReload || this.pendingSourceChanges.size > 0) {
        this.schedule();
      }
    }
  }

  public dispose(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }
  }

  private async flushPendingChanges(): Promise<void> {
    if (this.pendingFullReload) {
      await this.reload(false);
      return;
    }

    const changes = [...this.pendingSourceChanges.values()];
    this.pendingSourceChanges.clear();

    if (changes.length === 0) {
      return;
    }

    if (this.isReloading) {
      for (const change of changes) {
        this.pendingSourceChanges.set(change.uri.fsPath.toLowerCase(), change);
      }
      return;
    }

    this.isReloading = true;

    try {
      let lastResult: Awaited<ReturnType<ObjectCatalog['updateSource']>> | undefined;
      for (const change of changes) {
        lastResult = change.kind === 'delete'
          ? this.catalog.deleteSource(change.uri)
          : await this.catalog.updateSource(change.uri);
      }

      if (lastResult) {
        this.reportResult(`Business Central object catalog updated from ${changes.length} changed file(s)`, lastResult, false);
      }
    } catch (error) {
      this.reportError(error, false);
    } finally {
      this.isReloading = false;

      if (this.pendingFullReload || this.pendingSourceChanges.size > 0) {
        this.schedule();
      }
    }
  }

  private reportResult(
    action: string,
    result: Awaited<ReturnType<ObjectCatalog['load']>>,
    showSuccess: boolean
  ): void {
    const message = `${action}: ${result.objectCount} objects from ${result.sourceCount} source(s).`;
    if (result.warnings.length > 0) {
      this.outputChannel.appendLine(`${message} ${result.warnings.length} package(s) skipped.`);
      for (const warning of result.warnings) {
        this.outputChannel.appendLine(warning);
      }

      if (showSuccess) {
        vscode.window.showWarningMessage(`${message} ${result.warnings.length} package(s) skipped.`);
      }
      return;
    }

    this.outputChannel.appendLine(message);
    if (showSuccess) {
      vscode.window.showInformationMessage(message);
    }
  }

  private reportError(error: unknown, showError: boolean): void {
    const message = error instanceof Error ? error.message : String(error);
    this.outputChannel.appendLine(`Business Central object catalog could not be loaded: ${message}`);
    if (showError) {
      vscode.window.showErrorMessage(`Business Central object catalog could not be loaded: ${message}`);
    }
  }
}

class CatalogWatcherManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private customCatalogWatcher: vscode.Disposable | undefined;

  public constructor(private readonly reloader: CatalogReloader) {
    this.watchWorkspaceFiles('**/*.al');
    this.watchWorkspaceFiles('**/*.app');
    this.resetCustomCatalogWatcher();

    this.disposables.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('businessCentralObjectLookup')) {
        return;
      }

      this.resetCustomCatalogWatcher();
      this.reloader.scheduleFullReload();
    }));
  }

  public dispose(): void {
    this.customCatalogWatcher?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private watchWorkspaceFiles(pattern: vscode.GlobPattern): void {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.disposables.push(
      watcher,
      watcher.onDidCreate((uri) => this.reloader.scheduleSourceChange(uri, 'update')),
      watcher.onDidChange((uri) => this.reloader.scheduleSourceChange(uri, 'update')),
      watcher.onDidDelete((uri) => this.reloader.scheduleSourceChange(uri, 'delete'))
    );
  }

  private resetCustomCatalogWatcher(): void {
    this.customCatalogWatcher?.dispose();
    this.customCatalogWatcher = this.createCustomCatalogWatcher();
  }

  private createCustomCatalogWatcher(): vscode.Disposable | undefined {
    const configuredPath = vscode.workspace
      .getConfiguration('businessCentralObjectLookup')
      .get<string>('catalogPath', '')
      .trim();

    if (!configuredPath) {
      return undefined;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return undefined;
    }

    const pattern = new vscode.RelativePattern(workspaceFolder, configuredPath.replaceAll('\\', '/'));
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    return vscode.Disposable.from(
      watcher,
      watcher.onDidCreate((uri) => this.reloader.scheduleSourceChange(uri, 'update')),
      watcher.onDidChange((uri) => this.reloader.scheduleSourceChange(uri, 'update')),
      watcher.onDidDelete((uri) => this.reloader.scheduleSourceChange(uri, 'delete'))
    );
  }
}
