export const WIKIDATA_COMPANY_KEYS = [
  'qid', 'name', 'website', 'employees', 'countryCode', 'latitude', 'longitude',
] as const;
export const ENTITY_PROPERTIES = Object.freeze([
  'P1056', 'P159', 'P17', 'P31', 'P355', 'P414', 'P452', 'P749',
] as const);
export const STRING_PROPERTIES = Object.freeze(['P1278', 'P856', 'P946'] as const);
export const ALL_CLAIM_PROPERTIES = Object.freeze([
  ...ENTITY_PROPERTIES, 'P1128', ...STRING_PROPERTIES, 'P571',
] as const);
