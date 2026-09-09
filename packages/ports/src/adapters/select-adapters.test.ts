import { describe, expect, it } from 'vitest';
import { ADAPTER_SLOTS } from '../gates';
import { S3ObjectStorage } from './s3/s3-object-storage';
import { Secret } from './secret';
import {
  AdapterSelectionError,
  PRODUCTION_ADAPTERS,
  defaultAdapterModes,
  selectAdapters,
} from './select-adapters';
import {
  SimulatedObjectStorage,
  SimulatedPaymentGateway,
  UnavailableEBarimt,
  UnavailableObjectStorage,
  UnavailablePaymentGateway,
  UnavailableSms,
} from '../index';

const STORAGE = {
  endpoint: 'http://127.0.0.1:59000',
  region: 'us-east-1',
  bucket: 'prsystem-local',
  accessKeyId: 'prsystem_local',
  secretAccessKey: new Secret('phase-20-selection-canary'),
};

describe('selectAdapters', () => {
  it('defaults to simulators below production and to nothing above it', () => {
    expect(new Set(Object.values(defaultAdapterModes('ci')))).toEqual(new Set(['simulator']));
    expect(new Set(Object.values(defaultAdapterModes('production')))).toEqual(
      new Set(['disabled']),
    );
    expect(new Set(Object.values(defaultAdapterModes('staging')))).toEqual(new Set(['disabled']));
  });

  it('builds simulators in test and the fail-closed adapters in production', () => {
    const simulated = selectAdapters({ appEnv: 'test', slots: defaultAdapterModes('test') });
    expect(simulated.payments.gateway('QPAY')).toBeInstanceOf(SimulatedPaymentGateway);
    expect(simulated.storage).toBeInstanceOf(SimulatedObjectStorage);
    expect(simulated.describe().every((one) => one.mode === 'simulator')).toBe(true);

    const production = selectAdapters({
      appEnv: 'production',
      slots: defaultAdapterModes('production'),
    });
    expect(production.payments.gateway('KHAAN')).toBeInstanceOf(UnavailablePaymentGateway);
    expect(production.ebarimt).toBeInstanceOf(UnavailableEBarimt);
    expect(production.sms).toBeInstanceOf(UnavailableSms);
    expect(production.storage).toBeInstanceOf(UnavailableObjectStorage);
    const described = production.describe();
    expect(described.every((one) => one.mode === 'disabled' && one.cleared === false)).toBe(true);
    expect(described.map((one) => one.slot)).toEqual([...ADAPTER_SLOTS]);
    expect(JSON.stringify(described)).not.toContain('59000');
  });

  it('refuses a simulator anywhere above test, naming the slot', () => {
    for (const appEnv of ['staging', 'production']) {
      let caught: unknown;
      try {
        selectAdapters({
          appEnv,
          slots: { ...defaultAdapterModes(appEnv), sms: 'simulator' },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AdapterSelectionError);
      expect(caught).toMatchObject({
        slot: 'sms',
        reason: 'simulator_not_permitted',
        gate: 'EXT-05',
      });
    }
  });

  it('refuses a production adapter whose gate is not cleared, naming the gate', () => {
    let caught: unknown;
    try {
      selectAdapters({
        appEnv: 'production',
        slots: { ...defaultAdapterModes('production'), storage: 's3' },
        storage: STORAGE,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AdapterSelectionError);
    expect(caught).toMatchObject({
      slot: 'storage',
      reason: 'gate_not_cleared',
      gate: 'INT-STORAGE-01',
    });
    expect(String(caught)).toContain('INT-STORAGE-01');
    expect(String(caught)).not.toContain('phase-20-selection-canary');
  });

  it('refuses an adapter that does not exist, for every contract-bound slot', () => {
    for (const slot of ADAPTER_SLOTS) {
      if (PRODUCTION_ADAPTERS[slot].length > 0) continue;
      let caught: unknown;
      try {
        selectAdapters({
          appEnv: 'test',
          slots: { ...defaultAdapterModes('test'), [slot]: 'live' },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ slot, reason: 'unknown_adapter' });
    }
  });

  it('runs the s3 adapter below production against a local stand-in, and needs its configuration', () => {
    const selected = selectAdapters({
      appEnv: 'ci',
      slots: { ...defaultAdapterModes('ci'), storage: 's3' },
      storage: STORAGE,
    });
    expect(selected.storage).toBeInstanceOf(S3ObjectStorage);
    expect(selected.describe().find((one) => one.slot === 'storage')).toEqual({
      slot: 'storage',
      gate: 'INT-STORAGE-01',
      cleared: false,
      mode: 'adapter',
      adapter: 's3',
    });
    expect(() =>
      selectAdapters({ appEnv: 'ci', slots: { ...defaultAdapterModes('ci'), storage: 's3' } }),
    ).toThrow(AdapterSelectionError);
  });
});
