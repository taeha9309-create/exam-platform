import { beforeEach, describe, expect, it, vi } from 'vitest';

const ioMock = vi.fn(() => ({}));
vi.mock('socket.io-client', () => ({ io: (...args: unknown[]) => ioMock(...(args as [])) }));

import { connectStaffSocket, connectStudentSocket } from './socket';

beforeEach(() => ioMock.mockClear());

describe('소켓 연결', () => {
  it('학생 소켓은 auth에 정확히 { sessionToken }만 넘긴다(SPEC 7.2)', () => {
    connectStudentSocket('tok');
    const opts = (ioMock.mock.calls[0] as unknown[])[0] as { auth?: unknown };
    expect(opts.auth).toEqual({ sessionToken: 'tok' });
  });

  it('교수자 소켓은 withCredentials: true이고 auth가 없다', () => {
    connectStaffSocket();
    const opts = (ioMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(opts.withCredentials).toBe(true);
    expect(opts.auth).toBeUndefined();
  });
});
