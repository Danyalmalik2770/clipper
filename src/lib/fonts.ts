export const BUNDLED_GOOGLE_FONTS = [
  'Montserrat',
  'Poppins',
  'Inter',
  'Bebas Neue',
  'Oswald',
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

export function getGoogleFontsStylesheetUrl(): string {
  const families = BUNDLED_GOOGLE_FONTS.map((f) => `family=${f.replace(/\s+/g, '+')}:wght@700;800`).join('&');
  return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}
