import * as fs from 'fs';
import * as path from 'path';

const TARGET_DIR = path.join(process.cwd(), 'data/TVTargetTrack');

export function ensureTargetDir() {
  if (!fs.existsSync(TARGET_DIR)) {
    fs.mkdirSync(TARGET_DIR, { recursive: true });
  }
}

export function readTargetTrack(token: string): any[] {
  const file = path.join(TARGET_DIR, `${token}.json`);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function appendTargetTrack(token: string, payload: any) {
  ensureTargetDir();
  const file = path.join(TARGET_DIR, `${token}.json`);
  const data = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : [];

  data.push({ ...payload, time: new Date().toISOString() });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function isTradeAlreadyClosed(track: any[]): boolean {
  return track.some((t) => t.action === 'TARGET_BOOKED_50_PERCENT');
}
