import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** @typedef {'low' | 'medium' | 'high'} Risk */
/** @typedef {{ id: string, command: string[] | null, requiredFor: Risk[], timeoutMs: number }} Gate */
/** @typedef {{ version: 1, project: string, preset: string, packageManager: string, gates: Gate[] }} Config */

export const RISKS = ['low', 'medium', 'high'];
export const CONFIG_PATH = '.ai-workflow/config.json';

/** @returns {Config} */
export function validateConfig(value) {
  if (!value || value.version !== 1) throw new Error('config.version 必须为 1');
  for (const key of ['project', 'preset', 'packageManager']) {
    if (typeof value[key] !== 'string' || !value[key].trim())
      throw new Error(`config.${key} 必须为非空字符串`);
  }
  if (!Array.isArray(value.gates) || value.gates.length === 0)
    throw new Error('gates 必须是非空数组');
  const ids = new Set();
  for (const gate of value.gates) {
    if (
      !gate ||
      typeof gate.id !== 'string' ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(gate.id) ||
      ids.has(gate.id)
    ) {
      throw new Error('gate.id 必须唯一，使用小写字母、数字或连字符，最长 64 字符');
    }
    ids.add(gate.id);
    if (
      gate.command !== null &&
      (!Array.isArray(gate.command) ||
        gate.command.length === 0 ||
        gate.command.some((x) => typeof x !== 'string' || x.includes('\0')) ||
        !gate.command[0].trim())
    ) {
      throw new Error(`${gate.id}.command 必须是非空 argv 数组或 null`);
    }
    if (
      !Array.isArray(gate.requiredFor) ||
      !gate.requiredFor.length ||
      gate.requiredFor.some((x) => !RISKS.includes(x))
    ) {
      throw new Error(`${gate.id}.requiredFor 必须包含 low / medium / high`);
    }
    // 风险越高，要求不能更少。
    for (const risk of gate.requiredFor) {
      if (RISKS.slice(RISKS.indexOf(risk)).some((x) => !gate.requiredFor.includes(x))) {
        throw new Error(`${gate.id}.requiredFor 必须随风险等级递增`);
      }
    }
    if (!Number.isInteger(gate.timeoutMs) || gate.timeoutMs < 1 || gate.timeoutMs > 3_600_000) {
      throw new Error(`${gate.id}.timeoutMs 必须为 1 到 3600000 的整数`);
    }
  }
  for (const risk of RISKS) {
    if (!value.gates.some((g) => g.requiredFor.includes(risk)))
      throw new Error(`风险 ${risk} 没有任何门禁`);
  }
  return value;
}

export async function loadConfig(cwd) {
  const filename = resolve(cwd, CONFIG_PATH);
  try {
    return validateConfig(JSON.parse(await readFile(filename, 'utf8')));
  } catch (error) {
    throw new Error(`无法读取有效配置 ${filename}: ${error.message}`, {
      cause: error,
    });
  }
}

export function assertRisk(risk) {
  if (!RISKS.includes(risk)) throw new Error(`未知风险等级 ${risk}，请选择 low / medium / high`);
}
