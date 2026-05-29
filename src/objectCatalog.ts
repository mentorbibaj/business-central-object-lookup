import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import * as yauzl from 'yauzl';
import { BusinessCentralObject } from './types';

const alObjectDeclaration =
  /^\s*(table|tableextension|page|pageextension|pagecustomization|codeunit|report|xmlport|query|enum|enumextension|interface|controladdin|profile|permissionset|permissionsetextension)\s+(\d+)\s+("[^"]+"|[^\r\n{]+)/gim;

interface CatalogLoadResult {
  objectCount: number;
  sourceCount: number;
  warnings: string[];
}

export class ObjectCatalog {
  private objectsById = new Map<number, BusinessCentralObject[]>();

  public constructor(private readonly extensionUri: vscode.Uri) {}

  public async load(): Promise<CatalogLoadResult> {
    const objects: BusinessCentralObject[] = [];
    const sources = new Set<string>();
    const warnings: string[] = [];
    const config = vscode.workspace.getConfiguration('businessCentralObjectLookup');

    if (config.get<boolean>('scanWorkspace', true)) {
      const workspaceObjects = await this.loadWorkspaceObjects(sources, warnings);
      objects.push(...workspaceObjects);
    }

    const configuredCatalog = this.getConfiguredCatalogPath();
    if (configuredCatalog) {
      objects.push(...await this.loadJsonCatalog(configuredCatalog, configuredCatalog.fsPath));
      sources.add(configuredCatalog.fsPath);
    }

    if (config.get<boolean>('includeBundledCatalog', false) || objects.length === 0) {
      const bundledCatalog = vscode.Uri.joinPath(this.extensionUri, 'data', 'businessCentralObjects.json');
      objects.push(...await this.loadJsonCatalog(bundledCatalog, 'bundled catalog'));
      sources.add('bundled catalog');
    }

    this.rebuildIndex(objects);
    return {
      objectCount: [...this.objectsById.values()].reduce((count, entries) => count + entries.length, 0),
      sourceCount: sources.size,
      warnings
    };
  }

  public findById(id: number): BusinessCentralObject[] {
    return this.objectsById.get(id) ?? [];
  }

  private async loadWorkspaceObjects(
    sources: Set<string>,
    warnings: string[]
  ): Promise<BusinessCentralObject[]> {
    const [alFiles, appFiles] = await Promise.all([
      vscode.workspace.findFiles('**/*.al', '**/{node_modules,dist,.git}/**'),
      vscode.workspace.findFiles('**/*.app', '**/{node_modules,dist,.git}/**')
    ]);

    const alObjects = await Promise.all(alFiles.map(async (uri) => {
      const text = await fs.readFile(uri.fsPath, 'utf8');
      const objects = this.parseAlObjects(text, uri.fsPath);
      if (objects.length > 0) {
        sources.add(uri.fsPath);
      }
      return objects;
    }));

    const appObjects = await Promise.all(appFiles.map(async (uri) => {
      try {
        const objects = await this.parseAppPackage(uri.fsPath);
        if (objects.length > 0) {
          sources.add(uri.fsPath);
        }
        return objects;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Skipped ${path.basename(uri.fsPath)}: ${message}`);
        return [];
      }
    }));

    return [...alObjects, ...appObjects].flat();
  }

  private parseAlObjects(text: string, source: string): BusinessCentralObject[] {
    const objects: BusinessCentralObject[] = [];

    for (const match of text.matchAll(alObjectDeclaration)) {
      const type = this.toBusinessCentralType(match[1]);
      const id = Number(match[2]);
      const name = this.cleanAlObjectName(match[3]);

      if (name.length > 0 && Number.isSafeInteger(id)) {
        objects.push({ type, id, name, source });
      }
    }

    return objects;
  }

  private async parseAppPackage(filePath: string): Promise<BusinessCentralObject[]> {
    const zip = await this.openZip(filePath);

    return new Promise((resolve, reject) => {
      const objects: BusinessCentralObject[] = [];

      zip.readEntry();

      zip.on('entry', (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName) || !/symbol.*\.json$/i.test(entry.fileName)) {
          zip.readEntry();
          return;
        }

        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            reject(error);
            return;
          }

          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            try {
              const json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
              objects.push(...this.extractObjectsFromSymbolJson(json, filePath));
              zip.readEntry();
            } catch (error) {
              reject(error);
            }
          });
        });
      });

      zip.on('end', () => resolve(objects));
      zip.on('error', reject);
    });
  }

  private openZip(filePath: string): Promise<yauzl.ZipFile> {
    return new Promise((resolve, reject) => {
      yauzl.open(filePath, { lazyEntries: true }, (error, zip) => {
        if (error || !zip) {
          reject(error);
          return;
        }

        resolve(zip);
      });
    });
  }

  private extractObjectsFromSymbolJson(value: unknown, source: string): BusinessCentralObject[] {
    const objects: BusinessCentralObject[] = [];
    this.walkJson(value, undefined, (node, parentKey) => {
      const object = this.tryReadSymbolObject(node, source, parentKey);
      if (object) {
        objects.push(object);
      }
    });
    return objects;
  }

  private tryReadSymbolObject(
    value: unknown,
    source: string,
    parentKey: string | undefined
  ): BusinessCentralObject | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const candidate = value as Record<string, unknown>;
    const rawType = this.getFirstString(candidate, ['type', 'Type', 'objectType', 'ObjectType'])
      ?? this.typeFromSymbolArrayName(parentKey);
    const id = this.getFirstNumber(candidate, ['id', 'Id', 'objectId', 'ObjectId']);
    const name = this.getFirstString(candidate, ['name', 'Name', 'objectName', 'ObjectName']);

    if (!rawType || id === undefined || !name || !this.isKnownObjectType(rawType)) {
      return undefined;
    }

    return {
      type: this.toBusinessCentralType(rawType),
      id,
      name: name.trim(),
      source
    };
  }

  private walkJson(
    value: unknown,
    parentKey: string | undefined,
    visit: (value: unknown, parentKey: string | undefined) => void
  ): void {
    visit(value, parentKey);

    if (Array.isArray(value)) {
      for (const item of value) {
        this.walkJson(item, parentKey, visit);
      }
      return;
    }

    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        this.walkJson(item, key, visit);
      }
    }
  }

  private async loadJsonCatalog(uri: vscode.Uri, source: string): Promise<BusinessCentralObject[]> {
    const rawCatalog = await fs.readFile(uri.fsPath, 'utf8');
    const parsedCatalog = JSON.parse(rawCatalog) as unknown;
    return this.normalizeCatalog(parsedCatalog, source);
  }

  private rebuildIndex(objects: BusinessCentralObject[]): void {
    const uniqueObjects = new Map<string, BusinessCentralObject>();

    for (const object of objects) {
      const key = `${object.type.toLowerCase()}:${object.id}:${object.name.toLowerCase()}`;
      uniqueObjects.set(key, object);
    }

    this.objectsById.clear();
    for (const object of uniqueObjects.values()) {
      const entries = this.objectsById.get(object.id) ?? [];
      entries.push(object);
      entries.sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
      this.objectsById.set(object.id, entries);
    }
  }

  private getConfiguredCatalogPath(): vscode.Uri | undefined {
    const configuredPath = vscode.workspace
      .getConfiguration('businessCentralObjectLookup')
      .get<string>('catalogPath', '')
      .trim();

    if (!configuredPath) {
      return undefined;
    }

    if (path.isAbsolute(configuredPath)) {
      return vscode.Uri.file(configuredPath);
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return undefined;
    }

    return vscode.Uri.joinPath(workspaceFolder.uri, configuredPath);
  }

  private normalizeCatalog(value: unknown, source: string): BusinessCentralObject[] {
    if (!Array.isArray(value)) {
      throw new Error('Catalog must be a JSON array.');
    }

    return value.map((entry, index) => {
      if (!this.isCatalogEntry(entry)) {
        throw new Error(`Catalog entry at index ${index} must contain type, id, and name.`);
      }

      return {
        type: this.toBusinessCentralType(entry.type),
        id: entry.id,
        name: entry.name.trim(),
        source
      };
    });
  }

  private isCatalogEntry(value: unknown): value is BusinessCentralObject {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const candidate = value as Partial<BusinessCentralObject>;
    return typeof candidate.type === 'string'
      && typeof candidate.id === 'number'
      && Number.isInteger(candidate.id)
      && typeof candidate.name === 'string'
      && candidate.type.trim().length > 0
      && candidate.name.trim().length > 0;
  }

  private cleanAlObjectName(value: string): string {
    const trimmed = value.trim();
    const quotedName = /^"([^"]+)"/.exec(trimmed);
    if (quotedName) {
      return quotedName[1].trim();
    }

    return trimmed
      .replace(/\s+(extends|implements)\s+.*$/i, '')
      .trim()
      .replace(/;$/, '');
  }

  private getFirstString(candidate: Record<string, unknown>, names: string[]): string | undefined {
    for (const name of names) {
      const value = candidate[name];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }
    }

    return undefined;
  }

  private getFirstNumber(candidate: Record<string, unknown>, names: string[]): number | undefined {
    for (const name of names) {
      const value = candidate[name];
      if (typeof value === 'number' && Number.isInteger(value)) {
        return value;
      }

      if (typeof value === 'string' && /^\d+$/.test(value)) {
        return Number(value);
      }
    }

    return undefined;
  }

  private typeFromSymbolArrayName(name: string | undefined): string | undefined {
    if (!name) {
      return undefined;
    }

    const symbolArrays: Record<string, string> = {
      tables: 'Table',
      tableextensions: 'TableExtension',
      pages: 'Page',
      pageextensions: 'PageExtension',
      pagecustomizations: 'PageCustomization',
      codeunits: 'Codeunit',
      reports: 'Report',
      xmlports: 'XMLPort',
      queries: 'Query',
      enums: 'Enum',
      enumextensions: 'EnumExtension',
      interfaces: 'Interface',
      controladdins: 'ControlAddIn',
      profiles: 'Profile',
      permissionsets: 'PermissionSet',
      permissionsetextensions: 'PermissionSetExtension'
    };

    return symbolArrays[name.replace(/\s/g, '').toLowerCase()];
  }

  private isKnownObjectType(type: string): boolean {
    return [
      'table',
      'tableextension',
      'page',
      'pageextension',
      'pagecustomization',
      'codeunit',
      'report',
      'xmlport',
      'query',
      'enum',
      'enumextension',
      'interface',
      'controladdin',
      'profile',
      'permissionset',
      'permissionsetextension'
    ].includes(type.replace(/\s/g, '').toLowerCase());
  }

  private toBusinessCentralType(type: string): string {
    const normalizedType = type.replace(/\s/g, '').toLowerCase();
    const displayNames: Record<string, string> = {
      table: 'Table',
      tableextension: 'TableExtension',
      page: 'Page',
      pageextension: 'PageExtension',
      pagecustomization: 'PageCustomization',
      codeunit: 'Codeunit',
      report: 'Report',
      xmlport: 'XMLPort',
      query: 'Query',
      enum: 'Enum',
      enumextension: 'EnumExtension',
      interface: 'Interface',
      controladdin: 'ControlAddIn',
      profile: 'Profile',
      permissionset: 'PermissionSet',
      permissionsetextension: 'PermissionSetExtension'
    };

    return displayNames[normalizedType] ?? type.trim();
  }
}
