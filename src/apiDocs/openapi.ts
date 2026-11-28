/**
 * OpenAPI 3 description of the API, served at /openapi.json and rendered
 * with Swagger UI at /docs.
 */
import { integrationGuide, API_VERSION } from './guide';

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

const item = { $ref: '#/components/schemas/Perfume' };
const matched = { allOf: [item, { type: 'object', properties: { confidence: { type: 'number', minimum: 0, maximum: 1, example: 0.93 } } }] };
const matchResult = {
  type: 'object',
  properties: {
    match: { ...matched, nullable: true, description: 'Best match, or null when nothing is close enough' },
    alternatives: { type: 'array', items: matched },
  },
};

export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Fragrance API',
    version: API_VERSION,
    description: [
      'Find perfumes fast: autocomplete while typing, match messy text (for example a label read from a photo),',
      'and get details with notes, accords, ratings and similar perfumes.',
      '',
      '**Auth:** every `/api` request needs an API key, sent as `X-API-Key: <key>` or `Authorization: Bearer <key>`.',
      'Use **Authorize** to try requests here. Images under `/images` need no key, so they work in `<img>` tags.',
      '',
      '**IDs:** every perfume has a numeric `id`; use it with `/api/perfumes/{id}` and `/images/{id}.webp`.',
      '',
      'Responses use `{ success, data, timestamp }`; errors return `{ success: false, error, timestamp }`.',
    ].join('\n') + '\n' + integrationGuide,
  },
  security: [{ ApiKey: [] }, { Bearer: [] }],
  tags: [
    { name: 'Search', description: 'Autocomplete and matching' },
    { name: 'Perfumes', description: 'Details, brands and rankings' },
    { name: 'Images', description: 'Optimised WebP images' },
    { name: 'System', description: 'Service health' },
  ],
  paths: {
    '/api/autocomplete': {
      get: {
        tags: ['Search'],
        summary: 'Suggestions while typing',
        description: 'Prefix and typo tolerant, popular perfumes first. Call it on each keystroke (debounce ~150 ms).',
        parameters: [
          { name: 'q', in: 'query', required: true, description: 'Text typed so far', schema: { type: 'string', maxLength: 100, example: 'baccarat ro' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 8 } },
          { name: 'brand', in: 'query', description: 'Only perfumes from this brand', schema: { type: 'string', example: 'Creed' } },
        ],
        responses: { 200: ok({ type: 'array', items: item }), ...errors },
      },
    },
    '/api/match': {
      get: {
        tags: ['Search'],
        summary: 'Match free text to a perfume',
        description: 'For noisy text such as a label read from a photo: sizes, packaging words, extra words and small typos are tolerated. Returns the best match with a confidence score and alternatives.',
        parameters: [
          { name: 'text', in: 'query', required: true, schema: { type: 'string', maxLength: 500, example: 'CREED AVENTUS eau de parfum 100ml vaporisateur' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 10, default: 5 } },
        ],
        responses: { 200: ok(matchResult), ...errors },
      },
      post: {
        tags: ['Search'],
        summary: 'Match one text, or up to 20 at once',
        description: 'Send `text` for one result, or `texts` (up to 20, e.g. every bottle read from one shelf photo) for an array of results in the same order, each with its `text`.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  {
                    type: 'object', required: ['text'],
                    properties: {
                      text: { type: 'string', maxLength: 2000, example: 'MAISON FRANCIS KURKDJIAN PARIS BACCARAT ROUGE 540 EXTRAIT DE PARFUM 70 ml' },
                      limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
                    },
                  },
                  {
                    type: 'object', required: ['texts'],
                    properties: {
                      texts: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 2000 }, example: ['CREED AVENTUS 100ml', 'Dior Sauvage EDT'] },
                      limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: { 200: ok({ oneOf: [matchResult, { type: 'array', items: { allOf: [{ type: 'object', properties: { text: { type: 'string' } } }, matchResult] } }] }), ...errors },
      },
    },
    '/api/perfumes': {
      get: {
        tags: ['Perfumes'],
        summary: 'Several perfumes at once',
        description: 'Basic records with image state for up to 50 ids, in the order given; unknown ids are left out. Cheap way to check pending images.',
        parameters: [{ name: 'ids', in: 'query', required: true, schema: { type: 'string', example: '1,2,3' }, description: 'Comma-separated ids (up to 50)' }],
        responses: { 200: ok({ type: 'array', items: item }), ...errors },
      },
    },
    '/api/perfumes/{id}': {
      get: {
        tags: ['Perfumes'],
        summary: 'Perfume details',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1, example: 1 } }],
        responses: { 200: ok({ $ref: '#/components/schemas/PerfumeDetail' }), ...errors },
      },
    },
    '/api/brands/{name}': {
      get: {
        tags: ['Perfumes'],
        summary: 'Perfumes by brand, most popular first',
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string', example: 'Tom Ford' } },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        ],
        responses: { 200: ok({ type: 'array', items: item }), ...errors },
      },
    },
    '/api/rankings': {
      get: {
        tags: ['Perfumes'],
        summary: 'Top-rated perfumes',
        parameters: [
          { name: 'category', in: 'query', required: true, schema: { type: 'string', enum: ['mens', 'womens', 'unisex'] } },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'production', in: 'query', schema: { type: 'string', enum: ['in-production', 'discontinued', 'all'], default: 'all' } },
          { name: 'edition', in: 'query', schema: { type: 'string', enum: ['regular', 'limited', 'collectors', 'all'], default: 'all' } },
        ],
        responses: {
          200: ok({ type: 'array', items: { allOf: [{ type: 'object', properties: { rank: { type: 'integer', example: 1 } } }, item] } }),
          ...errors,
        },
      },
    },
    '/images/{id}.webp': {
      get: {
        tags: ['Images'],
        summary: 'Perfume image (WebP)',
        description: 'No API key needed. Use the URLs returned by the API. Background removal runs in a queue: until it is done the URL ends in `&pending=1` and serves the plain product photo, revalidated on every load so the cut-out appears at the same URL as soon as it is ready; once done, the API returns the URL without it, cached for a year.',
        security: [],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
          { name: 'size', in: 'query', schema: { type: 'string', enum: ['small', 'large', 'xl'], default: 'small' }, description: 'small = 240 px, large = 720 px, xl = up to 1440 px (never upscaled)' },
        ],
        responses: { 200: { description: 'Image', content: { 'image/webp': { schema: { type: 'string', format: 'binary' } } } }, 404: { description: 'No image' } },
      },
    },
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Health check',
        security: [],
        responses: { 200: { description: 'Healthy' }, 503: { description: 'Unhealthy' } },
      },
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
        properties: {
          success: { type: 'boolean', example: false },
          code: { type: 'string', enum: ['invalid_request', 'unauthorized', 'forbidden', 'not_found', 'rate_limited', 'upstream_error', 'unavailable', 'internal_error'], example: 'not_found' },
          error: { type: 'string', description: 'Human-readable message' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
      Perfume: {
        type: 'object',
        required: ['id', 'name', 'brand'],
        properties: {
          id: { type: 'integer', example: 42 },
          name: { type: 'string', example: 'Baccarat Rouge 540' },
          brand: { type: 'string', example: 'Maison Francis Kurkdjian' },
          variant: { type: 'string', example: 'Extrait de Parfum', description: 'Concentration or edition when several share a name' },
          year: { type: 'integer', example: 2017 },
          gender: { type: 'string', enum: ['male', 'female', 'unisex'] },
          image: { type: 'string', example: 'https://fragrance.alexcretu.com/images/42.webp?v=7&t=1795830000', description: '240 px image URL; use as returned' },
          imageStatus: { type: 'string', enum: ['ready', 'pending', 'none'], description: 'ready = background removed (final); pending = plain photo until processed; none = no image' },
          imageVersion: { type: 'integer', example: 6, description: 'Changes when every image is re-rendered; re-mirror stored copies with an older version' },
          imageBounds: {
            type: 'object', description: 'Opaque area of the cut-out as fractions of the square image (ready only); same framing as the pending photo',
            properties: { x: { type: 'number', example: 0.21 }, y: { type: 'number', example: 0.04 }, w: { type: 'number', example: 0.58 }, h: { type: 'number', example: 0.93 } },
          },
          imageUpdatedAt: { type: 'string', format: 'date-time', description: 'When the final image was rendered (ready only)' },
          rating: { type: 'number', description: 'Average rating, 0-10', example: 8.2 },
          votes: { type: 'integer', description: 'Number of ratings', example: 3408 },
        },
      },
      PerfumeDetail: {
        allOf: [
          { $ref: '#/components/schemas/Perfume' },
          {
            type: 'object',
            properties: {
              imageLarge: { type: 'string', example: 'https://fragrance.alexcretu.com/images/42.webp?size=large&v=7&t=1795830000', description: '720 px' },
              imageXl: { type: 'string', example: 'https://fragrance.alexcretu.com/images/42.webp?size=xl&v=7&t=1795830000', description: 'Up to 1440 px (never upscaled beyond the source)' },
              description: { type: 'string' },
              perfumer: { type: 'string', example: 'Francis Kurkdjian' },
              notes: {
                type: 'object',
                properties: {
                  top: { type: 'array', items: { type: 'string' }, example: ['Saffron', 'Bitter almond'] },
                  heart: { type: 'array', items: { type: 'string' }, example: ['Jasmine'] },
                  base: { type: 'array', items: { type: 'string' }, example: ['Ambergris', 'Cedarwood', 'Musk'] },
                },
              },
              accords: { type: 'array', items: { type: 'string' }, example: ['Sweet', 'Woody', 'Spicy'] },
              longevity: { type: 'number', description: '0-10' },
              sillage: { type: 'number', description: '0-10' },
              bottle: { type: 'number', description: 'Bottle design rating, 0-10' },
              value: { type: 'number', description: 'Value for money, 0-10' },
              rank: { type: 'object', properties: { position: { type: 'integer' }, category: { type: 'string' } } },
              status: { type: 'string', enum: ['in-production', 'discontinued'] },
              similar: {
                type: 'array',
                items: { allOf: [{ $ref: '#/components/schemas/Perfume' }, { type: 'object', properties: { similarity: { type: 'number', minimum: 0, maximum: 1 } } }] },
              },
            },
          },
        ],
      },
    },
  },
};
