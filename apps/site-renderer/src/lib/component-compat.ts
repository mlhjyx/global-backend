export interface InternalCtaTarget {
  labelKey: string;
  pageId: string;
}

/** Preserve the independent defaults from the pre-qualification 1.0 props. */
export function resolveServiceRowsCta(
  cta: InternalCtaTarget | undefined,
  bookLabelKey: string | undefined,
  bookPageId: string | undefined,
): InternalCtaTarget {
  return cta ?? {
    labelKey: bookLabelKey ?? 'cta.learnMore',
    pageId: bookPageId ?? 'services',
  };
}
