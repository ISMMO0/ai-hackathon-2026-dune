import { createPlatform } from '@antasphere/chassis-server';
import { theTool, type ToolBootOverrides, type ToolBootResult } from './tool.js';

/**
 * The tool's boot: the chassis' locked composition (`createPlatform`,
 * `@antasphere/chassis-server`) bound to the tool definition
 * (`tool.ts`). The sequence itself — env → logger → db probe → secret →
 * migrations under advisory lock → app assembly → ready — lives in the chassis.
 */
const platform = createPlatform(theTool);

/** Test seams only — production boot never passes overrides. */
export type BootOverrides = ToolBootOverrides;
export type BootResult = ToolBootResult;

export const boot = (source?: NodeJS.ProcessEnv, overrides?: BootOverrides): Promise<BootResult> =>
  platform.boot(source, overrides);
