export interface FontCatalogGroup {
  label: string;
  fonts: readonly string[];
}

/** Free open-source fonts available directly via Google Fonts CSS2 (.ttf auto-downloadable). */
export const GOOGLE_FREE_FONTS = [
  'Alexandria',
  'Montserrat',
  'Poppins',
  'Inter',
  'Oswald',
  'Quicksand',
  'Inconsolata',
  'Goudy Bookletter 1911',
  'Bebas Neue',
  'Anton',
  'Bangers',
  'Rubik',
  'Space Grotesk',
  'Syne',
  'JetBrains Mono',
  'Fredoka',
  'DM Sans',
  'Plus Jakarta Sans',
  'Orbitron',
] as const;

export const FONT_CATALOG: readonly FontCatalogGroup[] = [
  {
    label: 'Free Google Fonts (Auto TTF)',
    fonts: GOOGLE_FREE_FONTS,
  },
  {
    label: 'Modern & Clean',
    fonts: [
      'Aller',
      'Aller Display',
      'Anivers',
      'Artist',
      'Blair MD',
      'Calluna',
      'Candela',
      'Caviar Dreams',
      'Century Gothic',
      'Champagne & Limousines',
      'Chantelli Antiqua',
      'Cicle',
      'Coolvetica',
      'Droid Sans',
      'Evolution',
      'Fertigo Pro',
      'Folks',
      'Fontin',
      'Fontin Sans',
      'Franklin Gothic',
      'Futura',
      'Geosans Light',
      'Hattori Hanzo',
      'Kravitz',
      'Market Deco',
      'Modeno LX',
      'New Font',
      'Surrounding',
      'Susanna',
      'Vegur',
    ],
  },
  {
    label: 'Bold, Display & Grunge',
    fonts: [
      'Bebas',
      'Black Casper',
      'Boycott',
      'Broken15',
      'Burnstown Dam',
      'Carousel',
      'Chunk',
      'Chunk Five',
      'Cloister',
      'College',
      'Comic Zine',
      'Commando',
      'Downcome',
      'Droid',
      'Edmunds',
      'Gesso',
      'Gothic Ultra',
      'Goudy Twenty',
      'Green Fuz',
      'Griffin',
      'Hat Check',
      'Hill House',
      'House Slant',
      'Sketch Block',
    ],
  },
  {
    label: 'Script, Hand & Retro',
    fonts: [
      'Amadeus',
      'Angelina',
      'Ballpark Weiner',
      'Black Jack',
      'Black Rose',
      'Blueprint',
      'Brock Script',
      'Carrington',
      'Chopin Script',
      'Deftone',
      'Elliot Six',
      'Forelle',
      'Gabrielle',
      'Good Dog',
      'Griffos Font',
      'Holla Script',
      'Honey Script',
      'Idolwild',
      'Tekton',
    ],
  },
  {
    label: 'OS System Fonts',
    fonts: [
      'Arial',
      'Calibri',
      'Geneva',
      'Gill Sans',
      'Skia',
      'Tahoma',
      'Trebuchet MS',
    ],
  },
];

export const BUNDLED_GOOGLE_FONTS = GOOGLE_FREE_FONTS;

export function getGoogleFontsStylesheetUrl(): string {
  const families = GOOGLE_FREE_FONTS.map((f) => `family=${f.replace(/\s+/g, '+')}:wght@400;700;800`).join('&');
  return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}

/** Registers local .ttf/.otf files into browser FontFaceSet for accurate live canvas preview. */
export async function registerLocalFontFaces(
  fonts: Array<{ name: string; path: string }>
): Promise<string[]> {
  if (typeof document === 'undefined' || !('fonts' in document)) return [];
  const loaded: string[] = [];
  for (const f of fonts) {
    try {
      const url = `clipper-media://${encodeURIComponent(f.path)}`;
      const face = new FontFace(f.name, `url("${url}")`);
      await face.load();
      document.fonts.add(face);
      loaded.push(f.name);
    } catch {
      // ignore invalid font files
    }
  }
  return loaded;
}
