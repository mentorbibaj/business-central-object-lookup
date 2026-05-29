import * as vscode from 'vscode';
import { ObjectCatalog } from './objectCatalog';
import { BusinessCentralObject } from './types';

const digitTriggers = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

type InsertContext = 'variableDeclaration' | 'objectReference';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const catalog = new ObjectCatalog(context.extensionUri);
  await loadCatalogWithStatus(catalog, false);

  const completionProvider = vscode.languages.registerCompletionItemProvider(
    { language: 'al' },
    new BusinessCentralObjectCompletionProvider(catalog),
    ...digitTriggers
  );

  const reloadCommand = vscode.commands.registerCommand('businessCentralObjectLookup.reloadCatalog', async () => {
    await loadCatalogWithStatus(catalog, true);
  });

  context.subscriptions.push(completionProvider, reloadCommand);
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
      table: 'DATABASE',
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

async function loadCatalogWithStatus(catalog: ObjectCatalog, showSuccess: boolean): Promise<void> {
  try {
    const result = await catalog.load();
    if (showSuccess) {
      const message = `Business Central object catalog reloaded: ${result.objectCount} objects from ${result.sourceCount} source(s).`;
      if (result.warnings.length > 0) {
        vscode.window.showWarningMessage(`${message} ${result.warnings.length} package(s) skipped.`);
        console.warn(`[Business Central Object Lookup] ${result.warnings.join('\n')}`);
      } else {
        vscode.window.showInformationMessage(message);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Business Central object catalog could not be loaded: ${message}`);
  }
}
