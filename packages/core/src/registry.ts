import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

export interface AppEntry {
  readonly name: string;
  readonly leaseUuid: string;
  readonly size?: string;
  readonly providerUuid?: string;
  readonly providerUrl?: string;
  readonly createdAt?: string;
  readonly url?: string;
  readonly connection?: Record<string, unknown>;
  readonly status: string;
  readonly manifest?: string;
}

export interface AppRegistry {
  getApps(address: string): AppEntry[];
  /** Throws ManifestMCPError if not found */
  getApp(address: string, name: string): AppEntry;
  findApp(address: string, name: string): AppEntry | undefined;
  getAppByLease(address: string, leaseUuid: string): AppEntry | undefined;
  addApp(address: string, entry: AppEntry): void;
  updateApp(address: string, leaseUuid: string, updates: Partial<Omit<AppEntry, 'leaseUuid'>>): void;
  removeApp(address: string, leaseUuid: string): void;
}

export class InMemoryAppRegistry implements AppRegistry {
  private store = new Map<string, Map<string, AppEntry>>();

  private getOrCreate(address: string): Map<string, AppEntry> {
    let apps = this.store.get(address);
    if (!apps) {
      apps = new Map();
      this.store.set(address, apps);
    }
    return apps;
  }

  getApps(address: string): AppEntry[] {
    const apps = this.store.get(address);
    return apps ? Array.from(apps.values()) : [];
  }

  getApp(address: string, name: string): AppEntry {
    const entry = this.findApp(address, name);
    if (!entry) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        `App "${name}" not found`,
      );
    }
    return entry;
  }

  findApp(address: string, name: string): AppEntry | undefined {
    const apps = this.store.get(address);
    if (!apps) return undefined;
    for (const entry of apps.values()) {
      if (entry.name === name) return entry;
    }
    return undefined;
  }

  getAppByLease(address: string, leaseUuid: string): AppEntry | undefined {
    const apps = this.store.get(address);
    return apps?.get(leaseUuid);
  }

  addApp(address: string, entry: AppEntry): void {
    const apps = this.getOrCreate(address);
    apps.set(entry.leaseUuid, entry);
  }

  updateApp(address: string, leaseUuid: string, updates: Partial<Omit<AppEntry, 'leaseUuid'>>): void {
    const apps = this.store.get(address);
    const existing = apps?.get(leaseUuid);
    if (existing) {
      apps!.set(leaseUuid, { ...existing, ...updates });
    }
  }

  removeApp(address: string, leaseUuid: string): void {
    const apps = this.store.get(address);
    apps?.delete(leaseUuid);
  }
}
