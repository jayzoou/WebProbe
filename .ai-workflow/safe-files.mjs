import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// 拒绝符号链接，防止初始化或报告写入逃出项目目录。
export async function safePath(root, relativePath) {
  const base = await realpath(root);
  const dest = resolve(base, relativePath);
  const rel = relative(base, dest);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`路径越界: ${relativePath}`);
  let cursor = base;
  const parts = rel.split(sep);
  for (const [index, part] of parts.entries()) {
    cursor = resolve(cursor, part);
    if (!(await exists(cursor))) continue;
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error(`拒绝符号链接: ${cursor}`);
    if (index < parts.length - 1 && !stat.isDirectory())
      throw new Error(`父路径不是目录: ${cursor}`);
  }
  return dest;
}

export async function makeParent(root, file) {
  const dest = await safePath(root, file);
  await mkdir(dirname(dest), { recursive: true });
  return dest;
}

export async function safeFile(root, file) {
  const dest = await safePath(root, file);
  if ((await exists(dest)) && !(await lstat(dest)).isFile()) {
    throw new Error(`文件路径被非普通文件占用: ${file}`);
  }
  return dest;
}
