#!/usr/bin/env node
/**
 * scripts/check-syntax.mjs — brama składni: node --check na każdym .mjs,
 * py_compile na każdym .py. Szybka, bez sieci, bez zależności.
 * Użycie: node scripts/check-syntax.mjs   (exit 1 przy pierwszym błędzie)
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.cache' || name === 'bin' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

let failed = 0;
const files = walk(ROOT);
for (const f of files) {
  const ext = extname(f);
  if (ext === '.mjs' || ext === '.js' || ext === '.cjs') {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (e) {
      failed += 1;
      console.error(`[SYNTAX] ${relative(ROOT, f)}\n${String(e.stderr || e.message).slice(0, 300)}`);
    }
  } else if (ext === '.py') {
    try {
      execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'py_compile', f], { stdio: 'pipe' });
    } catch (e) {
      failed += 1;
      console.error(`[PY] ${relative(ROOT, f)}\n${String(e.stderr || e.message).slice(0, 300)}`);
    }
  }
}
console.log(`sprawdzono ${files.length} plików, błędów: ${failed}`);
process.exit(failed ? 1 : 0);
