type Numeric = number | string | null;

export interface ServicePrice {
  service: string;
  model: string;
  currency: string;
  input_per_mtok: Numeric;
  cached_per_mtok: Numeric;
  output_per_mtok: Numeric;
}

/** Token totals for attempts without a cost of their own. */
export interface UncostedUsage {
  tokens_in_uncosted: Numeric;
  tokens_cached: Numeric;
  tokens_out_uncosted: Numeric;
}

export function estimateUsage(
  prices: ServicePrice[], service: string | null, model: string | null, usage: UncostedUsage,
  { requireInputOrOutputPrice = false } = {},
) {
  const price = prices.find((p) => p.service === service && p.model === model)
    ?? prices.find((p) => p.service === service && p.model === "");
  if (!price || (price.input_per_mtok === null && price.cached_per_mtok === null && price.output_per_mtok === null)) return null;
  // The models overview has always required a usable input or output rate.
  if (requireInputOrOutputPrice && !price.input_per_mtok && !price.output_per_mtok) return null;

  const cached = Number(usage.tokens_cached ?? 0);
  const fresh = Number(usage.tokens_in_uncosted ?? 0) - cached;
  const amount = (fresh / 1e6) * Number(price.input_per_mtok ?? 0)
    + (cached / 1e6) * Number(price.cached_per_mtok ?? price.input_per_mtok ?? 0)
    + (Number(usage.tokens_out_uncosted ?? 0) / 1e6) * Number(price.output_per_mtok ?? 0);
  return { amount, currency: price.currency };
}
