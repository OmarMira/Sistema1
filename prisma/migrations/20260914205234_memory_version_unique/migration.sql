-- Aligns migration history with prisma/schema.prisma: @@unique([itemId, versionNumber]).
-- Fails visibly if duplicate (itemId, versionNumber) rows exist.
CREATE UNIQUE INDEX "MemoryVersion_itemId_versionNumber_key"
ON "MemoryVersion"("itemId", "versionNumber");
