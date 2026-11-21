/** Internal same-response text recipe; no Tool input/context can install its producer. */
export const COMPANY_NAVIGATION_RECIPE = 'company-navigation/v1' as const;
export type CompanyNavigationRecipe = typeof COMPANY_NAVIGATION_RECIPE;
export type CompanyNavigationCapture = (document: Document, requestedUrl: string, responseUrl: string) => string;
