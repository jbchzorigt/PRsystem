-- Stage-five warehouse receipt foundation. No room transfer or guest sale source.
CREATE TABLE prsystem.minibar_product (
    tenant_id text NOT NULL REFERENCES prsystem.hotel_access,
    id text NOT NULL,
    name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),
    category text NOT NULL CHECK(length(btrim(category)) BETWEEN 1 AND 200),
    unit text NOT NULL CHECK(length(btrim(unit)) BETWEEN 1 AND 50),
    selling_price_mnt bigint NOT NULL CHECK(selling_price_mnt > 0),
    initial_unit_cost_mnt bigint NOT NULL CHECK(initial_unit_cost_mnt >= 0),
    status text NOT NULL CHECK(status IN ('ACTIVE','INACTIVE')),
    revision bigint NOT NULL DEFAULT 1 CHECK(revision > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,id)
);
CREATE TABLE prsystem.minibar_receipt (
    tenant_id text NOT NULL,
    id text NOT NULL,
    product_id text NOT NULL,
    stock_revision bigint NOT NULL CHECK(stock_revision > 0),
    kind text NOT NULL CHECK(kind IN ('OPENING','PURCHASE')),
    quantity bigint NOT NULL CHECK(quantity >= 0),
    unit_cost_mnt bigint NOT NULL CHECK(unit_cost_mnt >= 0),
    warehouse_after bigint NOT NULL CHECK(warehouse_after >= 0),
    inventory_value_after numeric(39,0) NOT NULL CHECK(inventory_value_after >= 0),
    actor_id text NOT NULL REFERENCES prsystem.staff_account(id),
    actor_label text NOT NULL,
    actor_roles text[] NOT NULL,
    package_mnt integer NOT NULL CHECK(package_mnt IN (25000,30000)),
    product_snapshot jsonb NOT NULL,
    reference text NOT NULL CHECK(length(reference) <= 200),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,id),
    UNIQUE(tenant_id,product_id,stock_revision),
    FOREIGN KEY(tenant_id,product_id) REFERENCES prsystem.minibar_product(tenant_id,id),
    FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id),
    CHECK(kind='OPENING' OR quantity > 0),
    CHECK((kind='OPENING')=(stock_revision=1))
);
CREATE UNIQUE INDEX minibar_opening_once ON prsystem.minibar_receipt(tenant_id,product_id) WHERE kind='OPENING';

-- The invoker needs product revision UPDATE privilege for the row lock only.
-- No balance update privilege exists: all totals come from immutable receipts.
CREATE FUNCTION prsystem.guard_minibar_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE product prsystem.minibar_product%ROWTYPE; prior prsystem.minibar_receipt%ROWTYPE;
BEGIN
    SELECT * INTO product FROM prsystem.minibar_product
      WHERE tenant_id=NEW.tenant_id AND id=NEW.product_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Missing inventory product' USING ERRCODE='23514'; END IF;
    SELECT * INTO prior FROM prsystem.minibar_receipt WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id ORDER BY stock_revision DESC LIMIT 1;
    IF NEW.stock_revision<>coalesce(prior.stock_revision,0)+1
       OR NEW.warehouse_after::numeric<>coalesce(prior.warehouse_after,0)::numeric+NEW.quantity
       OR NEW.inventory_value_after<>coalesce(prior.inventory_value_after,0)+NEW.quantity::numeric*NEW.unit_cost_mnt
       OR (NEW.kind='OPENING' AND NEW.unit_cost_mnt<>product.initial_unit_cost_mnt)
       OR (NEW.kind='PURCHASE' AND product.status<>'ACTIVE')
       OR NEW.product_snapshot<>jsonb_build_object('name',product.name,'category',product.category,
           'unit',product.unit,'selling_price_mnt',product.selling_price_mnt,'revision',product.revision)
    THEN RAISE EXCEPTION 'Invalid inventory receipt' USING ERRCODE='23514'; END IF;
    RETURN NEW;
END; $$;
CREATE TRIGGER minibar_receipt_guard BEFORE INSERT ON prsystem.minibar_receipt
 FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_receipt();
CREATE TRIGGER minibar_receipt_immutable BEFORE UPDATE OR DELETE ON prsystem.minibar_receipt
 FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();

DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['minibar_product','minibar_receipt'] LOOP
  EXECUTE format('ALTER TABLE prsystem.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE prsystem.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_scope ON prsystem.%I USING(tenant_id=current_setting(''prsystem.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''prsystem.tenant_id'',true))',tab);
  EXECUTE format('REVOKE ALL ON prsystem.%I FROM PUBLIC',tab);
 END LOOP;
END; $$;
