--
-- mailbox schema snapshot — used by CI to bootstrap the test Postgres.
-- Captured from customer #1 production (Bob) on 2026-05-01 with:
--   ssh jetson-tailscale 'cd ~/mailbox && docker compose exec -T postgres \
--     pg_dump -U mailbox -d mailbox -n mailbox -s --no-owner --no-privileges' \
--     > dashboard/test/fixtures/schema.sql
-- Refresh whenever new migrations land. The schema-invariants tests rely on
-- the CHECK constraints here matching the live appliance.
--
-- PostgreSQL database dump
--

\restrict jsPo17P9Gn0vDqUWcxp0cOYofwJdgqmmXLfc7CA6tqz1TOw4iON2UeFaJdgOXW3

-- Dumped from database version 17.9
-- Dumped by pg_dump version 17.9

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: mailbox; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA mailbox;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: classification_log; Type: TABLE; Schema: mailbox; Owner: -
--

CREATE TABLE mailbox.classification_log (
    id bigint NOT NULL,
    inbox_message_id integer NOT NULL,
    category text NOT NULL,
    confidence real NOT NULL,
    model_version text NOT NULL,
    latency_ms integer,
    raw_output text,
    json_parse_ok boolean NOT NULL,
    think_stripped boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT classification_log_category_check CHECK ((category = ANY (ARRAY['inquiry'::text, 'reorder'::text, 'scheduling'::text, 'follow_up'::text, 'internal'::text, 'spam_marketing'::text, 'escalate'::text, 'unknown'::text])))
);


--
-- Name: classification_log_id_seq; Type: SEQUENCE; Schema: mailbox; Owner: -
--

CREATE SEQUENCE mailbox.classification_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: classification_log_id_seq; Type: SEQUENCE OWNED BY; Schema: mailbox; Owner: -
--

ALTER SEQUENCE mailbox.classification_log_id_seq OWNED BY mailbox.classification_log.id;


--
-- Name: drafts; Type: TABLE; Schema: mailbox; Owner: -
--

CREATE TABLE mailbox.drafts (
    id integer NOT NULL,
    inbox_message_id integer NOT NULL,
    draft_subject text,
    draft_body text NOT NULL,
    model text NOT NULL,
    input_tokens integer,
    output_tokens integer,
    cost_usd numeric(10,6),
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    error_message text,
    approved_at timestamp with time zone,
    sent_at timestamp with time zone,
    draft_source text,
    classification_category text,
    classification_confidence real,
    rag_context_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    auto_send_blocked boolean DEFAULT false NOT NULL,
    from_addr text,
    to_addr text,
    subject text,
    body_text text,
    received_at timestamp with time zone,
    message_id text,
    thread_id text,
    in_reply_to text,
    "references" text,
    CONSTRAINT drafts_classification_category_check CHECK (((classification_category IS NULL) OR (classification_category = ANY (ARRAY['inquiry'::text, 'reorder'::text, 'scheduling'::text, 'follow_up'::text, 'internal'::text, 'spam_marketing'::text, 'escalate'::text, 'unknown'::text])))),
    CONSTRAINT drafts_draft_source_check CHECK (((draft_source IS NULL) OR (draft_source = ANY (ARRAY['local'::text, 'cloud'::text, 'local_qwen3'::text, 'cloud_haiku'::text])))),
    CONSTRAINT drafts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'awaiting_cloud'::text, 'approved'::text, 'rejected'::text, 'edited'::text, 'sent'::text, 'failed'::text])))
);


--
-- Name: drafts_id_seq; Type: SEQUENCE; Schema: mailbox; Owner: -
--

CREATE SEQUENCE mailbox.drafts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: drafts_id_seq; Type: SEQUENCE OWNED BY; Schema: mailbox; Owner: -
--

ALTER SEQUENCE mailbox.drafts_id_seq OWNED BY mailbox.drafts.id;


--
-- Name: inbox_messages; Type: TABLE; Schema: mailbox; Owner: -
--

CREATE TABLE mailbox.inbox_messages (
    id integer NOT NULL,
    message_id text NOT NULL,
    thread_id text,
    from_addr text,
    to_addr text,
    subject text,
    received_at timestamp with time zone,
    snippet text,
    body text,
    classification text,
    confidence numeric(4,3),
    classified_at timestamp with time zone,
    model text,
    created_at timestamp with time zone DEFAULT now(),
    draft_id integer,
    in_reply_to text,
    "references" text
);


--
-- Name: inbox_messages_id_seq; Type: SEQUENCE; Schema: mailbox; Owner: -
--

CREATE SEQUENCE mailbox.inbox_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: inbox_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: mailbox; Owner: -
--

ALTER SEQUENCE mailbox.inbox_messages_id_seq OWNED BY mailbox.inbox_messages.id;


--
-- Name: migrations; Type: TABLE; Schema: mailbox; Owner: -
--

CREATE TABLE mailbox.migrations (
    version text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: onboarding; Type: TABLE; Schema: mailbox; Owner: -
--

CREATE TABLE mailbox.onboarding (
    id integer NOT NULL,
    customer_key text DEFAULT 'default'::text NOT NULL,
    stage text DEFAULT 'pending_admin'::text NOT NULL,
    admin_username text,
    admin_password_hash text,
    email_address text,
    ingest_progress_total integer,
    ingest_progress_done integer DEFAULT 0 NOT NULL,
    tuning_sample_count integer DEFAULT 0 NOT NULL,
    tuning_rated_count integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    lived_at timestamp with time zone,
    CONSTRAINT onboarding_stage_check CHECK ((stage = ANY (ARRAY['pending_admin'::text, 'pending_email'::text, 'ingesting'::text, 'pending_tuning'::text, 'tuning_in_progress'::text, 'live'::text])))
);


--
-- Name: onboarding_id_seq; Type: SEQUENCE; Schema: mailbox; Owner: -
--

CREATE SEQUENCE mailbox.onboarding_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: onboarding_id_seq; Type: SEQUENCE OWNED BY; Schema: mailbox; Owner: -
--

ALTER SEQUENCE mailbox.onboarding_id_seq OWNED BY mailbox.onboarding.id;


--
-- Name: persona; Type: TABLE; Schema: mailbox; Owner: -
--

CREATE TABLE mailbox.persona (
    id integer NOT NULL,
    customer_key text DEFAULT 'default'::text NOT NULL,
    statistical_markers jsonb DEFAULT '{}'::jsonb NOT NULL,
    category_exemplars jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_email_count integer DEFAULT 0 NOT NULL,
    last_refreshed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: persona_id_seq; Type: SEQUENCE; Schema: mailbox; Owner: -
--

CREATE SEQUENCE mailbox.persona_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: persona_id_seq; Type: SEQUENCE OWNED BY; Schema: mailbox; Owner: -
--

ALTER SEQUENCE mailbox.persona_id_seq OWNED BY mailbox.persona.id;


--
-- Name: rejected_history; Type: TABLE; Schema: mailbox; Owner: -
--

CREATE TABLE mailbox.rejected_history (
    id bigint NOT NULL,
    draft_id integer NOT NULL,
    inbox_message_id integer NOT NULL,
    from_addr text NOT NULL,
    subject text,
    classification_category text NOT NULL,
    classification_confidence real NOT NULL,
    draft_original text,
    rejected_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rejected_history_category_check CHECK ((classification_category = ANY (ARRAY['inquiry'::text, 'reorder'::text, 'scheduling'::text, 'follow_up'::text, 'internal'::text, 'spam_marketing'::text, 'escalate'::text, 'unknown'::text])))
);


--
-- Name: rejected_history_id_seq; Type: SEQUENCE; Schema: mailbox; Owner: -
--

CREATE SEQUENCE mailbox.rejected_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rejected_history_id_seq; Type: SEQUENCE OWNED BY; Schema: mailbox; Owner: -
--

ALTER SEQUENCE mailbox.rejected_history_id_seq OWNED BY mailbox.rejected_history.id;


--
-- Name: sent_history; Type: TABLE; Schema: mailbox; Owner: -
--

CREATE TABLE mailbox.sent_history (
    id bigint NOT NULL,
    draft_id integer NOT NULL,
    inbox_message_id integer NOT NULL,
    from_addr text NOT NULL,
    to_addr text NOT NULL,
    subject text,
    body_text text,
    thread_id text,
    draft_original text,
    draft_sent text NOT NULL,
    draft_source text NOT NULL,
    classification_category text NOT NULL,
    classification_confidence real NOT NULL,
    rag_context_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    sent_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sent_history_category_check CHECK ((classification_category = ANY (ARRAY['inquiry'::text, 'reorder'::text, 'scheduling'::text, 'follow_up'::text, 'internal'::text, 'spam_marketing'::text, 'escalate'::text, 'unknown'::text]))),
    CONSTRAINT sent_history_draft_source_check CHECK ((draft_source = ANY (ARRAY['local'::text, 'cloud'::text, 'local_qwen3'::text, 'cloud_haiku'::text])))
);


--
-- Name: sent_history_id_seq; Type: SEQUENCE; Schema: mailbox; Owner: -
--

CREATE SEQUENCE mailbox.sent_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sent_history_id_seq; Type: SEQUENCE OWNED BY; Schema: mailbox; Owner: -
--

ALTER SEQUENCE mailbox.sent_history_id_seq OWNED BY mailbox.sent_history.id;


--
-- Name: classification_log id; Type: DEFAULT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.classification_log ALTER COLUMN id SET DEFAULT nextval('mailbox.classification_log_id_seq'::regclass);


--
-- Name: drafts id; Type: DEFAULT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.drafts ALTER COLUMN id SET DEFAULT nextval('mailbox.drafts_id_seq'::regclass);


--
-- Name: inbox_messages id; Type: DEFAULT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.inbox_messages ALTER COLUMN id SET DEFAULT nextval('mailbox.inbox_messages_id_seq'::regclass);


--
-- Name: onboarding id; Type: DEFAULT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.onboarding ALTER COLUMN id SET DEFAULT nextval('mailbox.onboarding_id_seq'::regclass);


--
-- Name: persona id; Type: DEFAULT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.persona ALTER COLUMN id SET DEFAULT nextval('mailbox.persona_id_seq'::regclass);


--
-- Name: rejected_history id; Type: DEFAULT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.rejected_history ALTER COLUMN id SET DEFAULT nextval('mailbox.rejected_history_id_seq'::regclass);


--
-- Name: sent_history id; Type: DEFAULT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.sent_history ALTER COLUMN id SET DEFAULT nextval('mailbox.sent_history_id_seq'::regclass);


--
-- Name: classification_log classification_log_pkey; Type: CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.classification_log
    ADD CONSTRAINT classification_log_pkey PRIMARY KEY (id);


--
-- Name: drafts drafts_pkey; Type: CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.drafts
    ADD CONSTRAINT drafts_pkey PRIMARY KEY (id);


--
-- Name: inbox_messages inbox_messages_message_id_key; Type: CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.inbox_messages
    ADD CONSTRAINT inbox_messages_message_id_key UNIQUE (message_id);


--
-- Name: inbox_messages inbox_messages_pkey; Type: CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.inbox_messages
    ADD CONSTRAINT inbox_messages_pkey PRIMARY KEY (id);


--
-- Name: migrations migrations_pkey; Type: CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.migrations
    ADD CONSTRAINT migrations_pkey PRIMARY KEY (version);


--
-- Name: onboarding onboarding_pkey; Type: CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.onboarding
    ADD CONSTRAINT onboarding_pkey PRIMARY KEY (id);


--
-- Name: persona persona_pkey; Type: CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.persona
    ADD CONSTRAINT persona_pkey PRIMARY KEY (id);


--
-- Name: rejected_history rejected_history_pkey; Type: CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.rejected_history
    ADD CONSTRAINT rejected_history_pkey PRIMARY KEY (id);


--
-- Name: sent_history sent_history_pkey; Type: CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.sent_history
    ADD CONSTRAINT sent_history_pkey PRIMARY KEY (id);


--
-- Name: classification_log_category_idx; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX classification_log_category_idx ON mailbox.classification_log USING btree (category);


--
-- Name: classification_log_message_idx; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX classification_log_message_idx ON mailbox.classification_log USING btree (inbox_message_id);


--
-- Name: drafts_category_idx; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX drafts_category_idx ON mailbox.drafts USING btree (classification_category);


--
-- Name: drafts_rag_refs_gin; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX drafts_rag_refs_gin ON mailbox.drafts USING gin (rag_context_refs);


--
-- Name: drafts_received_at_idx; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX drafts_received_at_idx ON mailbox.drafts USING btree (received_at DESC);


--
-- Name: idx_drafts_message; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX idx_drafts_message ON mailbox.drafts USING btree (inbox_message_id);


--
-- Name: idx_drafts_status; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX idx_drafts_status ON mailbox.drafts USING btree (status);


--
-- Name: idx_inbox_messages_classification; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX idx_inbox_messages_classification ON mailbox.inbox_messages USING btree (classification);


--
-- Name: idx_inbox_messages_received_at; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX idx_inbox_messages_received_at ON mailbox.inbox_messages USING btree (received_at DESC);


--
-- Name: onboarding_customer_key_uq; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE UNIQUE INDEX onboarding_customer_key_uq ON mailbox.onboarding USING btree (customer_key);


--
-- Name: onboarding_stage_idx; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX onboarding_stage_idx ON mailbox.onboarding USING btree (stage);


--
-- Name: persona_customer_key_uq; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE UNIQUE INDEX persona_customer_key_uq ON mailbox.persona USING btree (customer_key);


--
-- Name: rejected_history_rejected_at_idx; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX rejected_history_rejected_at_idx ON mailbox.rejected_history USING btree (rejected_at DESC);


--
-- Name: sent_history_category_idx; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX sent_history_category_idx ON mailbox.sent_history USING btree (classification_category);


--
-- Name: sent_history_sent_at_idx; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX sent_history_sent_at_idx ON mailbox.sent_history USING btree (sent_at DESC);


--
-- Name: classification_log classification_log_inbox_message_id_fkey; Type: FK CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.classification_log
    ADD CONSTRAINT classification_log_inbox_message_id_fkey FOREIGN KEY (inbox_message_id) REFERENCES mailbox.inbox_messages(id) ON DELETE CASCADE;


--
-- Name: drafts drafts_inbox_message_id_fkey; Type: FK CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.drafts
    ADD CONSTRAINT drafts_inbox_message_id_fkey FOREIGN KEY (inbox_message_id) REFERENCES mailbox.inbox_messages(id) ON DELETE CASCADE;


--
-- Name: inbox_messages inbox_messages_draft_id_fkey; Type: FK CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.inbox_messages
    ADD CONSTRAINT inbox_messages_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES mailbox.drafts(id);


--
-- Migration 009 — STAQPRO-185 state_transitions log + trigger.
-- Appended manually to the snapshot until the next pg_dump refresh on Bob.
--

CREATE TABLE mailbox.state_transitions (
    id          bigserial PRIMARY KEY,
    draft_id    integer NOT NULL REFERENCES mailbox.drafts(id) ON DELETE CASCADE,
    from_status text NOT NULL,
    to_status   text NOT NULL,
    transitioned_at timestamptz NOT NULL DEFAULT NOW(),
    actor       text NOT NULL DEFAULT 'system',
    reason      text,
    hash_chain  text
);

CREATE INDEX state_transitions_draft_id_idx
    ON mailbox.state_transitions (draft_id, transitioned_at DESC);

CREATE INDEX state_transitions_transitioned_at_idx
    ON mailbox.state_transitions (transitioned_at DESC);

CREATE OR REPLACE FUNCTION mailbox.log_draft_state_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO mailbox.state_transitions (draft_id, from_status, to_status, actor, reason)
        VALUES (
            NEW.id,
            OLD.status,
            NEW.status,
            COALESCE(NULLIF(current_setting('mailbox.actor', true), ''), 'system'),
            NULLIF(current_setting('mailbox.transition_reason', true), '')
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER drafts_log_state_transition
    AFTER UPDATE OF status ON mailbox.drafts
    FOR EACH ROW
    EXECUTE FUNCTION mailbox.log_draft_state_transition();

-- STAQPRO-189: archive draft to sent_history on status -> 'sent' (mirrors
-- migration 010-fix-sent-history-and-archive-trigger).
CREATE OR REPLACE FUNCTION mailbox.archive_draft_to_sent_history()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent' THEN
        IF EXISTS (SELECT 1 FROM mailbox.sent_history WHERE draft_id = NEW.id) THEN
            RETURN NEW;
        END IF;

        INSERT INTO mailbox.sent_history (
            draft_id,
            inbox_message_id,
            from_addr,
            to_addr,
            subject,
            body_text,
            thread_id,
            draft_original,
            draft_sent,
            draft_source,
            classification_category,
            classification_confidence,
            sent_at
        ) VALUES (
            NEW.id,
            NEW.inbox_message_id,
            COALESCE(NEW.from_addr, ''),
            COALESCE(NEW.to_addr, ''),
            NEW.subject,
            NEW.body_text,
            NEW.thread_id,
            NEW.draft_body,
            NEW.draft_body,
            COALESCE(NEW.draft_source, 'local'),
            COALESCE(NEW.classification_category, 'unknown'),
            COALESCE(NEW.classification_confidence, 0.0),
            COALESCE(NEW.sent_at, NOW())
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER drafts_archive_to_sent_history
    AFTER UPDATE OF status ON mailbox.drafts
    FOR EACH ROW
    EXECUTE FUNCTION mailbox.archive_draft_to_sent_history();

-- Migration 011 — STAQPRO-193 sent_history extensions for Gmail Sent backfill.
-- (1) message_id for idempotent UPSERT on backfilled rows. (2) Relax NOT NULL
-- on draft_id + inbox_message_id (backfill rows have neither). (3) source
-- discriminator ('live' vs 'backfill') so persona/RAG read paths can stay
-- aware of provenance.

ALTER TABLE mailbox.sent_history ADD COLUMN message_id TEXT;
CREATE UNIQUE INDEX sent_history_message_id_unique
    ON mailbox.sent_history(message_id) WHERE message_id IS NOT NULL;
ALTER TABLE mailbox.sent_history ALTER COLUMN draft_id DROP NOT NULL;
ALTER TABLE mailbox.sent_history ALTER COLUMN inbox_message_id DROP NOT NULL;
ALTER TABLE mailbox.sent_history ADD COLUMN source TEXT NOT NULL DEFAULT 'live';
ALTER TABLE mailbox.sent_history
    ADD CONSTRAINT sent_history_source_check
    CHECK (source = ANY (ARRAY['live'::text,'backfill'::text]));
CREATE INDEX sent_history_source_idx ON mailbox.sent_history(source);

--
-- PostgreSQL database dump complete
--

\unrestrict jsPo17P9Gn0vDqUWcxp0cOYofwJdgqmmXLfc7CA6tqz1TOw4iON2UeFaJdgOXW3

