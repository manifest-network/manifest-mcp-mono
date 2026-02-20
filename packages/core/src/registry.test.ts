import { describe, it, expect } from 'vitest';
import { InMemoryAppRegistry } from './registry.js';
import { ManifestMCPError } from './types.js';

describe('InMemoryAppRegistry', () => {
  const address = 'manifest1test';

  function makeEntry(name: string, leaseUuid: string) {
    return { name, leaseUuid, status: 'active' };
  }

  it('should return empty array for unknown address', () => {
    const reg = new InMemoryAppRegistry();
    expect(reg.getApps(address)).toEqual([]);
  });

  it('should add and retrieve apps', () => {
    const reg = new InMemoryAppRegistry();
    const entry = makeEntry('myapp', 'lease-1');
    reg.addApp(address, entry);
    expect(reg.getApps(address)).toEqual([entry]);
  });

  it('should find app by name', () => {
    const reg = new InMemoryAppRegistry();
    const entry = makeEntry('myapp', 'lease-1');
    reg.addApp(address, entry);
    expect(reg.findApp(address, 'myapp')).toEqual(entry);
  });

  it('should return undefined for missing app via findApp', () => {
    const reg = new InMemoryAppRegistry();
    expect(reg.findApp(address, 'nonexistent')).toBeUndefined();
  });

  it('should throw on getApp for missing app', () => {
    const reg = new InMemoryAppRegistry();
    expect(() => reg.getApp(address, 'nonexistent')).toThrow(ManifestMCPError);
  });

  it('should get app by lease UUID', () => {
    const reg = new InMemoryAppRegistry();
    const entry = makeEntry('myapp', 'lease-1');
    reg.addApp(address, entry);
    expect(reg.getAppByLease(address, 'lease-1')).toEqual(entry);
  });

  it('should update an existing app', () => {
    const reg = new InMemoryAppRegistry();
    reg.addApp(address, makeEntry('myapp', 'lease-1'));
    reg.updateApp(address, 'lease-1', { status: 'stopped' });
    const updated = reg.getApp(address, 'myapp');
    expect(updated.status).toBe('stopped');
    expect(updated.leaseUuid).toBe('lease-1');
  });

  it('should silently ignore updates for non-existent entries', () => {
    const reg = new InMemoryAppRegistry();
    // Should not throw
    reg.updateApp(address, 'no-such-lease', { status: 'stopped' });
  });

  it('should remove an app', () => {
    const reg = new InMemoryAppRegistry();
    reg.addApp(address, makeEntry('myapp', 'lease-1'));
    reg.removeApp(address, 'lease-1');
    expect(reg.getApps(address)).toEqual([]);
  });

  it('should isolate apps by address', () => {
    const reg = new InMemoryAppRegistry();
    reg.addApp('addr1', makeEntry('app1', 'l1'));
    reg.addApp('addr2', makeEntry('app2', 'l2'));
    expect(reg.getApps('addr1')).toHaveLength(1);
    expect(reg.getApps('addr1')[0].name).toBe('app1');
    expect(reg.getApps('addr2')).toHaveLength(1);
    expect(reg.getApps('addr2')[0].name).toBe('app2');
  });
});
