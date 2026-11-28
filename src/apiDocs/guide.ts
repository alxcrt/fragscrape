/**
 * Integration guide shown at the top of /docs (Markdown) and mirrored in the README.
 */
/** Bumped on every API change; the major number only for breaking changes. */
export const API_VERSION = '2.2.0';

export const integrationGuide = `
## Integration guide

### 1. Keep the key on your server
Call this API from your backend (or a server route / edge function) and forward
results to the browser. Never ship the API key in client-side code. Images under
\`/images\` are public, so the browser can load them directly.

### 2. Autocomplete
- Start at **2 characters**, debounce **150–200 ms**, request \`limit=8\`.
- **Cancel stale requests** (e.g. \`AbortController\`) so an older, slower answer
  never replaces a newer one. Results are usually ~0.1–0.3 s; a first-time search
  for something new can take a few seconds while it is looked up and stored.
- Show \`name\`, \`variant\` (e.g. *Extrait de Parfum*, important when names repeat),
  \`brand\` and \`year\`, plus the small \`image\`. Results are ranked: the first is the
  best guess, popular perfumes first. \`name\` never contains the year; use \`year\`.
- Narrow to one brand with \`brand=\`; \`limit\` goes up to 50.
- Keyboard: arrow keys move, Enter picks the highlighted (default: first) result.

### 3. Picking a result
- Store the numeric \`id\` **and** a snapshot of \`name\`, \`brand\`, \`variant\`. If an id
  ever returns 404 (catalog reset), re-find it with \`/api/match\` using the snapshot.
- Load full details with \`GET /api/perfumes/{id}\` when the user opens or selects it
  (notes, accords, ratings, perfumer, similar perfumes). Repeat calls are instant.

### 4. Matching text from a photo or label
- Send the raw text you have (OCR output, a pasted name) to \`POST /api/match\`;
  sizes, packaging words, extra words and small typos are fine.
- Use \`confidence\`: **≥ 0.9** pick automatically, **0.6–0.9** ask the user to
  confirm (show \`alternatives\`), **below 0.6 / no match** open autocomplete with the
  text prefilled.
- Several bottles (a shelf photo): send \`{ "texts": [...] }\` (up to 20) in one call;
  results come back in the same order, each with its \`text\`.

### 5. Images
- Read \`imageStatus\`: **ready** (background removed, final), **pending** (plain
  product photo until processed), **none**. Use the URLs exactly as returned.
- Background removal runs once per image in a queue. Pending images are revalidated
  on every load, so the same URL switches to the cut-out by itself.
- **Mirroring images?** Store the image URL (or \`imageUpdatedAt\`) with your copy.
  Poll with \`GET /api/perfumes?ids=…\` (up to 50 per call, e.g. every 1–2 minutes)
  and re-download whenever the URL changes: it changes when an image turns \`ready\`
  and whenever it is re-rendered (final URLs carry the render time, \`&t=\`).
- A given final URL never changes content: cache it forever.
- Sizes: \`image\` 240 px for lists, \`imageLarge\` 720 px for detail views,
  \`imageXl\` up to 1440 px for large cards (never upscaled beyond the source).
  Cut-outs are transparent WebP and work on any background colour.
- Layout: \`imageBounds\` gives the bottle's opaque box (fractions of the square), so
  you can scale or align bottles without measuring. Pending photos use the same square
  framing, so the swap to the cut-out does not move the bottle.

### 6. Limits and errors
- Errors are \`{ success: false, code, error }\` with a stable \`code\`:
  \`invalid_request\` (400), \`unauthorized\` (401), \`not_found\` (404),
  \`rate_limited\` (429: back off and retry), \`upstream_error\` / \`internal_error\`.

### 7. Compatibility and changelog
Changes only **add** fields or endpoints; existing ones keep working, so apps don't
need updating for each release. A breaking change would bump the major version
(\`info.version\` here, \`apiVersion\` in \`/health\`) and be announced.

- **2.2.0**: final image URLs carry the render time (\`&t=\`); background removal back
  to full precision (cut-outs re-render in the background, old ones served until then).
- **2.1.0**: \`imageStatus\`, \`imageVersion\`, \`imageBounds\`, \`imageUpdatedAt\`;
  \`GET /api/perfumes?ids=\`; \`POST /api/match {texts}\`; \`size=xl\`; error \`code\`;
  names without the year; autocomplete \`brand\` filter and \`limit\` up to 50.
- **2.0.0**: simple API (autocomplete, match, details, brands, rankings, images).

### Example (TypeScript, server side)
\`\`\`ts
const BASE = 'https://fragrance.alexcretu.com';
const headers = { 'X-API-Key': process.env.FRAGRANCE_API_KEY! };

export async function suggest(q: string, signal?: AbortSignal) {
  if (q.trim().length < 2) return [];
  const res = await fetch(\`\${BASE}/api/autocomplete?q=\${encodeURIComponent(q)}&limit=8\`, { headers, signal });
  return (await res.json()).data as Array<{ id: number; name: string; brand: string; variant?: string; year?: number; image?: string }>;
}

export async function matchLabel(text: string) {
  const res = await fetch(\`\${BASE}/api/match\`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  });
  const { match, alternatives } = (await res.json()).data;
  if (match?.confidence >= 0.9) return { pick: match };
  if (match) return { confirm: [match, ...alternatives] };
  return { search: text };
}
\`\`\`
`;
