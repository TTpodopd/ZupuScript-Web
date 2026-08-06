/**
 * 测试用 ESM 解析钩子：
 * 1. 把 '@/xxx' 别名映射到 src/xxx（与 vite/tsconfig paths 一致）；
 * 2. 为项目内无扩展名的相对导入补 .ts/.tsx 扩展名（Node 原生 ESM 不做扩展名推断）。
 * 仅对项目目录内的文件生效，node_modules 走默认解析。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const EXTS = ['.ts', '.tsx', '.mjs', '.js'];

function withExtension(target) {
  if (path.extname(target)) return null;
  for (const ext of EXTS) {
    if (existsSync(target + ext)) return target + ext;
  }
  for (const ext of EXTS) {
    const idx = path.join(target, 'index' + ext);
    if (existsSync(idx)) return idx;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  let target = null;
  if (specifier.startsWith('@/')) {
    target = path.join(SRC, specifier.slice(2));
  } else if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    context.parentURL?.startsWith('file:')
  ) {
    const parent = fileURLToPath(context.parentURL);
    if (parent.startsWith(ROOT)) {
      target = path.resolve(path.dirname(parent), specifier);
    }
  }
  if (target) {
    const resolved = withExtension(target);
    if (resolved) return nextResolve(pathToFileURL(resolved).href, context);
  }
  return nextResolve(specifier, context);
}
