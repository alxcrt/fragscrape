/**
 * OpenAPI 3 description of the public API, served at /openapi.json and
 * rendered with Swagger UI at /docs.
 */
const id = (name: string, description: string) => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'integer', minimum: 1 },
});

const cache = {
  name: 'cache',
  in: 'query',
  description: 'Use cached data when fresh. Pass `false` to force a fresh lookup.',
  schema: { type: 'boolean', default: true },
};

const ok = (schema: object, description = 'Success') => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: schema,
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
});

const errors = {
  400: { $ref: '#/components/responses/BadRequest' },
  401: { $ref: '#/components/responses/Unauthorized' },
  404: { $ref: '#/components/responses/NotFound' },
  429: { $ref: '#/components/responses/TooManyRequests' },
};

const json = (schema: object) => ({ required: true, content: { 'application/json': { schema } } });
const message = { type: 'object', properties: { message: { type: 'string' } } };

export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Fragrance API',
    version: '1.0.0',
    description: [
      'Look up perfumes, notes, accords and ratings, browse brands and rankings,',
      'and keep your own saved searches, tags and notes.',
      '',
      'Every `/api` request needs an API key, sent as `X-API-Key: <key>` or',
      '`Authorization: Bearer <key>`. Use **Authorize** to try requests from this page.',
      '',
      'Responses use the envelope `{ success, data, timestamp }`; errors return',
      '`{ success: false, error, timestamp }`.',
    ].join('\n'),
  },
  security: [{ ApiKey: [] }, { Bearer: [] }],
  tags: [
    { name: 'Perfumes', description: 'Search and perfume details' },
    { name: 'Browse', description: 'Brands and rankings' },
    { name: 'Saved searches', description: 'Save a search and work through its results' },
    { name: 'Tags & notes', description: 'Your own tags, notes and interest ratings' },
    { name: 'Cache', description: 'Manage cached lookups' },
    { name: 'System', description: 'Service health' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Health check',
        description: 'Service status. Needs no API key.',
        security: [],
        responses: { 200: { description: 'Healthy' }, 503: { description: 'Unhealthy' } },
      },
    },
    '/api/search': {
      get: {
        tags: ['Perfumes'],
        summary: 'Search perfumes',
        parameters: [
          { name: 'q', in: 'query', required: true, description: 'Search text', schema: { type: 'string', minLength: 1, maxLength: 200, example: 'Aventus' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          cache,
        ],
        responses: { 200: ok({ type: 'array', items: { $ref: '#/components/schemas/SearchResult' } }), ...errors },
      },
    },
    '/api/perfume/{brand}/{name}': {
      get: {
        tags: ['Perfumes'],
        summary: 'Get perfume details',
        description: 'Brand and name are the identifiers returned in search results, e.g. `Creed` / `aventus`.',
        parameters: [
          { name: 'brand', in: 'path', required: true, schema: { type: 'string', example: 'Creed' } },
          { name: 'name', in: 'path', required: true, schema: { type: 'string', example: 'aventus' } },
          { name: 'year', in: 'query', description: 'Release year, to pick between same-named perfumes', schema: { type: 'integer', minimum: 1800 } },
          cache,
        ],
        responses: { 200: ok({ $ref: '#/components/schemas/Perfume' }), ...errors },
      },
    },
    '/api/perfume/by-url': {
      post: {
        tags: ['Perfumes'],
        summary: 'Get perfume details by page URL',
        description: 'Pass the `url` of a perfume as returned by search.',
        parameters: [cache],
        requestBody: json({ type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri', maxLength: 500 } } }),
        responses: { 200: ok({ $ref: '#/components/schemas/Perfume' }), ...errors },
      },
    },
    '/api/brand/{brand}': {
      get: {
        tags: ['Browse'],
        summary: 'List perfumes by brand',
        parameters: [
          { name: 'brand', in: 'path', required: true, schema: { type: 'string', example: 'Creed' } },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 1 } },
        ],
        responses: { 200: ok({ type: 'array', items: { $ref: '#/components/schemas/SearchResult' } }), ...errors },
      },
    },
    '/api/rankings': {
      get: {
        tags: ['Browse'],
        summary: 'Top-ranked perfumes',
        parameters: [
          { name: 'category', in: 'query', required: true, schema: { type: 'string', enum: ['mens', 'womens', 'unisex'] } },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'production', in: 'query', schema: { type: 'string', enum: ['in-production', 'discontinued', 'all'], default: 'all' } },
          { name: 'edition', in: 'query', schema: { type: 'string', enum: ['regular', 'limited', 'collectors', 'all'], default: 'all' } },
        ],
        responses: {
          200: ok({
            type: 'object',
            properties: {
              category: { type: 'string' },
              page: { type: 'integer' },
              items: { type: 'array', items: { type: 'object', properties: { rank: { type: 'integer' }, name: { type: 'string' }, brand: { type: 'string' }, url: { type: 'string' } } } },
            },
          }),
          ...errors,
        },
      },
    },
    '/api/queries': {
      get: {
        tags: ['Saved searches'],
        summary: 'List saved searches with progress',
        responses: { 200: ok({ type: 'array', items: { $ref: '#/components/schemas/SavedQuery' } }), ...errors },
      },
      post: {
        tags: ['Saved searches'],
        summary: 'Save a search and snapshot its results',
        requestBody: json({ type: 'object', required: ['query'], properties: { query: { type: 'string', maxLength: 200, example: 'oud rose' }, name: { type: 'string', maxLength: 100, example: 'Winter shortlist' } } }),
        responses: { 201: ok({ $ref: '#/components/schemas/SavedQuery' }, 'Created'), 200: ok({ $ref: '#/components/schemas/SavedQuery' }), ...errors },
      },
    },
    '/api/queries/{id}': {
      parameters: [id('id', 'Saved search ID')],
      get: { tags: ['Saved searches'], summary: 'Get a saved search with all its items', responses: { 200: ok({ $ref: '#/components/schemas/SavedQuery' }), ...errors } },
      patch: {
        tags: ['Saved searches'],
        summary: 'Rename a saved search',
        requestBody: json({ type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 100 } } }),
        responses: { 200: ok({ $ref: '#/components/schemas/SavedQuery' }), ...errors },
      },
      delete: { tags: ['Saved searches'], summary: 'Delete a saved search', responses: { 200: ok(message), ...errors } },
    },
    '/api/queries/{id}/refresh': {
      post: { tags: ['Saved searches'], summary: 'Re-run the search and add new results', parameters: [id('id', 'Saved search ID')], responses: { 200: ok({ $ref: '#/components/schemas/SavedQuery' }), ...errors } },
    },
    '/api/queries/{id}/next': {
      get: { tags: ['Saved searches'], summary: 'Next unreviewed item', parameters: [id('id', 'Saved search ID')], responses: { 200: ok({ type: 'object' }), ...errors } },
    },
    '/api/queries/{id}/items/{itemId}': {
      patch: {
        tags: ['Saved searches'],
        summary: 'Mark an item reviewed or skipped',
        parameters: [id('id', 'Saved search ID'), id('itemId', 'Item ID')],
        requestBody: json({ type: 'object', properties: { reviewed: { type: 'boolean' }, skipped: { type: 'boolean' } } }),
        responses: { 200: ok({ type: 'object' }), ...errors },
      },
    },
    '/api/perfumes/{id}/tags': {
      parameters: [id('id', 'Stored perfume ID')],
      get: { tags: ['Tags & notes'], summary: 'List tags on a perfume', responses: { 200: ok({ type: 'array', items: { type: 'string' } }), ...errors } },
      post: {
        tags: ['Tags & notes'],
        summary: 'Add a tag',
        description: 'Suggested tags: `want to try`, `tested`, `own`, `pass`. Any text up to 50 characters works.',
        requestBody: json({ type: 'object', required: ['tag'], properties: { tag: { type: 'string', maxLength: 50, example: 'want to try' } } }),
        responses: { 200: ok({ type: 'object' }), ...errors },
      },
    },
    '/api/perfumes/{id}/tags/{tag}': {
      delete: {
        tags: ['Tags & notes'],
        summary: 'Remove a tag',
        parameters: [id('id', 'Stored perfume ID'), { name: 'tag', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: ok(message), ...errors },
      },
    },
    '/api/perfumes/{id}/user-data': {
      parameters: [id('id', 'Stored perfume ID')],
      get: { tags: ['Tags & notes'], summary: 'Get your notes and interest', responses: { 200: ok({ $ref: '#/components/schemas/UserData' }), ...errors } },
      put: {
        tags: ['Tags & notes'],
        summary: 'Set notes and/or interest (1-5)',
        requestBody: json({ $ref: '#/components/schemas/UserData' }),
        responses: { 200: ok({ $ref: '#/components/schemas/UserData' }), ...errors },
      },
      delete: { tags: ['Tags & notes'], summary: 'Clear notes and interest', responses: { 200: ok(message), ...errors } },
    },
    '/api/tags': {
      get: { tags: ['Tags & notes'], summary: 'All tags with counts', responses: { 200: ok({ type: 'array', items: { type: 'object', properties: { tag: { type: 'string' }, count: { type: 'integer' } } } }), ...errors } },
    },
    '/api/collection': {
      get: {
        tags: ['Tags & notes'],
        summary: 'Perfumes with a given tag',
        parameters: [{ name: 'tag', in: 'query', required: true, schema: { type: 'string', example: 'want to try' } }],
        responses: { 200: ok({ type: 'array', items: { $ref: '#/components/schemas/Perfume' } }), ...errors },
      },
    },
    '/api/cleanup': {
      delete: { tags: ['Tags & notes'], summary: 'Delete every perfume tagged `pass`', responses: { 200: ok(message), ...errors } },
    },
    '/api/cache': {
      delete: {
        tags: ['Cache'],
        summary: 'Clear cached lookups',
        parameters: [{ name: 'type', in: 'query', schema: { type: 'string', enum: ['all', 'perfumes', 'search', 'expired'], default: 'all' } }],
        responses: { 200: ok(message), ...errors },
      },
    },
    '/api/cache/error-pages': {
      delete: { tags: ['Cache'], summary: 'Remove cached failed lookups', responses: { 200: ok(message), ...errors } },
    },
  },
  components: {
    securitySchemes: {
      ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      Bearer: { type: 'http', scheme: 'bearer' },
    },
    responses: {
      BadRequest: { description: 'Invalid parameters', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      Unauthorized: { description: 'Missing or invalid API key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      NotFound: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      TooManyRequests: { description: 'Rate limit exceeded' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: { success: { type: 'boolean', example: false }, error: { type: 'string' }, timestamp: { type: 'string', format: 'date-time' } },
      },
      SearchResult: {
        type: 'object',
        properties: {
          name: { type: 'string', example: 'Aventus' },
          brand: { type: 'string', example: 'Creed' },
          year: { type: 'integer' },
          url: { type: 'string' },
          imageUrl: { type: 'string' },
          rating: { type: 'number' },
        },
      },
      Perfume: {
        type: 'object',
        properties: {
          name: { type: 'string', example: 'Aventus' },
          brand: { type: 'string', example: 'Creed' },
          year: { type: 'integer' },
          url: { type: 'string' },
          imageUrl: { type: 'string' },
          concentration: { type: 'string' },
          gender: { type: 'string', enum: ['male', 'female', 'unisex'] },
          description: { type: 'string' },
          notes: {
            type: 'object',
            properties: {
              top: { type: 'array', items: { type: 'string' }, example: ['Bergamot', 'Apple'] },
              heart: { type: 'array', items: { type: 'string' } },
              base: { type: 'array', items: { type: 'string' } },
            },
          },
          accords: { type: 'array', items: { type: 'string' }, example: ['Fresh', 'Fruity'] },
          rating: { type: 'number', description: 'Overall scent rating (0-10)', example: 8.4 },
          totalRatings: { type: 'integer' },
          longevity: { type: 'number' },
          longevityRatingCount: { type: 'integer' },
          sillage: { type: 'number' },
          sillageRatingCount: { type: 'integer' },
          bottleRating: { type: 'number' },
          bottleRatingCount: { type: 'integer' },
          priceValue: { type: 'number' },
          priceValueRatingCount: { type: 'integer' },
          reviewCount: { type: 'integer' },
          statementCount: { type: 'integer' },
          photoCount: { type: 'integer' },
          rank: { type: 'integer' },
          rankCategory: { type: 'string' },
          perfumer: { type: 'string' },
          productionStatus: { type: 'string', enum: ['in-production', 'discontinued', 'unknown'] },
          similarFragrances: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, brand: { type: 'string' }, url: { type: 'string' }, similarity: { type: 'number' } } },
          },
          scrapedAt: { type: 'string', format: 'date-time', description: 'When the data was fetched' },
          _cached: { type: 'boolean', description: 'Present when served from cache' },
        },
      },
      SavedQuery: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          query: { type: 'string' },
        },
        additionalProperties: true,
      },
      UserData: {
        type: 'object',
        properties: {
          notes: { type: 'string', maxLength: 5000, example: 'Smoky, leathery. Try in winter.' },
          interest: { type: 'integer', minimum: 1, maximum: 5, example: 4 },
        },
      },
    },
  },
};
