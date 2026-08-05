import fs from 'node:fs';
import path from 'node:path';
import { golemHome } from './lib/golem-home.js';
import { PiNativeAdapter } from './lib/pi-native-adapter.js';

// Pi-specific primitive binding. Shared transport, lifecycle, replay, facts,
// leases, and journaling live in the rendered runtime modules.
export default function golem(pi) {
  const adapter = new PiNativeAdapter(pi);
  adapter.bind();

  // Migration-only reader for records published by the former Tier-B adapter.
  // First-class typed dispatch never writes this spool; keep already-published
  // records recoverable until the dashboard cutover proves it empty.
  const home = golemHome();
  let canonicalId;
  let pendingPickup = [];
  pi.on('session_start', (_event, ctx) => { canonicalId = ctx.sessionManager.getSessionId(); });
  pi.on('input', (event, ctx) => {
    if (event.source === 'extension') return;
    const id = canonicalId || ctx.sessionManager.getSessionId();
    const root = path.join(home, 'pi-inbox', id);
    const pending = path.join(root, 'pending');
    const processingDir = path.join(root, 'processing');
    const work = [
      ...(fs.existsSync(processingDir) ? fs.readdirSync(processingDir).sort().map((name) => ({ name, source: path.join(processingDir, name), claimed: true })) : []),
      ...(fs.existsSync(pending) ? fs.readdirSync(pending).sort().map((name) => ({ name, source: path.join(pending, name), claimed: false })) : []),
    ];
    const messages = [];
    for (const item of work) {
      const processing = path.join(root, 'processing', item.name);
      try {
        fs.mkdirSync(path.dirname(processing), { recursive: true });
        if (!item.claimed) fs.renameSync(item.source, processing);
        const value = JSON.parse(fs.readFileSync(processing, 'utf8'));
        if (typeof value?.text !== 'string') throw new Error('invalid text');
        messages.push(value);
        pendingPickup.push({ root, name: item.name });
      } catch {
        try {
          fs.mkdirSync(path.join(root, 'dead-letter'), { recursive: true });
          fs.renameSync(processing, path.join(root, 'dead-letter', item.name));
        } catch {}
      }
    }
    if (messages.length) return { action: 'transform', text: `${event.text}\n\n${messages.map((item) => item.text).join('\n\n')}` };
  });
  pi.on('agent_start', () => {
    for (const { root, name } of pendingPickup) {
      try {
        fs.mkdirSync(path.join(root, 'acks'), { recursive: true });
        fs.renameSync(path.join(root, 'processing', name), path.join(root, 'acks', name));
      } catch {}
    }
    pendingPickup = [];
  });
}
