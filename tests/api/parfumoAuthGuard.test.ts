describe('requireParfumoAuthEnabled', () => {
  const originalEnv = process.env.PARFUMO_AUTH_ENABLED;

  afterEach(() => {
    process.env.PARFUMO_AUTH_ENABLED = originalEnv;
    jest.resetModules();
  });

  function load(enabled: string | undefined) {
    if (enabled === undefined) delete process.env.PARFUMO_AUTH_ENABLED;
    else process.env.PARFUMO_AUTH_ENABLED = enabled;
    jest.resetModules();
    return require('../../src/api/middleware/parfumoAuthGuard').requireParfumoAuthEnabled;
  }

  function mockRes() {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  }

  it('passes through when enabled (default)', () => {
    const guard = load(undefined);
    const next = jest.fn();
    const res = mockRes();
    guard({} as any, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 503 when PARFUMO_AUTH_ENABLED=false', () => {
    const guard = load('false');
    const next = jest.fn();
    const res = mockRes();
    guard({} as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
