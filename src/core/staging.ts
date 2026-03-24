import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getConfig } from '../utils/config.js';
import logger from '../utils/logger.js';

const log = logger.child('staging');

export interface StagedChange {
  id: string;
  filePath: string;
  originalContent: string;
  newContent: string;
  stagedAt: Date;
  stagingDir: string;
}

export class StagingEngine {
  private stagingBase: string;
  private activeChanges: Map<string, StagedChange> = new Map();

  constructor() {
    const config = getConfig();
    this.stagingBase = config.staging.directory;
    this.ensureStagingDir();
  }

  private ensureStagingDir(): void {
    if (!fs.existsSync(this.stagingBase)) {
      fs.mkdirSync(this.stagingBase, { recursive: true });
      log.debug(`Created staging directory: ${this.stagingBase}`);
    }
  }

  /**
   * Stage a file change. Copies the original to staging, writes the new content
   * to the staging area. Does NOT touch the real filesystem.
   */
  stage(filePath: string, newContent: string): StagedChange {
    const absolutePath = path.resolve(filePath);
    const changeId = uuidv4();
    const stagingDir = path.join(this.stagingBase, changeId);

    fs.mkdirSync(stagingDir, { recursive: true });

    // Read original content (or empty string if file doesn't exist yet)
    let originalContent = '';
    if (fs.existsSync(absolutePath)) {
      try {
        originalContent = fs.readFileSync(absolutePath, 'utf-8');
      } catch (err) {
        log.warn(`Could not read original file ${absolutePath}:`, err);
      }
    }

    // Write original to staging (for reference / rollback)
    const originalStagingPath = path.join(stagingDir, 'original');
    const newStagingPath = path.join(stagingDir, 'new');

    try {
      fs.writeFileSync(originalStagingPath, originalContent, 'utf-8');
      fs.writeFileSync(newStagingPath, newContent, 'utf-8');
    } catch (err) {
      log.error(`Failed to write staged files for change ${changeId}:`, err);
      throw new Error(`Staging failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Store metadata
    const metaPath = path.join(stagingDir, 'meta.json');
    const meta = {
      id: changeId,
      filePath: absolutePath,
      stagedAt: new Date().toISOString(),
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

    const change: StagedChange = {
      id: changeId,
      filePath: absolutePath,
      originalContent,
      newContent,
      stagedAt: new Date(),
      stagingDir,
    };

    this.activeChanges.set(changeId, change);
    log.info(`Staged change ${changeId} for ${absolutePath}`);

    return change;
  }

  /**
   * Retrieve the original content of a staged change.
   */
  getOriginal(changeId: string): string {
    const change = this.activeChanges.get(changeId);
    if (change) {
      return change.originalContent;
    }

    // Try to load from disk
    const originalPath = path.join(this.stagingBase, changeId, 'original');
    if (fs.existsSync(originalPath)) {
      return fs.readFileSync(originalPath, 'utf-8');
    }

    throw new Error(`No staged change found with id: ${changeId}`);
  }

  /**
   * Get staged new content for a change.
   */
  getStaged(changeId: string): string {
    const change = this.activeChanges.get(changeId);
    if (change) {
      return change.newContent;
    }

    const newPath = path.join(this.stagingBase, changeId, 'new');
    if (fs.existsSync(newPath)) {
      return fs.readFileSync(newPath, 'utf-8');
    }

    throw new Error(`No staged content found for change id: ${changeId}`);
  }

  /**
   * Load a change from disk (for recovery after restart).
   */
  load(changeId: string): StagedChange | null {
    const stagingDir = path.join(this.stagingBase, changeId);
    const metaPath = path.join(stagingDir, 'meta.json');

    if (!fs.existsSync(metaPath)) return null;

    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
        id: string;
        filePath: string;
        stagedAt: string;
      };
      const originalContent = fs.readFileSync(path.join(stagingDir, 'original'), 'utf-8');
      const newContent = fs.readFileSync(path.join(stagingDir, 'new'), 'utf-8');

      const change: StagedChange = {
        id: meta.id,
        filePath: meta.filePath,
        originalContent,
        newContent,
        stagedAt: new Date(meta.stagedAt),
        stagingDir,
      };

      this.activeChanges.set(changeId, change);
      return change;
    } catch (err) {
      log.warn(`Failed to load staged change ${changeId}:`, err);
      return null;
    }
  }

  /**
   * Apply a staged change to the real filesystem.
   */
  apply(changeId: string): void {
    const change = this.activeChanges.get(changeId) ?? this.load(changeId);
    if (!change) {
      throw new Error(`Cannot apply: staged change ${changeId} not found`);
    }

    // Ensure parent directory exists
    const dir = path.dirname(change.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      fs.writeFileSync(change.filePath, change.newContent, 'utf-8');
      log.info(`Applied change ${changeId} → ${change.filePath}`);
    } catch (err) {
      log.error(`Failed to apply change ${changeId}:`, err);
      throw new Error(`Apply failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.cleanup(changeId);
  }

  /**
   * Reject a staged change and clean up.
   */
  reject(changeId: string): void {
    log.info(`Rejected change ${changeId}`);
    this.cleanup(changeId);
  }

  /**
   * Remove staging directory for a change.
   */
  private cleanup(changeId: string): void {
    this.activeChanges.delete(changeId);
    const stagingDir = path.join(this.stagingBase, changeId);
    if (fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  /**
   * List all pending staged change IDs from disk.
   */
  listPending(): string[] {
    if (!fs.existsSync(this.stagingBase)) return [];
    return fs.readdirSync(this.stagingBase).filter((entry) => {
      const metaPath = path.join(this.stagingBase, entry, 'meta.json');
      return fs.existsSync(metaPath);
    });
  }

  getStagingBase(): string {
    return this.stagingBase;
  }
}

// Singleton
let _engine: StagingEngine | null = null;

export function getStagingEngine(): StagingEngine {
  if (!_engine) {
    _engine = new StagingEngine();
  }
  return _engine;
}
