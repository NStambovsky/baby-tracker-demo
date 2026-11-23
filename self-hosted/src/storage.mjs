import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_LIMIT = 100;
const MAX_FEEDING_DURATION_MS = 60 * 60 * 1000;

export function createStorage(env = process.env) {
  if (env.ZO_TABLE_API_URL) {
    return new ZoTableStorage(env.ZO_TABLE_API_URL, env.ZO_TABLE_API_TOKEN);
  }

  return new FileStorage(env.DATA_DIR || './data');
}

export function normalizeEntry(input, now = new Date()) {
  const type = String(input.type || '').trim();
  const note = String(input.note || '').trim();

  if (!['feeding', 'sleep', 'pee', 'poop', 'note', 'weigh-in'].includes(type)) {
    throw Object.assign(new Error('Unsupported entry type'), { statusCode: 400 });
  }

  const startedAt = input.startedAt || input.occurredAt || now.toISOString();
  const stoppedAt = input.stoppedAt || null;
  const start = new Date(startedAt);
  const stop = stoppedAt ? new Date(stoppedAt) : null;

  if (Number.isNaN(start.getTime()) || (stop && Number.isNaN(stop.getTime()))) {
    throw Object.assign(new Error('Invalid timestamp'), { statusCode: 400 });
  }

  if (type === 'feeding' && !['left', 'right', 'bottle'].includes(input.side)) {
    throw Object.assign(new Error('Feeding side must be left, right, or bottle'), { statusCode: 400 });
  }

  if (stop && stop.getTime() < start.getTime()) {
    throw Object.assign(new Error('End time cannot be before start time'), { statusCode: 400 });
  }

  if (type === 'sleep' && !['nap', 'bedtime'].includes(input.sleepType)) {
    throw Object.assign(new Error('Sleep type must be nap or bedtime'), { statusCode: 400 });
  }

  const isBottle = type === 'feeding' && input.side === 'bottle';
  const hasVolume = input.volume !== undefined && input.volume !== null && input.volume !== '';
  if (hasVolume && (!isBottle || !stop || typeof input.volume !== 'number' || !Number.isFinite(input.volume) || input.volume < 0 || !['oz', 'ml'].includes(input.volumeUnit))) {
    throw Object.assign(new Error('Volume requires a stopped bottle feed, a nonnegative number, and oz or ml'), { statusCode: 400 });
  }

  const isWeighIn = type === 'weigh-in';
  const hasHeight = input.height !== undefined && input.height !== null && input.height !== '';
  if (isWeighIn && (typeof input.weight !== 'number' || !Number.isFinite(input.weight) || input.weight <= 0 || !['lb', 'kg'].includes(input.weightUnit))) {
    throw Object.assign(new Error('Weight must be a positive number in lb or kg'), { statusCode: 400 });
  }
  if (isWeighIn && hasHeight && (typeof input.height !== 'number' || !Number.isFinite(input.height) || input.height <= 0 || !['in', 'cm'].includes(input.heightUnit))) {
    throw Object.assign(new Error('Height must be a positive number in in or cm'), { statusCode: 400 });
  }

  return {
    ...(isWeighIn ? { weigh_in: true, weight: input.weight, weight_unit: input.weightUnit, height: hasHeight ? input.height : null, height_unit: hasHeight ? input.heightUnit : null } : {}),
    ...(isBottle ? { bottle: true, volume: hasVolume ? input.volume : null, volume_unit: hasVolume ? input.volumeUnit : null } : {}),
    ...(type === 'sleep' ? { sleep_type: input.sleepType } : {}),
    id: input.id || randomUUID(),
    entry_date: formatDate(start),
    time_start: start.toISOString(),
    time_stop: stop ? stop.toISOString() : null,
    time_display: formatTimeDisplay(start, stop),
    left_side: type === 'feeding' && input.side === 'left',
    right_side: type === 'feeding' && input.side === 'right',
    pee: type === 'pee',
    poop: type === 'poop',
    note,
    created_at: now.toISOString(),
    created_by: 'family'
  };
}

function finalizeExpiredFeeding(entry, now = new Date()) {
  if (!(entry.left_side || entry.right_side || entry.bottle) || entry.time_stop) return entry;
  const start = new Date(entry.time_start);
  if (Number.isNaN(start.getTime()) || now.getTime() - start.getTime() < MAX_FEEDING_DURATION_MS) return entry;
  const stop = new Date(start.getTime() + MAX_FEEDING_DURATION_MS);
  return { ...entry, time_stop: stop.toISOString(), time_display: formatTimeDisplay(start, stop) };
}

export function normalizeAccessRequest(input, now = new Date()) {
  return {
    id: randomUUID(),
    name: String(input.name || '').trim().slice(0, 120),
    contact: String(input.contact || '').trim().slice(0, 240),
    message: String(input.message || '').trim().slice(0, 1000),
    created_at: now.toISOString()
  };
}

export class EntryNotFoundError extends Error {
  constructor(id) {
    super(`Entry not found: ${id}`);
    this.name = 'EntryNotFoundError';
  }
}

class FileStorage {
  constructor(dataDir) {
    this.entriesPath = join(dataDir, 'entries.json');
    this.requestsPath = join(dataDir, 'access-requests.json');
    this.ready = mkdir(dataDir, { recursive: true });
  }

  async listEntries(limit = DEFAULT_LIMIT) {
    await this.ready;
    const rows = await readJsonArray(this.entriesPath);
    const finalized = rows.map((row) => finalizeExpiredFeeding(row));
    if (finalized.some((row, index) => row !== rows[index])) await writeJsonArray(this.entriesPath, finalized);
    return finalized
      .sort((a, b) => String(b.time_start).localeCompare(String(a.time_start)))
      .slice(0, limit === 'all' ? undefined : clampLimit(limit));
  }

  async createEntry(payload) {
    const entry = normalizeEntry(payload);
    await this.ready;
    const rows = await readJsonArray(this.entriesPath);
    rows.push(entry);
    await writeJsonArray(this.entriesPath, rows);
    return entry;
  }

  async updateEntry(id, payload) {
    const entry = normalizeEntry(payload);
    await this.ready;
    const rows = await readJsonArray(this.entriesPath);
    const index = rows.findIndex((row) => row.id === id);
    if (index === -1) throw new EntryNotFoundError(id);
    const updated = { ...entry, id, created_at: rows[index].created_at };
    rows[index] = updated;
    await writeJsonArray(this.entriesPath, rows);
    return updated;
  }

  async deleteEntry(id) {
    await this.ready;
    const rows = await readJsonArray(this.entriesPath);
    const index = rows.findIndex((row) => row.id === id);
    if (index === -1) throw new EntryNotFoundError(id);
    rows.splice(index, 1);
    await writeJsonArray(this.entriesPath, rows);
  }

  async createAccessRequest(input) {
    await this.ready;
    const request = normalizeAccessRequest(input);
    const rows = await readJsonArray(this.requestsPath);
    rows.push(request);
    await writeJsonArray(this.requestsPath, rows);
    return request;
  }
}

class ZoTableStorage {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  async listEntries(limit = DEFAULT_LIMIT) {
    const entries = await this.request(`/entries?limit=${limit === 'all' ? 'all' : clampLimit(limit)}`);
    return entries.map((entry) => finalizeExpiredFeeding(entry));
  }

  async createEntry(payload) {
    const entry = normalizeEntry(payload);
    const response = await fetch(`${this.baseUrl}/entries`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(entry)
    });
    if (!response.ok) throw new Error(`Zo table create failed: ${response.status}`);
    return response.json();
  }

  async updateEntry(id, payload) {
    const entry = normalizeEntry(payload);
    const response = await fetch(`${this.baseUrl}/entries/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify(entry)
    });
    if (response.status === 404) throw new EntryNotFoundError(id);
    if (!response.ok) throw new Error(`Zo table update failed: ${response.status}`);
    return response.json();
  }

  async deleteEntry(id) {
    const response = await fetch(`${this.baseUrl}/entries/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.headers
    });
    if (response.status === 404) throw new EntryNotFoundError(id);
    if (!response.ok) throw new Error(`Zo table delete failed: ${response.status}`);
  }

  async createAccessRequest(input) {
    return this.request('/access-requests', {
      method: 'POST',
      body: JSON.stringify(normalizeAccessRequest(input))
    });
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(options.headers || {})
      }
    });

    if (!response.ok) {
      throw Object.assign(new Error(`Zo table request failed: ${response.status}`), {
        statusCode: 502
      });
    }

    return response.json();
  }

  get headers() {
    return {
      'content-type': 'application/json',
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
    };
  }
}

async function readJsonArray(path) {
  try {
    const content = await readFile(path, 'utf8');
    if (!content.trim()) return [];
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeJsonArray(path, rows) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(rows, null, 2)}\n`);
  await rename(temporaryPath, path);
}

function clampLimit(limit) {
  const numeric = Number(limit) || DEFAULT_LIMIT;
  return Math.min(Math.max(numeric, 1), 500);
}

function formatDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TZ || 'America/New_York'
  }).format(date);
}

function formatTimeDisplay(start, stop) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: process.env.TZ || 'America/New_York'
  });

  if (!stop) return formatter.format(start);
  return `${formatter.format(start)} to ${formatter.format(stop)}`;
}
