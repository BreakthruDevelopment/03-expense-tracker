CREATE TABLE "daily_usage" (
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "daily_usage_day_kind_pk" PRIMARY KEY("day","kind"),
	CONSTRAINT "daily_usage_kind_chk" CHECK ("daily_usage"."kind" in ('upload','extract','demo_load')),
	CONSTRAINT "daily_usage_count_chk" CHECK ("daily_usage"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "expense" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"merchant" text NOT NULL,
	"spent_on" date NOT NULL,
	"amount_minor" integer NOT NULL,
	"tax_minor" integer,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"ai_mode" text,
	"receipt_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_merchant_len" CHECK (char_length("expense"."merchant") between 1 and 120),
	CONSTRAINT "expense_note_len" CHECK (char_length("expense"."note") <= 500),
	CONSTRAINT "expense_amount_range" CHECK ("expense"."amount_minor" between 1 and 100000000),
	CONSTRAINT "expense_tax_range" CHECK ("expense"."tax_minor" is null or "expense"."tax_minor" between 0 and 100000000),
	CONSTRAINT "expense_currency_chk" CHECK ("expense"."currency" in ('USD','EUR','GBP','CAD','AUD','MXN','CHF','INR')),
	CONSTRAINT "expense_category_chk" CHECK ("expense"."category" in ('meals','travel','lodging','transport','office','software','equipment','other')),
	CONSTRAINT "expense_source_chk" CHECK ("expense"."source" in ('manual','receipt')),
	CONSTRAINT "expense_ai_mode_chk" CHECK ("expense"."ai_mode" is null or "expense"."ai_mode" in ('live','demo'))
);
--> statement-breakpoint
CREATE TABLE "rate_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_event_kind_chk" CHECK ("rate_event"."kind" in ('upload','extract','download','demo_load','purge'))
);
--> statement-breakpoint
CREATE TABLE "receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"extraction" jsonb,
	"extraction_mode" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "receipt_id_owner_uq" UNIQUE("id","owner_id"),
	CONSTRAINT "receipt_content_type_chk" CHECK ("receipt"."content_type" in ('image/jpeg','image/png','image/webp')),
	CONSTRAINT "receipt_status_chk" CHECK ("receipt"."status" in ('uploading','ready','rejected')),
	CONSTRAINT "receipt_mode_chk" CHECK ("receipt"."extraction_mode" is null or "receipt"."extraction_mode" in ('live','demo','failed')),
	CONSTRAINT "receipt_size_chk" CHECK ("receipt"."size_bytes" between 1 and 5242880),
	CONSTRAINT "receipt_key_chk" CHECK ("receipt"."object_key" = 'u/' || "receipt"."owner_id" || '/' || "receipt"."id"::text)
);
--> statement-breakpoint
DROP TABLE "item" CASCADE;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_receipt_owner_fk" FOREIGN KEY ("receipt_id","owner_id") REFERENCES "public"."receipt"("id","owner_id") ON DELETE set null ("receipt_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_event" ADD CONSTRAINT "rate_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_receipt_id_uq" ON "expense" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "expense_owner_spent_idx" ON "expense" USING btree ("owner_id","spent_on" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "expense_owner_category_idx" ON "expense" USING btree ("owner_id","category");--> statement-breakpoint
CREATE INDEX "rate_event_user_kind_at_idx" ON "rate_event" USING btree ("user_id","kind","at");--> statement-breakpoint
CREATE INDEX "receipt_owner_status_created_idx" ON "receipt" USING btree ("owner_id","status","created_at");