/**
 * Renderer-owned token package digests used by the B2/B3 catalog additions.
 * The catalog spec recomputes every digest from THEME_PRESETS so drift fails CI.
 */
export const M1_E_B_RENDERER_PRESET_TOKEN_DIGESTS = {
  dispatch: "870f782d9d347829568008a06d92d1d428cb284bd6f48f1cfd3e99dc47c7567c",
  "biotech-minimal":
    "8bc43df07f32dfb04871e07a66e63c26003def1d057b1dd7a78abd629dcec6f8",
  farmhouse: "b74bd0dc80836f63646e976e2746b4e24924d8cabbf660e8de616290d9e5f78c",
  "warm-kitchen":
    "d2cfe750abfea613b08a98dfc98c69dda8bb4d445d6c61746fef02eb20b569a3",
  "local-trust":
    "c9c935bdf55d447f54e4bb6915e48f26e7e2d2b85917b725b7d104bad0d1db2d",
  "editorial-press":
    "49701cd496dc697a48770940c3c90b49a946aaecf2b50436164fbd89f819e557",
  "precision-instrument":
    "93f959a9c7a840de3bed4824f26218f80a899f01b12b272114480ab05183e788",
  "saas-cream":
    "9d2eee953201c0b986bf89da368d3973efecfa81cb44c82cd6b53025b0f06d95",
} as const;
