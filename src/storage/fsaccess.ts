/**
 * File System Access API 封装（L4 层）：文件夹批量读取、导出直写目录。
 * 不支持的浏览器（Firefox/Safari 旧版）自动降级为下载模式。
 */
import { naturalCompare } from '@/lib/utils';

export function hasFSAccess(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** 选择文件夹（批量读取） */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!hasFSAccess()) return null;
  try {
    return await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch {
    return null; // 用户取消
  }
}

const IMAGE_EXT = /\.(png|jpe?g|webp|tiff?)$/i;

/** 批量读取文件夹内图像文件，按自然排序（F1.3） */
export async function readImageFilesFromDirectory(
  dir: FileSystemDirectoryHandle,
): Promise<File[]> {
  const files: File[] = [];
  for await (const entry of dir.values()) {
    if (entry.kind === 'file' && IMAGE_EXT.test(entry.name)) {
      files.push(await (entry as FileSystemFileHandle).getFile());
    }
  }
  return files.sort((a, b) => naturalCompare(a.name, b.name));
}

/** 在目录中写入文本文件（UTF-8 无 BOM） */
export async function writeTextFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  content: string,
): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  await w.close();
}

/** 在目录中写入二进制文件 */
export async function writeBinaryFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  content: Blob,
): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(content);
  await w.close();
}

/** 另存为单个文件（showSaveFilePicker），不支持时返回 null 由调用方降级下载 */
export async function saveFileAs(suggestedName: string, content: string | Blob): Promise<boolean> {
  if (!('showSaveFilePicker' in window)) return false;
  try {
    const fh = await window.showSaveFilePicker({ suggestedName });
    const w = await fh.createWritable();
    await w.write(typeof content === 'string' ? new Blob([content], { type: 'text/plain;charset=utf-8' }) : content);
    await w.close();
    return true;
  } catch {
    return false; // 用户取消或失败，调用方决定是否降级
  }
}
