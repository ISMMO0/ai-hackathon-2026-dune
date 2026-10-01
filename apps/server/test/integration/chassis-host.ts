import { IDENTITY } from '@app/contract';
import type { ChassisTestHost } from '@antasphere/chassis-server/testing';
import { boot, type BootOverrides, type BootResult } from '../../src/boot.js';

/**
 * The tool's host of the chassis suite
 * (`packages/chassis-server/test/integration`, run a second time by this app's
 * integration config): the tool's real composition, the items scope names,
 * and the items list as the probe route — the values those files spelled
 * before they moved. `@chassis-test/host` resolves here under
 * `vitest.integration.config.ts`.
 */
export type HostBootResult = BootResult;
export type HostBootOverrides = BootOverrides;

export const host: ChassisTestHost<HostBootResult, HostBootOverrides> = {
  boot,
  identity: IDENTITY,
  hubClientId: 'tool-starter-cloud',
  scopes: { read: 'items:read', write: 'items:write', dataExport: 'data:export' },
  probeRoute: '/api/v1/items'
};
