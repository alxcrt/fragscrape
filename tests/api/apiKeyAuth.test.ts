describe('apiKeyAuth', () => {
  const original = process.env.API_KEYS;
  const KEY = 'test-key-0123456789abcdef';

  afterEach(() => {
    process.env.API_KEYS = original;
    jest.resetModules();
  });

  function load(keys: string | undefined) {
    if (keys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = keys;
    jest.resetModules();
    return require('../../src/api/middleware/apiKeyAuth').apiKeyAuth;
  }

  function req(headers: Record<string, string>) {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return { get: (name: string) => lower[name.toLowerCase()] } as any;
  }

  function res() {
    const r: any = {};
    r.status = jest.fn().mockReturnValue(r);
    r.json = jest.fn().mockReturnValue(r);
    r.setHeader = jest.fn();
    return r;
  }

  it('is open when no keys are configured', () => {
    const auth = load(undefined);
    const next = jest.fn();
    auth(req({}), res(), next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects a missing key with 401', () => {
    const auth = load(KEY);
    const next = jest.fn();
    const r = res();
    auth(req({}), r, next);
    expect(next).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(401);
  });

  it('rejects a wrong key', () => {
    const auth = load(KEY);
    const next = jest.fn();
    const r = res();
    auth(req({ 'X-API-Key': 'wrong-key-0123456789abcdef' }), r, next);
    expect(next).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(401);
  });

  it('accepts X-API-Key', () => {
    const auth = load(KEY);
    const next = jest.fn();
    auth(req({ 'X-API-Key': KEY }), res(), next);
    expect(next).toHaveBeenCalled();
  });

  it('accepts Authorization: Bearer and any of several keys', () => {
    const auth = load(`other-key-0123456789abcdef, ${KEY}`);
    const next = jest.fn();
    auth(req({ Authorization: `Bearer ${KEY}` }), res(), next);
    expect(next).toHaveBeenCalled();
  });
});
