CREATE SCHEMA kody_mailbox;
GRANT USAGE ON SCHEMA kody_mailbox TO kody_writer, kody_reader;

		CREATE TABLE IF NOT EXISTS kody_mailbox.mailbox_meta (
 user_id TEXT NOT NULL DEFAULT current_setting('app.user_id', true),
			key TEXT NOT NULL,
			value BIGINT NOT NULL
		, PRIMARY KEY (user_id, key)
);

		CREATE TABLE IF NOT EXISTS kody_mailbox.mailbox_owner_identity (
 user_id TEXT NOT NULL DEFAULT current_setting('app.user_id', true),
			singleton INTEGER NOT NULL CHECK (singleton = 1),
			owner_id TEXT NOT NULL
		, PRIMARY KEY (user_id, singleton)
);

		CREATE TABLE IF NOT EXISTS kody_mailbox.email_message_deletion_tombstones (
 user_id TEXT NOT NULL DEFAULT current_setting('app.user_id', true),
			message_id TEXT NOT NULL,
			deleted_at TEXT NOT NULL
		, PRIMARY KEY (user_id, message_id)
);

		CREATE TABLE IF NOT EXISTS kody_mailbox.email_threads (
 user_id TEXT NOT NULL DEFAULT current_setting('app.user_id', true),
			id TEXT NOT NULL,
			inbox_id TEXT,
			subject_normalized TEXT NOT NULL DEFAULT '',
			root_message_id_header TEXT,
			last_message_at TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		, PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_email_threads_last_message_at
		ON kody_mailbox.email_threads(user_id, last_message_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_email_threads_root_message_id
		ON kody_mailbox.email_threads(user_id, root_message_id_header)
		WHERE root_message_id_header IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_threads_created_at
		ON kody_mailbox.email_threads(user_id, created_at ASC, id ASC);

		CREATE TABLE IF NOT EXISTS kody_mailbox.email_messages (
 user_id TEXT NOT NULL DEFAULT current_setting('app.user_id', true),
			id TEXT NOT NULL,
			direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
			inbox_id TEXT,
			thread_id TEXT,
			sender_identity_id TEXT,
			from_address TEXT NOT NULL DEFAULT '',
			envelope_from TEXT,
			to_addresses_json TEXT NOT NULL DEFAULT '[]',
			cc_addresses_json TEXT NOT NULL DEFAULT '[]',
			bcc_addresses_json TEXT NOT NULL DEFAULT '[]',
			reply_to_addresses_json TEXT NOT NULL DEFAULT '[]',
			subject TEXT NOT NULL DEFAULT '',
			message_id_header TEXT,
			in_reply_to_header TEXT,
			references_json TEXT NOT NULL DEFAULT '[]',
			headers_json TEXT NOT NULL DEFAULT '{}',
			auth_results TEXT,
			text_body TEXT,
			html_body TEXT,
			raw_mime_key TEXT,
			raw_size INTEGER NOT NULL DEFAULT 0,
			processing_status TEXT NOT NULL CHECK (
				processing_status IN ('stored', 'sent', 'failed')
			),
			classification TEXT NOT NULL DEFAULT 'accepted' CHECK (
				classification IN ('accepted', 'quarantined')
			),
			classification_reason TEXT,
			provider_message_id TEXT,
			delivery_status TEXT CHECK (
				delivery_status IS NULL OR delivery_status IN (
					'delivered', 'deferred', 'bounced', 'failed',
					'rejected', 'complained'
				)
			),
			delivery_status_at TEXT,
			error TEXT,
			received_at TEXT,
			sent_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		, PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_email_messages_created_at
		ON kody_mailbox.email_messages(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_created_at_asc
		ON kody_mailbox.email_messages(user_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_email_messages_inbox_created_at
		ON kody_mailbox.email_messages(user_id, inbox_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_thread_created_at
		ON kody_mailbox.email_messages(user_id, thread_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_message_id_header
		ON kody_mailbox.email_messages(user_id, message_id_header)
		WHERE message_id_header IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_messages_provider_message_id
		ON kody_mailbox.email_messages(user_id, provider_message_id)
		WHERE direction = 'outbound' AND provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_messages_direction_created_at
		ON kody_mailbox.email_messages(user_id, direction, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_delivery_status_created_at
		ON kody_mailbox.email_messages(user_id, delivery_status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_classification_created_at
		ON kody_mailbox.email_messages(user_id, classification, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_raw_mime_key
		ON kody_mailbox.email_messages(user_id, id ASC)
		WHERE raw_mime_key IS NOT NULL;

		CREATE TABLE IF NOT EXISTS kody_mailbox.email_outbound_provider_index_repairs (
 user_id TEXT NOT NULL DEFAULT current_setting('app.user_id', true),
			provider TEXT NOT NULL,
			provider_message_id TEXT NOT NULL,
			message_id TEXT NOT NULL,
			inbox_id TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			retry_at TEXT NOT NULL,
			attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
			last_error TEXT,
			PRIMARY KEY (user_id, provider, provider_message_id)
		)
	;
CREATE INDEX IF NOT EXISTS idx_email_outbound_provider_index_repairs_retry
		ON kody_mailbox.email_outbound_provider_index_repairs(user_id, retry_at, provider, provider_message_id);

		CREATE TABLE IF NOT EXISTS kody_mailbox.email_message_retention_retries (
 user_id TEXT NOT NULL DEFAULT current_setting('app.user_id', true),
			message_id TEXT NOT NULL,
			retry_at TEXT NOT NULL,
			attempt_count INTEGER NOT NULL DEFAULT 1,
			last_error TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			FOREIGN KEY (user_id, message_id) REFERENCES kody_mailbox.email_messages(user_id, id) ON DELETE CASCADE
		, PRIMARY KEY (user_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_email_message_retention_retries_retry_at
		ON kody_mailbox.email_message_retention_retries(user_id, retry_at ASC, message_id ASC);

		CREATE TABLE IF NOT EXISTS kody_mailbox.email_attachments (
 user_id TEXT NOT NULL DEFAULT current_setting('app.user_id', true),
			id TEXT NOT NULL,
			message_id TEXT NOT NULL,
			filename TEXT,
			content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
			content_id TEXT,
			disposition TEXT,
			size INTEGER NOT NULL DEFAULT 0,
			storage_kind TEXT NOT NULL CHECK (
				storage_kind IN ('raw-mime', 'external', 'unavailable')
			),
			storage_key TEXT,
			created_at TEXT NOT NULL
		, PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_email_attachments_message_id
		ON kody_mailbox.email_attachments(user_id, message_id);
CREATE INDEX IF NOT EXISTS idx_email_attachments_storage_key
		ON kody_mailbox.email_attachments(user_id, id ASC)
		WHERE storage_key IS NOT NULL;

		CREATE TABLE IF NOT EXISTS kody_mailbox.email_delivery_events (
 user_id TEXT NOT NULL DEFAULT current_setting('app.user_id', true),
			id TEXT NOT NULL,
			message_id TEXT,
			inbox_id TEXT,
			event_type TEXT NOT NULL CHECK (
				event_type IN (
					'receive_started', 'received', 'rejected', 'send_requested',
					'sent', 'failed', 'delivered', 'deferred', 'bounced', 'complained'
				)
			),
			provider TEXT NOT NULL DEFAULT 'kody',
			provider_message_id TEXT,
			provider_event_id TEXT,
			detail_json TEXT NOT NULL DEFAULT '{}',
			needs_effect_reconcile INTEGER NOT NULL DEFAULT 0 CHECK (
				needs_effect_reconcile IN (0, 1)
			),
			state TEXT CHECK (
				state IS NULL OR state IN (
					'pending', 'storing', 'cleaning', 'received',
					'rejected', 'orphan-cleaned'
				)
			),
			fingerprint TEXT,
			storage_lease TEXT,
			storage_lease_at TEXT,
			cleanup_lease TEXT,
			cleanup_lease_at TEXT,
			cleanup_retry_at TEXT,
			expected_attachment_count INTEGER,
			finalization_token TEXT,
			reconcile_after TEXT,
			dedupe_expires_at TEXT,
			usage_effect_recorded_at TEXT,
			usage_effect_suppressed_at TEXT,
			usage_started_at TEXT,
			usage_month TEXT,
			usage_bytes INTEGER,
			usage_duration_ms INTEGER,
			usage_effect_retry_at TEXT,
			usage_effect_lease TEXT,
			usage_effect_lease_at TEXT,
			subscription_effect_state TEXT CHECK (
				subscription_effect_state IS NULL OR subscription_effect_state IN (
					'pending', 'processing', 'complete', 'dead-letter'
				)
			),
			subscription_effect_lease TEXT,
			subscription_effect_lease_at TEXT,
			subscription_effect_retry_at TEXT,
			subscription_effect_attempt_count INTEGER,
			subscription_effect_dead_letter_at TEXT,
			subscription_effect_last_error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		, PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_message_id
		ON kody_mailbox.email_delivery_events(user_id, message_id);
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_created_at
		ON kody_mailbox.email_delivery_events(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_created_at_asc
		ON kody_mailbox.email_delivery_events(user_id, created_at ASC, id ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_delivery_events_provider_event_id
		ON kody_mailbox.email_delivery_events(user_id, provider_event_id)
		WHERE provider_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_pending_effects
		ON kody_mailbox.email_delivery_events(user_id, created_at ASC, id ASC)
		WHERE needs_effect_reconcile = 1
			AND fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_state_created
		ON kody_mailbox.email_delivery_events(user_id, state, created_at ASC)
		WHERE state IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_fingerprint
		ON kody_mailbox.email_delivery_events(user_id, fingerprint)
		WHERE fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_dedupe_expires
		ON kody_mailbox.email_delivery_events(user_id, dedupe_expires_at ASC)
		WHERE dedupe_expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_recorded_usage_month
		ON kody_mailbox.email_delivery_events(user_id, usage_month, created_at ASC)
		WHERE usage_effect_recorded_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_reconcile_after
			ON kody_mailbox.email_delivery_events(user_id, reconcile_after ASC, created_at ASC, id ASC)
			WHERE reconcile_after IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_usage_effect_retry
			ON kody_mailbox.email_delivery_events(user_id, usage_effect_retry_at ASC, id ASC)
			WHERE needs_effect_reconcile = 1
				AND usage_effect_recorded_at IS NULL
				AND usage_effect_suppressed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_subscription_effect_retry
			ON kody_mailbox.email_delivery_events(user_id, subscription_effect_retry_at ASC, id ASC)
			WHERE needs_effect_reconcile = 1
				AND (
					subscription_effect_state IS NULL
					OR subscription_effect_state NOT IN ('complete', 'dead-letter')
				);
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_stale_state
			ON kody_mailbox.email_delivery_events(user_id, state, created_at ASC, id ASC)
			WHERE state IN ('pending', 'storing', 'cleaning', 'orphan-cleaned');
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_dedupe_provider_expires
			ON kody_mailbox.email_delivery_events(user_id, provider, dedupe_expires_at ASC, id ASC)
			WHERE provider = 'cloudflare-email-routing-dedupe'
				AND dedupe_expires_at IS NOT NULL;
ALTER TABLE kody_mailbox.mailbox_meta ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner ON kody_mailbox.mailbox_meta USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON kody_mailbox.mailbox_meta TO kody_writer;
GRANT SELECT ON kody_mailbox.mailbox_meta TO kody_reader;
ALTER TABLE kody_mailbox.mailbox_owner_identity ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner ON kody_mailbox.mailbox_owner_identity USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON kody_mailbox.mailbox_owner_identity TO kody_writer;
GRANT SELECT ON kody_mailbox.mailbox_owner_identity TO kody_reader;
ALTER TABLE kody_mailbox.email_message_deletion_tombstones ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner ON kody_mailbox.email_message_deletion_tombstones USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON kody_mailbox.email_message_deletion_tombstones TO kody_writer;
GRANT SELECT ON kody_mailbox.email_message_deletion_tombstones TO kody_reader;
ALTER TABLE kody_mailbox.email_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner ON kody_mailbox.email_threads USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON kody_mailbox.email_threads TO kody_writer;
GRANT SELECT ON kody_mailbox.email_threads TO kody_reader;
ALTER TABLE kody_mailbox.email_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner ON kody_mailbox.email_messages USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON kody_mailbox.email_messages TO kody_writer;
GRANT SELECT ON kody_mailbox.email_messages TO kody_reader;
ALTER TABLE kody_mailbox.email_outbound_provider_index_repairs ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner ON kody_mailbox.email_outbound_provider_index_repairs USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON kody_mailbox.email_outbound_provider_index_repairs TO kody_writer;
GRANT SELECT ON kody_mailbox.email_outbound_provider_index_repairs TO kody_reader;
ALTER TABLE kody_mailbox.email_message_retention_retries ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner ON kody_mailbox.email_message_retention_retries USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON kody_mailbox.email_message_retention_retries TO kody_writer;
GRANT SELECT ON kody_mailbox.email_message_retention_retries TO kody_reader;
ALTER TABLE kody_mailbox.email_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner ON kody_mailbox.email_attachments USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON kody_mailbox.email_attachments TO kody_writer;
GRANT SELECT ON kody_mailbox.email_attachments TO kody_reader;
ALTER TABLE kody_mailbox.email_delivery_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner ON kody_mailbox.email_delivery_events USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON kody_mailbox.email_delivery_events TO kody_writer;
GRANT SELECT ON kody_mailbox.email_delivery_events TO kody_reader;
