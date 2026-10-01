/**
 * The generic harness lives in `@antasphere/chassis-cli/testing`; it is
 * re-exported here so the tool's tests keep one import. The tool's own
 * fixtures join it with the items series.
 */
export {
  routedHarness,
  tempConfigEnv,
  type RecordedCall,
  type Route,
  type WireCall
} from '@antasphere/chassis-cli/testing';
