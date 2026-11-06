#!/usr/bin/env node
/**
 * browser/client.mjs — minimalny klient MCP (stdio, NDJSON) dla Obscury.
 *
 * Dlaczego ręcznie, a nie przez SDK MCP:
 *   - zero zależności runtime (całe repo działa bez npm install),
 *   - protokół naszego użycia to cztery metody: initialize, tools/list,
 *     tools/call, notifications/initialized — reszta SDK jest szumem,
 *   - dziecko (obscura.exe) żyje w jednym procesie z nami i umiera z nami.
 *
 * Kontrakt: każda odpowiedź to jedna linia JSON (JSON-RPC 2.0). Timeout per
 * wywołanie — przeglądarka może wisnąć, silnik nie może.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dir, '..', '..');

/** Kolejność szukania binarii: jawne env → katalog repo → PATH. */
export function findObscuraBin() {
  const candidates = [
    process.env.OBSCURA_BIN,
    join(REPO_ROOT, 'bin', 'obscura.exe'),
    join(REPO_ROOT, 'bin', 'obscura'),
    'obscura.exe',
    'obscura',
  ].filter(Boolean);

  for (const c of candidates) {
    if (c.includes('/') || c.includes('\\')) {
      if (existsSync(c)) return c;
      continue;
    }
    try {
      const cmd = process.platform === 'win32'
        ? execFileSync('where', [c], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/)[0].trim()
        : execFileSync('which', [c], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (cmd && existsSync(cmd)) return cmd;
    } catch {
      /* nie ma w PATH — następny kandydat */
    }
  }
  return null;
}

export class BrowserUnavailableError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'BrowserUnavailableError';
  }
}

/** Wyciąga treść z odpowiedzi MCP: content[0].text, parsując JSON jeśli się da. */
export function unwrapToolResult(res) {
  const content = res?.result?.content;
  const first = Array.isArray(content) ? content[0] : null;
  const raw = first && typeof first.text === 'string' ? first.text : '';
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  return {
    isError: Boolean(res?.result?.isError) || Boolean(res?.error),
    text: raw,
    data: parsed && typeof parsed === 'object' ? parsed : null,
  };
}

export class ObscuraClient {
  /**
   * @param {object} opts
   * @param {string} opts.bin ścieżka do obscura.exe (domyślnie findObscuraBin)
   * @param {boolean} opts.stealth --stealth
   * @param {number} opts.callTimeoutMs domyślny timeout jednego wywołania
   */
  constructor({ bin = findObscuraBin(), stealth = process.env.OBSCURA_STEALTH === '1', callTimeoutMs = 20000 } = {}) {
    if (!bin) {
      throw new BrowserUnavailableError(
        'Nie znaleziono binarii Obscury. Pobierz build (obscura-x86_64-windows-stealth.zip) do bin/ albo ustaw OBSCURA_BIN.'
      );
    }
    this.bin = bin;
    this.stealth = stealth;
    this.callTimeoutMs = callTimeoutMs;
    this.child = null;
    this.tools = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stderrTail = '';
  }

  /** Start dziecka + handshake MCP. Idempotentny. */
  async start() {
    if (this.child) return this;
    const args = ['mcp'];
    if (this.stealth) args.push('--stealth');
    // Obscura to .exe; atrapy/testy podają skrypt .mjs — wtedy startujemy przez node.
    const isScript = /\.(mjs|cjs|js)$/i.test(this.bin);
    this.child = isScript
      ? spawn(process.execPath, [this.bin, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    const rl = createInterface({ input: this.child.stdout });
    rl.on('line', (line) => {
      line = line.trim();
      if (!line) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });
    this.child.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
    });
    this.child.on('exit', () => {
      for (const [, { reject, timer }] of this.pending) {
        clearTimeout(timer);
        reject(new BrowserUnavailableError('Obscura zakończyła proces'));
      }
      this.pending.clear();
      this.child = null;
    });

    await this._send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'aisearch-browser-client', version: '1.0.0' },
    });
    this._notify('notifications/initialized', {});
    return this;
  }

  _notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: params || {} })}\n`);
  }

  _send(method, params, timeoutMs) {
    const id = this.nextId++;
    const timeout = timeoutMs ?? this.callTimeoutMs;
    const msg = { jsonrpc: '2.0', id, method, params: params || {} };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout ${method} po ${timeout} ms`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(msg)}\n`);
    });
  }

  async call(name, args = {}, timeoutMs) {
    await this.start();
    const res = await this._send('tools/call', { name, arguments: args || {} }, timeoutMs);
    return unwrapToolResult(res);
  }

  /** Lista narzędzi Obscury (cache'owana w procesie). */
  async listTools() {
    if (this.tools) return this.tools;
    await this.start();
    const res = await this._send('tools/list', {});
    this.tools = (res?.result?.tools || []).map((t) => t.name);
    return this.tools;
  }

  /**
   * Render strony → markdown + tytuł. To JEDYNY punkt, w którym silnik
   * korzysta z przeglądarki: V8 wykonuje JS, my bierzemy tekst.
   * Zwraca postać { ok, url, title, text, links? }.
   */
  async renderPage(url, { timeoutMs } = {}) {
    await this.start();
    const t = timeoutMs ?? this.callTimeoutMs;
    const nav = await this.call('browser_navigate', { url }, t);
    if (nav.isError) return { ok: false, url, title: null, text: '', error: nav.text.slice(0, 300) };

    const md = await this.call('browser_markdown', {}, t);
    const title = await this.call('browser_evaluate', { expression: 'document.title' }, t);
    const titleText = (title.data && typeof title.data === 'string' ? title.data : title.text || '').trim();
    return {
      ok: !md.isError,
      url,
      title: titleText || null,
      text: md.text || '',
      error: md.isError ? md.text.slice(0, 300) : undefined,
    };
  }

  async close() {
    if (this.child) {
      try {
        await this.call('browser_close', {}, 5000).catch(() => {});
      } catch {
        /* dzieciak już nie żyje */
      }
      try {
        this.child.kill();
      } catch {
        /* ignorujemy — proces i tak pada */
      }
      this.child = null;
    }
  }
}
