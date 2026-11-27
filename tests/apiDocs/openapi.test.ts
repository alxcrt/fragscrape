import { openapiSpec } from '../../src/apiDocs/openapi';

describe('openapi spec', () => {
  const text = JSON.stringify(openapiSpec).toLowerCase();

  it('does not name any upstream data source', () => {
    for (const word of ['parfumo', 'fragrantica', 'decodo', 'scraping']) {
      expect(text).not.toContain(word);
    }
  });

  it('documents the public routes and no account routes', () => {
    const paths = Object.keys(openapiSpec.paths);
    expect(paths).toEqual(expect.arrayContaining(['/health', '/api/search', '/api/perfume/{brand}/{name}', '/api/rankings', '/api/queries']));
    expect(paths.some((p) => p.startsWith('/api/auth') || p.startsWith('/api/parfumo') || p.startsWith('/api/sync') || p.startsWith('/api/proxy'))).toBe(false);
  });

  it('declares API key auth and leaves /health open', () => {
    expect(openapiSpec.components.securitySchemes.ApiKey).toMatchObject({ in: 'header', name: 'X-API-Key' });
    expect((openapiSpec.paths['/health'].get as any).security).toEqual([]);
  });

  it('only references components that exist', () => {
    const refs = [...JSON.stringify(openapiSpec).matchAll(/"#\/components\/(\w+)\/(\w+)"/g)];
    for (const [, kind, name] of refs) {
      expect((openapiSpec.components as any)[kind][name]).toBeDefined();
    }
  });
});
