/**
 * 💾 BULK STORE — SQLite database for bulk OEM scraping
 *
 * Manages:
 * - Vehicle VINs per brand/model (admin-managed)
 * - Bulk scrape jobs with progress tracking
 * - Per-tree-node progress (resume after crash)
 * - Scraped OEM results
 *
 * Separate from cache.db to avoid schema conflicts.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { logger } from './logger';

// ── Types ────────────────────────────────────────────────────────────────────

export interface BulkVehicle {
  id: number;
  vin: string;
  brand: string;
  model: string;
  model_code: string | null;
  year_from: number | null;
  year_to: number | null;
  notes: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface BulkJob {
  id: number;
  vehicle_id: number;
  vin: string;
  brand: string;
  model: string;
  status: 'pending' | 'queued' | 'running' | 'paused' | 'completed' | 'failed';
  total_hg: number;
  completed_hg: number;
  total_parts_found: number;
  error_count: number;
  last_error: string | null;
  last_hg: string | null;
  last_fg: string | null;
  last_bildtafel: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BulkProgressEntry {
  id: number;
  job_id: number;
  hg_code: string;
  hg_name: string | null;
  fg_code: string | null;
  fg_name: string | null;
  bildtafel_id: string | null;
  status: 'pending' | 'completed' | 'failed' | 'skipped';
  parts_found: number;
  error: string | null;
  completed_at: string | null;
}

export interface BulkResultRow {
  id: number;
  job_id: number;
  vin: string;
  brand: string;
  model: string;
  oem: string;
  description: string | null;
  bildtafel: string | null;
  hg_code: string | null;
  hg_name: string | null;
  fg_code: string | null;
  fg_name: string | null;
  created_at: string;
}

// ── Database Setup ───────────────────────────────────────────────────────────

const DB_PATH = path.join(__dirname, '..', 'bulk.db');
let db: Database.Database;

export function initBulkStore(): void {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- Vehicles: one VIN per brand/model combination
    CREATE TABLE IF NOT EXISTS vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vin TEXT NOT NULL,
      brand TEXT NOT NULL,
      model TEXT NOT NULL,
      model_code TEXT,
      year_from INTEGER,
      year_to INTEGER,
      notes TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(brand, model)
    );
    CREATE INDEX IF NOT EXISTS idx_vehicles_brand ON vehicles(brand);
    CREATE INDEX IF NOT EXISTS idx_vehicles_active ON vehicles(is_active);

    -- Jobs: top-level job tracking
    CREATE TABLE IF NOT EXISTS bulk_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
      vin TEXT NOT NULL,
      brand TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      total_hg INTEGER DEFAULT 0,
      completed_hg INTEGER DEFAULT 0,
      total_parts_found INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      last_error TEXT,
      last_hg TEXT,
      last_fg TEXT,
      last_bildtafel TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bulk_jobs_status ON bulk_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_bulk_jobs_vehicle ON bulk_jobs(vehicle_id);

    -- Progress: per-tree-node tracking for resume
    CREATE TABLE IF NOT EXISTS bulk_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES bulk_jobs(id),
      hg_code TEXT NOT NULL,
      hg_name TEXT,
      fg_code TEXT DEFAULT '',
      fg_name TEXT,
      bildtafel_id TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      parts_found INTEGER DEFAULT 0,
      error TEXT,
      completed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_progress_unique
      ON bulk_progress(job_id, hg_code, COALESCE(fg_code,''), COALESCE(bildtafel_id,''));
    CREATE INDEX IF NOT EXISTS idx_progress_job ON bulk_progress(job_id);
    CREATE INDEX IF NOT EXISTS idx_progress_status ON bulk_progress(job_id, status);

    -- Results: scraped OEM numbers
    CREATE TABLE IF NOT EXISTS bulk_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES bulk_jobs(id),
      vin TEXT NOT NULL,
      brand TEXT NOT NULL,
      model TEXT NOT NULL,
      oem TEXT NOT NULL,
      description TEXT,
      bildtafel TEXT,
      hg_code TEXT DEFAULT '',
      hg_name TEXT,
      fg_code TEXT DEFAULT '',
      fg_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_results_unique
      ON bulk_results(job_id, oem, COALESCE(hg_code,''), COALESCE(fg_code,''));
    CREATE INDEX IF NOT EXISTS idx_results_job ON bulk_results(job_id);
    CREATE INDEX IF NOT EXISTS idx_results_oem ON bulk_results(oem);
    CREATE INDEX IF NOT EXISTS idx_results_brand ON bulk_results(brand);
  `);

  const vehicleCount = (db.prepare('SELECT COUNT(*) as c FROM vehicles').get() as any)?.c || 0;
  const resultCount = (db.prepare('SELECT COUNT(*) as c FROM bulk_results').get() as any)?.c || 0;
  logger.info(`Bulk store initialized — ${vehicleCount} vehicles, ${resultCount} results`, { path: DB_PATH });
}

// ── Vehicle CRUD ─────────────────────────────────────────────────────────────

export function listVehicles(filters?: { brand?: string; active?: boolean }): BulkVehicle[] {
  let sql = 'SELECT * FROM vehicles WHERE 1=1';
  const params: any[] = [];

  if (filters?.brand) {
    sql += ' AND brand = ?';
    params.push(filters.brand.toUpperCase());
  }
  if (filters?.active !== undefined) {
    sql += ' AND is_active = ?';
    params.push(filters.active ? 1 : 0);
  }

  sql += ' ORDER BY brand ASC, model ASC';
  return db.prepare(sql).all(...params) as BulkVehicle[];
}

export function getVehicle(id: number): BulkVehicle | null {
  return (db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id) as BulkVehicle) || null;
}

export function upsertVehicle(data: {
  vin: string; brand: string; model: string;
  model_code?: string; year_from?: number; year_to?: number; notes?: string;
}): number {
  const result = db.prepare(`
    INSERT INTO vehicles (vin, brand, model, model_code, year_from, year_to, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(brand, model) DO UPDATE SET
      vin = excluded.vin,
      model_code = COALESCE(excluded.model_code, model_code),
      year_from = COALESCE(excluded.year_from, year_from),
      year_to = COALESCE(excluded.year_to, year_to),
      notes = COALESCE(excluded.notes, notes),
      updated_at = datetime('now')
  `).run(
    data.vin.toUpperCase().trim(),
    data.brand.toUpperCase().trim(),
    data.model.trim(),
    data.model_code || null,
    data.year_from || null,
    data.year_to || null,
    data.notes || null
  );
  return result.lastInsertRowid as number;
}

export function updateVehicle(id: number, data: Partial<{
  vin: string; brand: string; model: string;
  model_code: string; year_from: number; year_to: number;
  notes: string; is_active: boolean;
}>): boolean {
  const sets: string[] = [];
  const params: any[] = [];

  if (data.vin !== undefined) { sets.push('vin = ?'); params.push(data.vin.toUpperCase().trim()); }
  if (data.brand !== undefined) { sets.push('brand = ?'); params.push(data.brand.toUpperCase().trim()); }
  if (data.model !== undefined) { sets.push('model = ?'); params.push(data.model.trim()); }
  if (data.model_code !== undefined) { sets.push('model_code = ?'); params.push(data.model_code); }
  if (data.year_from !== undefined) { sets.push('year_from = ?'); params.push(data.year_from); }
  if (data.year_to !== undefined) { sets.push('year_to = ?'); params.push(data.year_to); }
  if (data.notes !== undefined) { sets.push('notes = ?'); params.push(data.notes); }
  if (data.is_active !== undefined) { sets.push('is_active = ?'); params.push(data.is_active ? 1 : 0); }

  if (sets.length === 0) return false;

  sets.push("updated_at = datetime('now')");
  params.push(id);

  const result = db.prepare(`UPDATE vehicles SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return result.changes > 0;
}

export function deleteVehicle(id: number): boolean {
  const result = db.prepare('DELETE FROM vehicles WHERE id = ?').run(id);
  return result.changes > 0;
}

// ── Job Management ───────────────────────────────────────────────────────────

export function createJob(vehicleId: number): BulkJob {
  const vehicle = getVehicle(vehicleId);
  if (!vehicle) throw new Error(`Vehicle ${vehicleId} not found`);

  const result = db.prepare(`
    INSERT INTO bulk_jobs (vehicle_id, vin, brand, model, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(vehicleId, vehicle.vin, vehicle.brand, vehicle.model);

  return getJob(result.lastInsertRowid as number)!;
}

export function getJob(id: number): BulkJob | null {
  return (db.prepare('SELECT * FROM bulk_jobs WHERE id = ?').get(id) as BulkJob) || null;
}

export function getActiveJob(): BulkJob | null {
  return (db.prepare(
    "SELECT * FROM bulk_jobs WHERE status IN ('running', 'paused') ORDER BY id DESC LIMIT 1"
  ).get() as BulkJob) || null;
}

export function getNextQueuedJob(): BulkJob | null {
  return (db.prepare(
    "SELECT * FROM bulk_jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1"
  ).get() as BulkJob) || null;
}

export function listJobs(opts?: { status?: string; limit?: number; offset?: number }): { jobs: BulkJob[]; total: number } {
  let whereSql = '1=1';
  const params: any[] = [];

  if (opts?.status) {
    whereSql += ' AND status = ?';
    params.push(opts.status);
  }

  const total = (db.prepare(`SELECT COUNT(*) as c FROM bulk_jobs WHERE ${whereSql}`).get(...params) as any)?.c || 0;

  const limit = opts?.limit || 50;
  const offset = opts?.offset || 0;
  const jobs = db.prepare(
    `SELECT * FROM bulk_jobs WHERE ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as BulkJob[];

  return { jobs, total };
}

export function updateJobStatus(id: number, status: string, extra?: {
  total_hg?: number; completed_hg?: number; total_parts_found?: number;
  error_count?: number; last_error?: string;
  last_hg?: string; last_fg?: string; last_bildtafel?: string;
}): void {
  const sets = ["status = ?", "updated_at = datetime('now')"];
  const params: any[] = [status];

  if (status === 'running' && !getJob(id)?.started_at) {
    sets.push("started_at = datetime('now')");
  }
  if (status === 'completed' || status === 'failed') {
    sets.push("completed_at = datetime('now')");
  }

  if (extra) {
    if (extra.total_hg !== undefined) { sets.push('total_hg = ?'); params.push(extra.total_hg); }
    if (extra.completed_hg !== undefined) { sets.push('completed_hg = ?'); params.push(extra.completed_hg); }
    if (extra.total_parts_found !== undefined) { sets.push('total_parts_found = ?'); params.push(extra.total_parts_found); }
    if (extra.error_count !== undefined) { sets.push('error_count = ?'); params.push(extra.error_count); }
    if (extra.last_error !== undefined) { sets.push('last_error = ?'); params.push(extra.last_error); }
    if (extra.last_hg !== undefined) { sets.push('last_hg = ?'); params.push(extra.last_hg); }
    if (extra.last_fg !== undefined) { sets.push('last_fg = ?'); params.push(extra.last_fg); }
    if (extra.last_bildtafel !== undefined) { sets.push('last_bildtafel = ?'); params.push(extra.last_bildtafel); }
  }

  params.push(id);
  db.prepare(`UPDATE bulk_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function incrementJobParts(jobId: number, count: number): void {
  db.prepare(`
    UPDATE bulk_jobs SET total_parts_found = total_parts_found + ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(count, jobId);
}

export function incrementJobErrors(jobId: number): void {
  db.prepare(`
    UPDATE bulk_jobs SET error_count = error_count + 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(jobId);
}

export function incrementJobCompletedHg(jobId: number): void {
  db.prepare(`
    UPDATE bulk_jobs SET completed_hg = completed_hg + 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(jobId);
}

// ── Progress Tracking ────────────────────────────────────────────────────────

export function seedProgress(jobId: number, entries: Array<{
  hg_code: string; hg_name?: string;
  fg_code?: string; fg_name?: string;
  bildtafel_id?: string;
}>): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO bulk_progress (job_id, hg_code, hg_name, fg_code, fg_name, bildtafel_id, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `);

  const tx = db.transaction(() => {
    for (const e of entries) {
      stmt.run(jobId, e.hg_code, e.hg_name || null, e.fg_code || null, e.fg_name || null, e.bildtafel_id || null);
    }
  });
  tx();
}

export function getNextPendingNode(jobId: number): BulkProgressEntry | null {
  return (db.prepare(`
    SELECT * FROM bulk_progress
    WHERE job_id = ? AND status = 'pending'
    ORDER BY hg_code ASC, COALESCE(fg_code,'') ASC, COALESCE(bildtafel_id,'') ASC
    LIMIT 1
  `).get(jobId) as BulkProgressEntry) || null;
}

export function markNodeComplete(id: number, partsFound: number): void {
  db.prepare(`
    UPDATE bulk_progress SET status = 'completed', parts_found = ?, completed_at = datetime('now')
    WHERE id = ?
  `).run(partsFound, id);
}

export function markNodeFailed(id: number, error: string): void {
  db.prepare(`
    UPDATE bulk_progress SET status = 'failed', error = ?, completed_at = datetime('now')
    WHERE id = ?
  `).run(error, id);
}

export function getJobProgress(jobId: number): {
  total: number; completed: number; failed: number; pending: number;
  byHg: Array<{ hg_code: string; hg_name: string | null; total: number; completed: number; failed: number; parts_found: number }>;
} {
  const counts = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
    FROM bulk_progress WHERE job_id = ?
  `).get(jobId) as any;

  const byHg = db.prepare(`
    SELECT
      hg_code, hg_name,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(parts_found) as parts_found
    FROM bulk_progress WHERE job_id = ?
    GROUP BY hg_code, hg_name
    ORDER BY hg_code ASC
  `).all(jobId) as any[];

  return {
    total: counts?.total || 0,
    completed: counts?.completed || 0,
    failed: counts?.failed || 0,
    pending: counts?.pending || 0,
    byHg,
  };
}

// ── Results ──────────────────────────────────────────────────────────────────

export function insertResults(jobId: number, rows: Array<{
  vin: string; brand: string; model: string;
  oem: string; description?: string; bildtafel?: string;
  hg_code?: string; hg_name?: string; fg_code?: string; fg_name?: string;
}>): number {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO bulk_results
      (job_id, vin, brand, model, oem, description, bildtafel, hg_code, hg_name, fg_code, fg_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const result = stmt.run(
        jobId, r.vin, r.brand, r.model,
        r.oem.replace(/\s+/g, ' ').trim(),
        r.description || null, r.bildtafel || null,
        r.hg_code || null, r.hg_name || null,
        r.fg_code || null, r.fg_name || null
      );
      if (result.changes > 0) inserted++;
    }
  });
  tx();

  // Auto-export to WhatsApp-Bot OEM database (fire-and-forget)
  if (inserted > 0) {
    autoExportToOemDb(rows).catch(() => { /* silent — don't block scraping */ });
  }

  return inserted;
}

/** Push OEMs to WhatsApp-Bot OEM database automatically */
async function autoExportToOemDb(rows: Array<{
  oem: string; brand: string; model: string; description?: string;
  hg_code?: string; hg_name?: string; fg_code?: string; fg_name?: string;
}>): Promise<void> {
  const { config } = require('./config');
  const wwsUrl = config.wwsBotUrl;
  const token = config.adminToken;

  if (!wwsUrl || wwsUrl === 'http://localhost:3000') return; // Not configured
  if (!token) return;

  const HG_CATEGORY_MAP: Record<string, string> = {
    '1': 'engine', '2': 'fuel', '3': 'transmission', '4': 'steering',
    '5': 'suspension', '6': 'brake', '7': 'clutch', '8': 'body',
    '9': 'electrical', '0': 'accessories',
  };

  const records = rows.map(r => ({
    oem: r.oem,
    brand: r.brand,
    model: r.model,
    description: r.description,
    part_category: HG_CATEGORY_MAP[r.hg_code || ''] || r.hg_name?.toLowerCase() || 'other',
  }));

  try {
    await fetch(`${wwsUrl}/api/admin/oem-database/bulk-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Token ${token}` },
      body: JSON.stringify({ records, source: 'partslink24-bulk-auto' }),
    });
  } catch { /* silent */ }
}

export function getResults(jobId: number, opts?: {
  limit?: number; offset?: number; search?: string; brand?: string;
}): { results: BulkResultRow[]; total: number } {
  let whereSql = 'job_id = ?';
  const params: any[] = [jobId];

  if (opts?.search) {
    whereSql += ' AND (oem LIKE ? OR description LIKE ?)';
    params.push(`%${opts.search}%`, `%${opts.search}%`);
  }
  if (opts?.brand) {
    whereSql += ' AND brand = ?';
    params.push(opts.brand.toUpperCase());
  }

  const total = (db.prepare(`SELECT COUNT(*) as c FROM bulk_results WHERE ${whereSql}`).get(...params) as any)?.c || 0;

  const limit = opts?.limit || 50;
  const offset = opts?.offset || 0;
  const results = db.prepare(
    `SELECT * FROM bulk_results WHERE ${whereSql} ORDER BY hg_code ASC, fg_code ASC, oem ASC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as BulkResultRow[];

  return { results, total };
}

export function getAllResultsForExport(jobIds?: number[]): BulkResultRow[] {
  if (jobIds && jobIds.length > 0) {
    const placeholders = jobIds.map(() => '?').join(',');
    return db.prepare(
      `SELECT DISTINCT oem, description, brand, model, hg_code, hg_name, fg_code, fg_name, vin
       FROM bulk_results WHERE job_id IN (${placeholders})
       ORDER BY brand, oem`
    ).all(...jobIds) as BulkResultRow[];
  }
  return db.prepare(
    `SELECT DISTINCT oem, description, brand, model, hg_code, hg_name, fg_code, fg_name, vin
     FROM bulk_results ORDER BY brand, oem`
  ).all() as BulkResultRow[];
}

// ── Global Stats ─────────────────────────────────────────────────────────────

export function getBulkStats(): {
  totalVehicles: number;
  activeVehicles: number;
  totalJobs: number;
  totalResults: number;
  resultsByBrand: Array<{ brand: string; count: number }>;
} {
  const totalVehicles = (db.prepare('SELECT COUNT(*) as c FROM vehicles').get() as any)?.c || 0;
  const activeVehicles = (db.prepare('SELECT COUNT(*) as c FROM vehicles WHERE is_active = 1').get() as any)?.c || 0;
  const totalJobs = (db.prepare('SELECT COUNT(*) as c FROM bulk_jobs').get() as any)?.c || 0;
  const totalResults = (db.prepare('SELECT COUNT(*) as c FROM bulk_results').get() as any)?.c || 0;
  const resultsByBrand = db.prepare(
    'SELECT brand, COUNT(DISTINCT oem) as count FROM bulk_results GROUP BY brand ORDER BY count DESC'
  ).all() as Array<{ brand: string; count: number }>;

  return { totalVehicles, activeVehicles, totalJobs, totalResults, resultsByBrand };
}

// ── Startup Recovery ─────────────────────────────────────────────────────────

export function recoverRunningJobs(): number {
  const result = db.prepare(`
    UPDATE bulk_jobs SET status = 'paused', last_error = 'Process restart — auto-paused', updated_at = datetime('now')
    WHERE status = 'running'
  `).run();

  if (result.changes > 0) {
    logger.warn(`Recovered ${result.changes} running job(s) — marked as paused`);
  }
  return result.changes;
}
