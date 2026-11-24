// flows.md: the spec. One "## heading" per flow, plain-English objective underneath.
//
//   # Split bill
//   url: http://localhost:4173
//
//   ## even split
//   Type 90 into the bill field and 3 into people, then verify each person pays 30.00
//
// Lines starting with ">" are notes for humans and are not sent to Kane.
// "url:", "max-steps:" and "timeout:" may appear at the top (defaults) or inside a flow (override).

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const KEYS = { 'url': 'url', 'max-steps': 'maxSteps', 'timeout': 'timeout' };

export function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'flow';
}

export function parseFlows(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const defaults = {};
  const flows = [];
  let cur = null;
  let inFence = false;
  let inComment = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('```')) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (inComment) { if (line.includes('-->')) inComment = false; continue; }
    if (line.startsWith('<!--')) { if (!line.includes('-->')) inComment = true; continue; }

    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      cur = { title: h2[1].trim(), name: slug(h2[1]), text: [] };
      flows.push(cur);
      continue;
    }
    if (/^#\s/.test(line) || line.startsWith('>')) continue;

    const kv = /^(url|max-steps|timeout)\s*:\s*(.+)$/i.exec(line);
    if (kv) {
      (cur || defaults)[KEYS[kv[1].toLowerCase()]] = kv[2].trim();
      continue;
    }
    if (cur && line) cur.text.push(line);
  }

  const seen = new Set();
  const out = [];
  for (const f of flows) {
    const objective = f.text.join(' ').replace(/\s+/g, ' ').trim();
    if (!objective) throw new Error(`flow "${f.title}" has no objective text`);
    if (seen.has(f.name)) throw new Error(`duplicate flow name "${f.name}"`);
    seen.add(f.name);
    out.push({
      name: f.name,
      title: f.title,
      objective,
      url: f.url || defaults.url || null,
      maxSteps: num(f.maxSteps ?? defaults.maxSteps),
      timeout: num(f.timeout ?? defaults.timeout),
    });
  }
  if (!out.length) throw new Error('no flows found (add "## flow name" headings with an objective underneath)');
  return { defaults, flows: out };
}

function num(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(String(v).replace(/s$/, ''));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`not a positive number: ${v}`);
  return n;
}

export function loadFlows(path) {
  const text = readFileSync(path, 'utf8');
  return { ...parseFlows(text), sha256: sha256(text) };
}

export function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}
