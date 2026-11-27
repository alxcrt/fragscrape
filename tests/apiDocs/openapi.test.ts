import { openapiSpec } from '../../src/apiDocs/openapi';

describe('openapi spec', () => {
  const text = JSON.stringify(openapiSpec).toLowerCase();

  it('does not name any upstream data source', () => {
    for (const word of ['parfumo', 'fragrantica', 'decodo', 'scraping']) expect(text).not.toContain(word);
  });

  it('documents the simple API only', () => {
    expect(Object.keys(openapiSpec.paths).sort()).toEqual([
      '/api/autocomplete', '/api/brands/{name}', '/api/match', '/api/perfumes/{id}', '/api/rankings', '/health', '/images/{id}.webp',
    ]);
  });

  it('declares API key auth and leaves health and images open', () => {
    expect(openapiSpec.components.securitySchemes.ApiKey).toMatchObject({ in: 'header', name: 'X-API-Key' });
    expect((openapiSpec.paths['/health'].get as any).security).toEqual([]);
    expect((openapiSpec.paths['/images/{id}.webp'].get as any).security).toEqual([]);
  });

  it('only references components that exist', () => {
    for (const [, kind, name] of JSON.stringify(openapiSpec).matchAll(/"#\/components\/(\w+)\/(\w+)"/g)) {
      expect((openapiSpec.components as any)[kind][name]).toBeDefined();
    }
  });
});
