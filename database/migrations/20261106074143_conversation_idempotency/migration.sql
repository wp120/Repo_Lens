ALTER TABLE "messages" ADD COLUMN "client_id" UUID;
ALTER TABLE "messages" ADD COLUMN "status" VARCHAR(16) NOT NULL DEFAULT 'completed';

CREATE UNIQUE INDEX "messages_conversation_id_client_id_key"
ON "messages"("conversation_id", "client_id");
