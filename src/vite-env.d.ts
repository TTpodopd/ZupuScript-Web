/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * File System Access API 环境声明（WICG，TS lib.dom 未完整覆盖的部分在此补齐；
 * 与 lib.dom 已有声明通过接口合并共存）。
 */
interface StorageManager {
  getDirectory(): Promise<FileSystemDirectoryHandle>;
}

interface Window {
  showDirectoryPicker(options?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
  showSaveFilePicker(options?: { suggestedName?: string }): Promise<FileSystemFileHandle>;
  showOpenFilePicker(options?: { multiple?: boolean }): Promise<FileSystemFileHandle[]>;
}

interface FileSystemDirectoryHandle {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  keys(): AsyncIterableIterator<string>;
  values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
  entries(): AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>;
  [Symbol.asyncIterator](): AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>;
}

interface FileSystemFileHandle {
  createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>;
}

interface FileSystemWritableFileStream extends WritableStream {
  write(data: Blob | string | ArrayBuffer | { type: string; data?: unknown; position?: number; size?: number }): Promise<void>;
  seek(position: number): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
}
