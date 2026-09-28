-- Original-cost reversals must not strand valuation on zero physical stock.
ALTER TABLE prsystem.minibar_receipt ADD CONSTRAINT minibar_zero_stock_value
 CHECK(total_quantity_after<>0 OR inventory_value_after=0);
