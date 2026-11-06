#!/usr/bin/env node
/**
 * test/stub-obscura.mjs — atrapa binarii Obscury (NDJSON MCP po stdio).
 * Służy testom: prawdziwa przeglądarka jest ciężka i sieciowa, a testujemy
 * POLITYKĘ naszego serwera, nie V8. Jeden plik, zero zależności.
 */
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });

function reply(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    reply({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub-obscura', version: '0.0.0' } } });
    return;
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') {
    reply({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          { name: 'browser_navigate', description: 'navigate', inputSchema: { type: 'object' } },
          { name: 'browser_markdown', description: 'markdown', inputSchema: { type: 'object' } },
          { name: 'browser_evaluate', description: 'evaluate', inputSchema: { type: 'object' } },
        ],
      },
    });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    if (name === 'browser_navigate') {
      reply({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, url: msg.params.arguments?.url }) }] } });
      return;
    }
    if (name === 'browser_markdown') {
      reply({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '# Stub page\n\nRenderowana treść z V8 — dłuższa niż pusty shell.' }] } });
      return;
    }
    if (name === 'browser_evaluate') {
      reply({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'Stub Title' }] } });
      return;
    }
    reply({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'nie znam tego' }], isError: true } });
    return;
  }
  if (msg.id !== undefined) {
    reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'stub: method not found' } });
  }
});
