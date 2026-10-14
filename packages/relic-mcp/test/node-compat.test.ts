import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function getSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await getSourceFiles(fullPath)));
    } else if (entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('node-compat', () => {
  test('no Promise.withResolvers anywhere in packages/relic-mcp/src', async () => {
    const srcDir = join(import.meta.dir, '../src');
    const sourceFiles = await getSourceFiles(srcDir);
    expect(sourceFiles.length).toBeGreaterThan(0);

    for (const file of sourceFiles) {
      const content = await readFile(file, 'utf-8');
      expect(content.includes('Promise.withResolvers')).toBe(false);
      expect(content.includes('withResolvers')).toBe(false);
    }
  });
});
