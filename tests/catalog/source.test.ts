import { parseListing, parseSimilar, parseDetailExtras, mediaKeyFromSrc, imagePathFromSrc, pathFromHref } from '../../src/catalog/source';

const card = (path: string, name: string, brandLink: string, extra = '') => `
  <div class="col">
    <div class="image"><a href="https://www.parfumo.com/Perfumes/${path}"><img src="https://media.parfumo.com/perfumes/66/66dd48_aventus-creed_1200.jpg?width=240&aspect_ratio=1:1" alt=""></a></div>
    <div class="name"><a href="https://www.parfumo.com/Perfumes/${path}">${name}</a>
      ${brandLink}
    </div>
    <div class="av av_scent"> 8.4<span class="tv"><i class="fa fa-user"></i> 8900</span></div>
    ${extra}
  </div>`;

describe('listing parser', () => {
  it('parses search cards', () => {
    const html = `<div class="pgrid">${card('Creed/aventus', 'Aventus',
      '<span class="brand"> - <a href="https://www.parfumo.com/Perfumes/Creed">Creed</a> <span class="release_year"><a>(2010)</a></span> <span><i class="fa fa-mars"></i></span></span>')}</div>`;
    expect(parseListing(html)).toEqual([{
      path: 'Creed/aventus', mediaKey: '66dd48', image: 'perfumes/66/66dd48_aventus-creed_1200.jpg',
      name: 'Aventus', brand: 'Creed', variant: null, year: 2010, gender: 'male', rating: 8.4, votes: 8900,
    }]);
  });

  it('parses variants and brand pages without brand links', () => {
    const html = `<div class="pgrid">${card('Tom_Ford/Oud_Wood_Eau_de_Parfum',
      'Oud Wood<span class="ml-0-5"><i class="fa fa-venus-mars"></i></span> <span class="label_a small upper"> Eau de Parfum</span>', '')}</div>`;
    const [item] = parseListing(html);
    expect(item).toMatchObject({ name: 'Oud Wood', brand: 'Tom Ford', variant: 'Eau de Parfum', gender: 'unisex' });
  });

  it('parses similar strips from image alt text', () => {
    const html = `<div class="sim_item"><img src="https://media.parfumo.com/perfumes/f7/f7f71f-club-de-nuit-intense-man-eau-de-toilette-armaf_1200.jpg?width=120" alt="Club de Nuit Intense Man (Eau de Toilette) by Armaf">
      <span class="fill" data-percentage="81.1"></span>
      <div class="text-xs grey mt-0-5">Club de Nuit Intense Man <span class="text-2xs">Eau de Toilette</span></div></div>`;
    expect(parseSimilar(html)[0]).toMatchObject({
      path: null, mediaKey: 'f7f71f', name: 'Club de Nuit Intense Man', brand: 'Armaf', variant: 'Eau de Toilette', similarity: 0.81,
    });
  });

  it('extracts perfumers and description', () => {
    const html = `<span itemprop="description">A popular perfume. <span class="btn">Play</span></span>
      <h2 class="text-lg bold"> Perfumer </h2><div><a href="https://www.parfumo.com/Perfumers/A">A One</a> <a href="https://www.parfumo.com/Perfumers/B">B Two</a></div>`;
    expect(parseDetailExtras(html)).toEqual({ perfumer: 'A One, B Two', description: 'A popular perfume.' });
  });

  it('derives identities from links and images', () => {
    expect(pathFromHref('https://www.parfumo.com/Perfumes/Creed/aventus?x=1')).toBe('Creed/aventus');
    expect(mediaKeyFromSrc('https://media.parfumo.com/perfumes/50/50639a-baccarat_1200.jpg?w=1')).toBe('50639a');
    expect(imagePathFromSrc('https://evil.example/perfumes/50/50639a-x.jpg')).toBeNull();
  });
});
