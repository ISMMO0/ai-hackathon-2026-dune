import { makeOauthBearer } from '@antasphere/chassis-server/testing';

/**
 * The tool's binding of the shared SSO dances (`@antasphere/chassis-server/testing`):
 * the same helpers, with the OAuth dance requesting the items read scope.
 */
export {
  json,
  nextIp,
  seedLocalWorkspace,
  ssoInitiate,
  ssoDance,
  ssoLogin,
  expectFailedLogin
} from '@antasphere/chassis-server/testing';

export const oauthBearer = makeOauthBearer('openid items:read');
