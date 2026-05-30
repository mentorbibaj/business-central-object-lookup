import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { inflateRawSync } from 'zlib';
import * as vscode from 'vscode';
import * as yauzl from 'yauzl';
import { BusinessCentralObject } from './types';

const execFileAsync = promisify(execFile);

const alObjectDeclaration =
  /^\s*(table|tableextension|page|pageextension|pagecustomization|codeunit|report|xmlport|query|enum|enumextension|interface|controladdin|profile|permissionset|permissionsetextension)\s+(\d+)\s+("[^"]+"|[^\r\n{]+)/gim;

interface CatalogLoadResult {
  objectCount: number;
  sourceCount: number;
  warnings: string[];
}

export class ObjectCatalog {
  private objectsById = new Map<number, BusinessCentralObject[]>();
  private objectsBySource = new Map<string, BusinessCentralObject[]>();

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalStorageUri: vscode.Uri
  ) {}

  public async load(): Promise<CatalogLoadResult> {
    const sources = new Set<string>();
    const warnings: string[] = [];
    const config = vscode.workspace.getConfiguration('businessCentralObjectLookup');

    this.objectsBySource.clear();

    if (config.get<boolean>('scanWorkspace', true)) {
      await this.loadWorkspaceObjects(sources, warnings);
    }

    const configuredCatalog = this.getConfiguredCatalogPath();
    if (configuredCatalog) {
      await this.setJsonCatalogSource(configuredCatalog, configuredCatalog.fsPath);
      sources.add(configuredCatalog.fsPath);
    }

    if (config.get<boolean>('includeBundledCatalog', false) || this.getCachedObjectCount() === 0) {
      const bundledCatalog = vscode.Uri.joinPath(this.extensionUri, 'data', 'businessCentralObjects.json');
      await this.setJsonCatalogSource(bundledCatalog, 'bundled catalog');
      sources.add('bundled catalog');
    }

    this.rebuildIndex();
    return this.createLoadResult(warnings);
  }

  public async updateSource(uri: vscode.Uri): Promise<CatalogLoadResult> {
    const warnings: string[] = [];
    const extension = path.extname(uri.fsPath).toLowerCase();
    const config = vscode.workspace.getConfiguration('businessCentralObjectLookup');

    if (this.isConfiguredCatalog(uri)) {
      await this.setJsonCatalogSource(uri, uri.fsPath);
      this.rebuildIndex();
      return this.createLoadResult(warnings);
    }

    if (!config.get<boolean>('scanWorkspace', true) || !['.al', '.app'].includes(extension)) {
      return this.createLoadResult(warnings);
    }

    try {
      if (extension === '.al') {
        await this.setAlSource(uri);
      } else {
        await this.setAppSource(uri);
      }
    } catch (error) {
      this.deleteCachedSource(uri.fsPath);
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Skipped ${path.basename(uri.fsPath)}: ${message}`);
    }

    this.rebuildIndex();
    return this.createLoadResult(warnings);
  }

  public deleteSource(uri: vscode.Uri): CatalogLoadResult {
    this.deleteCachedSource(uri.fsPath);
    this.rebuildIndex();
    return this.createLoadResult([]);
  }

  public findById(id: number): BusinessCentralObject[] {
    return this.objectsById.get(id) ?? [];
  }

  private async loadWorkspaceObjects(
    sources: Set<string>,
    warnings: string[]
  ): Promise<void> {
    const [alFiles, appFiles] = await Promise.all([
      vscode.workspace.findFiles('**/*.al', '**/{node_modules,dist,.git}/**'),
      vscode.workspace.findFiles('**/*.app', '**/{node_modules,dist,.git}/**')
    ]);

    await Promise.all(alFiles.map(async (uri) => {
      await this.setAlSource(uri);
      sources.add(uri.fsPath);
    }));

    await Promise.all(appFiles.map(async (uri) => {
      try {
        await this.setAppSource(uri);
        sources.add(uri.fsPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Skipped ${path.basename(uri.fsPath)}: ${message}`);
      }
    }));
  }

  private async setAlSource(uri: vscode.Uri): Promise<void> {
    const text = await fs.readFile(uri.fsPath, 'utf8');
    this.objectsBySource.set(this.toSourceKey(uri.fsPath), this.parseAlObjects(text, uri.fsPath));
  }

  private async setAppSource(uri: vscode.Uri): Promise<void> {
    this.objectsBySource.set(this.toSourceKey(uri.fsPath), await this.parseAppPackage(uri.fsPath));
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
    const symbolPackageObjects = await this.tryParseGeneratedSymbolPackage(filePath);
    if (symbolPackageObjects.length > 0) {
      return symbolPackageObjects;
    }

    throw new Error('The installed AL extension could not create a readable symbol package.');
  }

  private async parseAppPackageWithReaders(filePath: string): Promise<BusinessCentralObject[]> {
    try {
      const objects = await this.parseAppPackageWithYauzl(filePath);
      if (objects.length > 0) {
        return objects;
      }
    } catch {
      // Fall through to the tolerant byte readers below.
    }

    return this.parseAppPackageWithCentralDirectoryFallback(filePath);
  }

  private async parseAppPackageWithYauzl(filePath: string): Promise<BusinessCentralObject[]> {
    let zip: yauzl.ZipFile;
    try {
      zip = await this.openZip(filePath);
    } catch (error) {
      const objects = await this.parseAppPackageWithCentralDirectoryFallback(filePath);
      if (objects.length > 0) {
        return objects;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}; fallback readers found no readable Business Central symbol JSON.`);
    }

    return new Promise((resolve, reject) => {
      const objects: BusinessCentralObject[] = [];

      zip.readEntry();

      zip.on('entry', (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName) || !/\.json$/i.test(entry.fileName)) {
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
              const json = this.parseJsonBuffer(Buffer.concat(chunks));
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

  private async tryParseGeneratedSymbolPackage(filePath: string): Promise<BusinessCentralObject[]> {
    const alToolPath = this.getAlToolPath();
    if (!alToolPath) {
      throw new Error('The Microsoft AL Language extension is not installed.');
    }

    const symbolPackagePath = await this.createSymbolPackage(filePath, alToolPath);
    return this.parseAppPackageWithReaders(symbolPackagePath);
  }

  private async createSymbolPackage(filePath: string, alToolPath: string): Promise<string> {
    const packageHash = createHash('sha256')
      .update(filePath)
      .update(':')
      .update((await fs.stat(filePath)).mtimeMs.toString())
      .digest('hex')
      .slice(0, 16);
    const symbolCacheFolder = vscode.Uri.joinPath(this.globalStorageUri, 'symbolPackages');
    await fs.mkdir(symbolCacheFolder.fsPath, { recursive: true });

    const symbolPackagePath = path.join(symbolCacheFolder.fsPath, `${packageHash}.app`);
    try {
      await fs.access(symbolPackagePath);
      return symbolPackagePath;
    } catch {
      // Generate the symbol package below.
    }

    await execFileAsync(alToolPath, ['CreateSymbolPackage', filePath, symbolPackagePath], {
      cwd: path.dirname(alToolPath),
      windowsHide: true
    });

    return symbolPackagePath;
  }

  private getAlToolPath(): string | undefined {
    const alExtension = vscode.extensions.getExtension('ms-dynamics-smb.al');
    if (!alExtension) {
      return undefined;
    }

    const platformFolder = this.getAlPlatformFolder();
    const executableName = process.platform === 'win32' ? 'altool.exe' : 'altool';
    return path.join(alExtension.extensionPath, 'bin', platformFolder, executableName);
  }

  private getAlPlatformFolder(): string {
    if (process.platform === 'win32') {
      return 'win32';
    }

    if (process.platform === 'darwin') {
      return 'darwin';
    }

    return os.platform() === 'linux' ? 'linux' : process.platform;
  }

  private openZip(filePath: string): Promise<yauzl.ZipFile> {
    return new Promise((resolve, reject) => {
      yauzl.open(filePath, { lazyEntries: true }, (error, zip) => {
        if (error) {
          if (/Invalid comment length/i.test(error.message)) {
            this.openZipWithTrailingBytesFallback(filePath).then(resolve, reject);
            return;
          }

          reject(error);
          return;
        }

        if (!zip) {
          reject(new Error(`Could not open ${filePath}.`));
          return;
        }

        resolve(zip);
      });
    });
  }

  private async openZipWithTrailingBytesFallback(filePath: string): Promise<yauzl.ZipFile> {
    const fileBuffer = await fs.readFile(filePath);
    const trimmedBuffer = this.trimZipTrailingBytes(fileBuffer);

    return new Promise((resolve, reject) => {
      yauzl.fromBuffer(trimmedBuffer, { lazyEntries: true }, (error, zip) => {
        if (error || !zip) {
          reject(error);
          return;
        }

        resolve(zip);
      });
    });
  }

  private trimZipTrailingBytes(buffer: Buffer): Buffer {
    const minimumEndOfCentralDirectorySize = 22;
    const endOfCentralDirectorySignature = 0x06054b50;

    for (let offset = buffer.length - minimumEndOfCentralDirectorySize; offset >= 0; offset -= 1) {
      if (buffer.readUInt32LE(offset) !== endOfCentralDirectorySignature) {
        continue;
      }

      const commentLength = buffer.readUInt16LE(offset + 20);
      const endOffset = offset + minimumEndOfCentralDirectorySize + commentLength;
      if (endOffset <= buffer.length) {
        return buffer.subarray(0, endOffset);
      }
    }

    return buffer;
  }

  private async parseAppPackageWithCentralDirectoryFallback(filePath: string): Promise<BusinessCentralObject[]> {
    const buffer = await fs.readFile(filePath);
    const localHeaderObjects = this.parseAppPackageFromLocalHeaders(buffer, filePath);
    if (localHeaderObjects.length > 0) {
      return localHeaderObjects;
    }

    const zipLayout = this.findZipLayout(buffer);
    if (!zipLayout) {
      return [];
    }

    const objects: BusinessCentralObject[] = [];
    let offset = zipLayout.centralDirectoryOffset;

    while (offset + 46 <= buffer.length && buffer.readUInt32LE(offset) === 0x02014b50) {
      const compressionMethod = buffer.readUInt16LE(offset + 10);
      const fileNameLength = buffer.readUInt16LE(offset + 28);
      const extraFieldLength = buffer.readUInt16LE(offset + 30);
      const fileCommentLength = buffer.readUInt16LE(offset + 32);
      const fileNameStart = offset + 46;
      const fileNameEnd = fileNameStart + fileNameLength;
      const extraFieldStart = fileNameEnd;
      const extraFieldEnd = extraFieldStart + extraFieldLength;
      const fileName = buffer.subarray(fileNameStart, fileNameEnd).toString('utf8');
      const zip64Values = this.readZip64CentralDirectoryValues(
        buffer.subarray(extraFieldStart, extraFieldEnd),
        buffer.readUInt32LE(offset + 20),
        buffer.readUInt32LE(offset + 42)
      );
      const compressedSize = zip64Values.compressedSize;
      const localHeaderRelativeOffset = zip64Values.localHeaderRelativeOffset;

      if (/\.json$/i.test(fileName)) {
        const entryBuffer = this.readCentralDirectoryEntryData(
          buffer,
          zipLayout.archiveBaseOffset + localHeaderRelativeOffset,
          compressedSize,
          compressionMethod
        );

        if (entryBuffer) {
          try {
            const json = this.parseJsonBuffer(entryBuffer);
            objects.push(...this.extractObjectsFromSymbolJson(json, filePath));
          } catch {
            // Ignore non-symbol JSON files inside the package.
          }
        }
      }

      offset = extraFieldEnd + fileCommentLength;
    }

    return objects;
  }

  private parseAppPackageFromLocalHeaders(buffer: Buffer, filePath: string): BusinessCentralObject[] {
    const objects: BusinessCentralObject[] = [];
    const localHeaderSignature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    const centralDirectorySignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    let offset = 0;

    while (offset >= 0 && offset + 30 <= buffer.length) {
      offset = buffer.indexOf(localHeaderSignature, offset);
      if (offset < 0 || offset + 30 > buffer.length) {
        break;
      }

      const compressionMethod = buffer.readUInt16LE(offset + 8);
      const compressedSize = buffer.readUInt32LE(offset + 18);
      const fileNameLength = buffer.readUInt16LE(offset + 26);
      const extraFieldLength = buffer.readUInt16LE(offset + 28);
      const fileNameStart = offset + 30;
      const fileNameEnd = fileNameStart + fileNameLength;
      const dataStart = fileNameEnd + extraFieldLength;

      if (fileNameEnd > buffer.length || dataStart > buffer.length) {
        offset += 4;
        continue;
      }

      const fileName = buffer.subarray(fileNameStart, fileNameEnd).toString('utf8');
      const nextLocalHeaderOffset = buffer.indexOf(localHeaderSignature, dataStart);
      const centralDirectoryOffset = buffer.indexOf(centralDirectorySignature, dataStart);
      const nextEntryOffset = this.findNearestPositiveOffset(nextLocalHeaderOffset, centralDirectoryOffset, buffer.length);
      const dataEnd = compressedSize > 0 ? dataStart + compressedSize : nextEntryOffset;

      if (dataEnd <= buffer.length) {
        const entryBuffer = this.decodeZipEntry(buffer.subarray(dataStart, dataEnd), compressionMethod);
        if (entryBuffer) {
          const entryObjects = this.tryExtractObjectsFromJsonBuffer(entryBuffer, filePath);
          if (entryObjects.length > 0 || /\.json$/i.test(fileName)) {
            objects.push(...entryObjects);
          }
        }
      }

      offset = nextEntryOffset;
    }

    return objects;
  }

  private readCentralDirectoryEntryData(
    buffer: Buffer,
    localHeaderOffset: number,
    compressedSize: number,
    compressionMethod: number
  ): Buffer | undefined {
    if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      return undefined;
    }

    const fileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const extraFieldLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + fileNameLength + extraFieldLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) {
      return undefined;
    }

    const compressedData = buffer.subarray(dataStart, dataEnd);
    return this.decodeZipEntry(compressedData, compressionMethod);
  }

  private decodeZipEntry(data: Buffer, compressionMethod: number): Buffer | undefined {
    try {
      if (compressionMethod === 0) {
        return data;
      }

      if (compressionMethod === 8) {
        return inflateRawSync(data);
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  private tryExtractObjectsFromJsonBuffer(buffer: Buffer, source: string): BusinessCentralObject[] {
    try {
      const json = this.parseJsonBuffer(buffer);
      return this.extractObjectsFromSymbolJson(json, source);
    } catch {
      return [];
    }
  }

  private parseJsonBuffer(buffer: Buffer): unknown {
    return JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, '')) as unknown;
  }

  private findNearestPositiveOffset(...offsets: number[]): number {
    return Math.min(...offsets.filter((offset) => offset >= 0));
  }

  private findZipLayout(buffer: Buffer): {
    archiveBaseOffset: number;
    centralDirectoryOffset: number;
    endOfCentralDirectoryOffset: number;
  } | undefined {
    const minimumEndOfCentralDirectorySize = 22;
    const endOfCentralDirectorySignature = 0x06054b50;

    for (let offset = buffer.length - minimumEndOfCentralDirectorySize; offset >= 0; offset -= 1) {
      if (buffer.readUInt32LE(offset) !== endOfCentralDirectorySignature) {
        continue;
      }

      const commentLength = buffer.readUInt16LE(offset + 20);
      const endOffset = offset + minimumEndOfCentralDirectorySize + commentLength;
      if (endOffset > buffer.length) {
        continue;
      }

      const zip64Layout = this.tryReadZip64Layout(buffer, offset);
      if (zip64Layout) {
        return zip64Layout;
      }

      const centralDirectorySize = buffer.readUInt32LE(offset + 12);
      const centralDirectoryRelativeOffset = buffer.readUInt32LE(offset + 16);
      const centralDirectoryOffset = offset - centralDirectorySize;
      if (
        centralDirectoryOffset < 0
        || centralDirectoryOffset + 4 > buffer.length
        || buffer.readUInt32LE(centralDirectoryOffset) !== 0x02014b50
      ) {
        continue;
      }

      return {
        archiveBaseOffset: centralDirectoryOffset - centralDirectoryRelativeOffset,
        centralDirectoryOffset,
        endOfCentralDirectoryOffset: offset
      };
    }

    return undefined;
  }

  private tryReadZip64Layout(
    buffer: Buffer,
    endOfCentralDirectoryOffset: number
  ): {
    archiveBaseOffset: number;
    centralDirectoryOffset: number;
    endOfCentralDirectoryOffset: number;
  } | undefined {
    const zip64LocatorOffset = endOfCentralDirectoryOffset - 20;
    if (zip64LocatorOffset < 0 || buffer.readUInt32LE(zip64LocatorOffset) !== 0x07064b50) {
      return undefined;
    }

    const zip64EndOfCentralDirectoryOffset = this.readUInt64AsNumber(buffer, zip64LocatorOffset + 8);
    if (
      zip64EndOfCentralDirectoryOffset === undefined
      || zip64EndOfCentralDirectoryOffset + 56 > buffer.length
      || buffer.readUInt32LE(zip64EndOfCentralDirectoryOffset) !== 0x06064b50
    ) {
      return undefined;
    }

    const centralDirectorySize = this.readUInt64AsNumber(buffer, zip64EndOfCentralDirectoryOffset + 40);
    const centralDirectoryRelativeOffset = this.readUInt64AsNumber(buffer, zip64EndOfCentralDirectoryOffset + 48);
    if (centralDirectorySize === undefined || centralDirectoryRelativeOffset === undefined) {
      return undefined;
    }

    const centralDirectoryOffset = endOfCentralDirectoryOffset - centralDirectorySize;
    if (
      centralDirectoryOffset < 0
      || centralDirectoryOffset + 4 > buffer.length
      || buffer.readUInt32LE(centralDirectoryOffset) !== 0x02014b50
    ) {
      return undefined;
    }

    return {
      archiveBaseOffset: centralDirectoryOffset - centralDirectoryRelativeOffset,
      centralDirectoryOffset,
      endOfCentralDirectoryOffset
    };
  }

  private readZip64CentralDirectoryValues(
    extraField: Buffer,
    compressedSize32: number,
    localHeaderRelativeOffset32: number
  ): { compressedSize: number; localHeaderRelativeOffset: number } {
    let compressedSize = compressedSize32;
    let localHeaderRelativeOffset = localHeaderRelativeOffset32;
    let offset = 0;

    while (offset + 4 <= extraField.length) {
      const headerId = extraField.readUInt16LE(offset);
      const dataSize = extraField.readUInt16LE(offset + 2);
      const dataStart = offset + 4;
      const dataEnd = dataStart + dataSize;

      if (dataEnd > extraField.length) {
        break;
      }

      if (headerId === 0x0001) {
        let zip64Offset = dataStart;
        if (compressedSize32 === 0xffffffff && zip64Offset + 16 <= dataEnd) {
          zip64Offset += 8;
          compressedSize = this.readUInt64AsNumber(extraField, zip64Offset) ?? compressedSize;
          zip64Offset += 8;
        }

        if (localHeaderRelativeOffset32 === 0xffffffff && zip64Offset + 8 <= dataEnd) {
          localHeaderRelativeOffset = this.readUInt64AsNumber(extraField, zip64Offset) ?? localHeaderRelativeOffset;
        }
      }

      offset = dataEnd;
    }

    return { compressedSize, localHeaderRelativeOffset };
  }

  private readUInt64AsNumber(buffer: Buffer, offset: number): number | undefined {
    if (offset + 8 > buffer.length) {
      return undefined;
    }

    const value = buffer.readBigUInt64LE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      return undefined;
    }

    return Number(value);
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

  private async setJsonCatalogSource(uri: vscode.Uri, source: string): Promise<void> {
    this.objectsBySource.set(this.toSourceKey(source), await this.loadJsonCatalog(uri, source));
  }

  private rebuildIndex(): void {
    const uniqueObjects = new Map<string, BusinessCentralObject>();

    for (const objects of this.objectsBySource.values()) {
      for (const object of objects) {
        const key = `${object.type.toLowerCase()}:${object.id}:${object.name.toLowerCase()}`;
        uniqueObjects.set(key, object);
      }
    }

    this.objectsById.clear();
    for (const object of uniqueObjects.values()) {
      const entries = this.objectsById.get(object.id) ?? [];
      entries.push(object);
      entries.sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
      this.objectsById.set(object.id, entries);
    }
  }

  private createLoadResult(warnings: string[]): CatalogLoadResult {
    return {
      objectCount: this.getIndexedObjectCount(),
      sourceCount: this.objectsBySource.size,
      warnings
    };
  }

  private getIndexedObjectCount(): number {
    return [...this.objectsById.values()].reduce((count, entries) => count + entries.length, 0);
  }

  private getCachedObjectCount(): number {
    return [...this.objectsBySource.values()].reduce((count, entries) => count + entries.length, 0);
  }

  private deleteCachedSource(source: string): void {
    this.objectsBySource.delete(this.toSourceKey(source));
  }

  private isConfiguredCatalog(uri: vscode.Uri): boolean {
    const configuredCatalog = this.getConfiguredCatalogPath();
    return configuredCatalog !== undefined && this.toSourceKey(configuredCatalog.fsPath) === this.toSourceKey(uri.fsPath);
  }

  private toSourceKey(source: string): string {
    return path.resolve(source).toLowerCase();
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
