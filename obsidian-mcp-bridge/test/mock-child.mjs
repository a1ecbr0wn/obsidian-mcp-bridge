#!/usr/bin/env node
// Minimal MCP stdio mock for bridge integration tests.
// Responds to initialize and tools/list; ignores everything else.

process.stdin.setEncoding('utf8');
let buf = '';

process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          serverInfo: { name: 'mock-child', version: '0.0.1' },
        },
      }) + '\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { tools: [] },
      }) + '\n');
    }
    // All other requests ignored — bridge handles all bridge-native tools directly.
  }
});

process.stdin.resume();
