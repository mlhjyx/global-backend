/**
 * Renderer-owned token package digests used by the B2/B3 catalog additions.
 * The catalog spec recomputes every digest from THEME_PRESETS so drift fails CI.
 */
export const M1_E_B_RENDERER_PRESET_TOKEN_DIGESTS = {
  dispatch: "870f782d9d347829568008a06d92d1d428cb284bd6f48f1cfd3e99dc47c7567c",
  "biotech-minimal":
    "8bc43df07f32dfb04871e07a66e63c26003def1d057b1dd7a78abd629dcec6f8",
} as const;
