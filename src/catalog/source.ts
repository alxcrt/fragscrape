import * as cheerio from 'cheerio';
import config from '../config/config';
import logger from '../utils/logger';
import httpClient from '../proxy/httpClient';
import browserClient from '../proxy/browserClient';
import { isProxyConfigured } from '../proxy/proxyConfig';
import { DEFAULT_USER_AGENT, DEFAULT_HEADERS } from '../proxy/headers';

/** A perfume as listed on search, brand, ranking or "similar" cards. */
export interface ListingItem {
  path: string | null;
  mediaKey: string | null;
  image: string | null;
  name: string;
  brand: string;
  variant: string | null;
  year: number | null;
  gender: 'male' | 'female' | 'unisex' | null;
  rating: number | null;
  votes: number | null;
  similarity?: number;
}

const MEDIA_HOST = 'https://media.parfumo.com/';
const MAX_CONCURRENT = 3;
let active = 0;
const waiting: Array<() => void> = [];

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/**
 * Fetch a page as HTML. Plain HTTP is ~10x faster than a headless browser and
 * returns the full page; the browser is used only if HTTP fails.
 */
export async function fetchHtml(url: string, needs?: string): Promise<string> {
  return limited(async () => {
    try {
      let html: string;
      if (isProxyConfigured()) {
        html = String(await httpClient.get(url));
      } else {
        const res = await fetch(url, {
          headers: { 'User-Agent': DEFAULT_USER_AGENT, ...DEFAULT_HEADERS },
          signal: AbortSignal.timeout(15000),
          redirect: 'follow',
        });
        if (res.status === 404) return '';
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        html = await res.text();
      }
      if (needs && !html.includes(needs)) throw new Error(`page lacks ${needs}`);
      return html;
    } catch (err) {
      logger.warn(`HTTP fetch failed for ${url} (${(err as Error).message}); using browser`);
      return browserClient.getPageContent(url);
    }
  });
}

/** Stable identity of a perfume from its image file name, e.g. "66dd48". */
export function mediaKeyFromSrc(src: string | undefined | null): string | null {
  if (!src) return null;
  const match = src.match(/\/perfumes\/[0-9a-f]{2}\/([0-9a-f]{6})[-_]/i);
  return match ? match[1].toLowerCase() : null;
}

/** Image path without host or resize query, for the image proxy. */
export function imagePathFromSrc(src: string | undefined | null): string | null {
  if (!src || !src.startsWith(MEDIA_HOST)) return null;
  return src.slice(MEDIA_HOST.length).split('?')[0];
}

export function imageUrl(path: string, width: number): string {
  return `${MEDIA_HOST}${path}?width=${width}&aspect_ratio=1:1`;
}

/** Path after /Perfumes/, e.g. "Creed/aventus". */
export function pathFromHref(href: string | undefined): string | null {
  if (!href) return null;
  const match = href.match(/\/Perfumes\/([^/?#]+\/[^/?#]+)/);
  return match ? match[1] : null;
}

export function perfumeUrl(path: string): string {
  return `${config.scraper.baseUrl}/Perfumes/${path}`;
}

function number(text: string | undefined): number | null {
  if (!text) return null;
  const n = parseFloat(text.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Parse the result cards on search, brand and ranking pages. */
export function parseListing(html: string): ListingItem[] {
  const $ = cheerio.load(html);
  const items: ListingItem[] = [];
  const seen = new Set<string>();
  $('.pgrid .col, .pgrid-small .col').each((_, el) => {
    const $el = $(el);
    const $link = $el.find('.name > a[href*="/Perfumes/"]').first();
    const path = pathFromHref($link.attr('href'));
    if (!path || seen.has(path)) return;
    seen.add(path);
    const variant = $link.find('.label_a').text().trim() || null;
    const $nameClone = $link.clone();
    $nameClone.find('span').remove();
    const name = $nameClone.text().trim();
    // Brand pages omit the brand link on each card; take it from the link path instead
    const brand = $el.find('.brand a[href*="/Perfumes/"]').first().text().trim()
      || decodeURIComponent(path.split('/')[0]).replace(/_/g, ' ');
    if (!name || !brand) return;
    const src = $el.find('.image img').attr('src') ?? null;
    const icons = $el.find('.name i.fa').map((_, i) => $(i).attr('class') ?? '').get().join(' ');
    const male = /fa-mars\b/.test(icons), female = /fa-venus\b/.test(icons);
    const gender = /fa-venus-mars|fa-transgender/.test(icons) || (male && female) ? 'unisex' : male ? 'male' : female ? 'female' : null;
    const $score = $el.find('.av_scent').first().clone();
    const votes = number($score.find('.tv').text());
    $score.find('.tv').remove();
    items.push({
      path,
      mediaKey: mediaKeyFromSrc(src),
      image: imagePathFromSrc(src),
      name,
      brand,
      variant,
      year: number($el.find('.release_year').text()),
      gender,
      rating: number($score.text()),
      votes,
    });
  });
  return items;
}

/** Parse the "similar perfumes" strip of a detail page (cards have no links, only images). */
export function parseSimilar(html: string): ListingItem[] {
  const $ = cheerio.load(html);
  const items: ListingItem[] = [];
  $('.sim_item').each((_, el) => {
    const $el = $(el);
    const $img = $el.find('img').first();
    const src = $img.attr('src') ?? null;
    const alt = $img.attr('alt') ?? '';
    const by = alt.lastIndexOf(' by ');
    if (by < 0) return;
    const brand = alt.slice(by + 4).trim();
    const variant = $el.find('.text-xs span').text().trim() || null;
    const $label = $el.find('.text-xs').first().clone();
    $label.find('span').remove();
    const name = $label.text().trim() || alt.slice(0, by).replace(/\s*\([^)]*\)\s*$/, '').trim();
    const pct = number($el.find('[data-percentage]').attr('data-percentage'));
    if (!name || !brand) return;
    items.push({
      path: null,
      mediaKey: mediaKeyFromSrc(src),
      image: imagePathFromSrc(src),
      name,
      brand,
      variant,
      year: null,
      gender: null,
      rating: null,
      votes: null,
      similarity: pct !== null ? Math.round(pct) / 100 : undefined,
    });
  });
  return items;
}

export async function searchSource(query: string): Promise<ListingItem[]> {
  const url = `${config.scraper.baseUrl}/s_perfumes_x.php?in=1&order=&filter=${encodeURIComponent(query)}`;
  return parseListing(await fetchHtml(url));
}

const GENDER_PARAMS: Record<string, string> = { mens: 'g_m', womens: 'g_f', unisex: 'g_u' };

export async function rankingSource(category: string, page: number, production = 'all', edition = 'all'): Promise<ListingItem[]> {
  const params = new URLSearchParams({ in: '1' });
  params.set(GENDER_PARAMS[category], '1');
  if (production === 'in-production') params.set('s_0', '1');
  else if (production === 'discontinued') params.set('s_1', '1');
  if (edition === 'regular') params.set('e_0', '1');
  else if (edition === 'limited') params.set('e_1', '1');
  else if (edition === 'collectors') params.set('e_2', '1');
  params.set('o', 'nr_desc');
  if (page > 1) params.set('current_page', String(page));
  return parseListing(await fetchHtml(`${config.scraper.baseUrl}/s_perfumes_x.php?${params}`));
}

export async function brandSource(brand: string, page: number): Promise<ListingItem[]> {
  const slug = encodeURIComponent(brand.trim().replace(/\s+/g, '_'));
  return parseListing(await fetchHtml(`${config.scraper.baseUrl}/Perfumes/${slug}?page=${page}`));
}

/** Perfumer names and the short description from a detail page. */
export function parseDetailExtras(html: string): { perfumer?: string; description?: string } {
  const $ = cheerio.load(html);
  const heading = $('h2').filter((_, el) => /^\s*perfumers?\s*$/i.test($(el).text())).first();
  const names = heading.next().find('a[href*="/Perfumers/"]').map((_, a) => $(a).text().trim()).get().filter(Boolean);
  const $desc = $('[itemprop="description"]').first().clone();
  $desc.find('span, script, style').remove();
  const description = $desc.text().replace(/\s+/g, ' ').trim();
  return {
    ...(names.length ? { perfumer: [...new Set(names)].join(', ') } : {}),
    ...(description ? { description } : {}),
  };
}
