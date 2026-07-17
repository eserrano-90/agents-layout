import * as crypto from 'crypto';

export function createBearerAuth(expectedToken: string) {
  return (authorization: string | undefined): boolean => {
    const auth = authorization ?? '';
    const expected = `Bearer ${expectedToken}`;
    const authBuf = Buffer.from(auth);
    const expectedBuf = Buffer.from(expected);
    if (authBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(authBuf, expectedBuf);
  };
}
