-- The index behind the second sortable field.
--
-- `updatedAt` is sortable on `GET /tickets`, and every keyset ordering needs
-- its `(field, id)` pair servable — otherwise "sortable" means a sequential
-- scan of the tenant's whole queue on every page of a traversal.
--
-- Belongs with the table it indexes; it is separate only because the tickets
-- migration was already applied when the gap was found.

CREATE INDEX "ticket_tenant_id_updated_at_id_idx" ON "ticket"("tenant_id", "updated_at" DESC, "id" DESC);
