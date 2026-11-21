CREATE TABLE provider_balances (
  id           bigserial PRIMARY KEY,
  service      text NOT NULL,
  account      text NOT NULL,
  currency     text NOT NULL,
  balance      numeric(14,6) NOT NULL,
  granted      numeric(14,6),
  topped_up    numeric(14,6),
  is_available boolean NOT NULL,
  raw          jsonb NOT NULL,
  fetched_at   timestamptz NOT NULL DEFAULT now()
);
