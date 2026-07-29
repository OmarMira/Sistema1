--
-- PostgreSQL database dump
--

-- Dumped from database version 17.4
-- Dumped by pg_dump version 17.4

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
-- Name: drizzle; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA drizzle;


--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS '';


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: DecisionReason; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."DecisionReason" AS ENUM (
    'COMPANY_KNOWLEDGE_CONFIRMED',
    'COMPANY_KNOWLEDGE_UPDATED',
    'COMPANY_KNOWLEDGE_MERGED',
    'ENTITY_CONTEXT_MATCH',
    'BANK_RULE_MATCH',
    'LLM_SUGGESTION',
    'MANUAL_OVERRIDE',
    'FALLBACK_DEFAULT'
);


--
-- Name: EntityType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."EntityType" AS ENUM (
    'PERSON',
    'COMPANY',
    'FINANCIAL_PRODUCT',
    'PLATFORM',
    'ASSET'
);


--
-- Name: TransactionIntent; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."TransactionIntent" AS ENUM (
    'LOAN_PAYMENT',
    'RENT_PAYMENT',
    'OPERATING_EXPENSE',
    'OWNER_CONTRIBUTION',
    'CUSTOMER_PAYMENT',
    'TRANSFER',
    'TAX_PAYMENT',
    'OTHER'
);


--
-- Name: fn_audit_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_audit_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  BEGIN
    RAISE EXCEPTION 'audit_logs is immutable — UPDATE not allowed';
  END;
  $$;


--
-- Name: fn_audit_nodelete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_audit_nodelete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  BEGIN
    RAISE EXCEPTION 'audit_logs is immutable — DELETE not allowed';
  END;
  $$;


--
-- Name: fn_protect_closed_period(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_protect_closed_period() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  DECLARE
    period_status TEXT;
  BEGIN
    SELECT status INTO period_status
      FROM fiscal_periods
     WHERE id = NEW.period_id;

    IF period_status IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'Cannot insert into a closed or locked fiscal period';
    END IF;

    RETURN NEW;
  END;
  $$;


--
-- Name: fn_protect_posted_entry(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_protect_posted_entry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  BEGIN
    IF OLD.status = 'posted' AND NEW.status <> 'voided' THEN
      RAISE EXCEPTION 'Cannot modify a posted journal entry — create a reversing entry instead';
    END IF;
    RETURN NEW;
  END;
  $$;


--
-- Name: fn_verify_void_reverses(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_verify_void_reverses() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  BEGIN
    IF NEW.status = 'voided' AND NEW.reverses_id IS NULL THEN
      RAISE EXCEPTION 'Cannot void a journal entry without a reverses_id';
    END IF;
    RETURN NEW;
  END;
  $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: __drizzle_migrations; Type: TABLE; Schema: drizzle; Owner: -
--

CREATE TABLE drizzle.__drizzle_migrations (
    id integer NOT NULL,
    hash text NOT NULL,
    created_at bigint
);


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE; Schema: drizzle; Owner: -
--

CREATE SEQUENCE drizzle.__drizzle_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: drizzle; Owner: -
--

ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNED BY drizzle.__drizzle_migrations.id;


--
-- Name: AuditLog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AuditLog" (
    id text NOT NULL,
    "companyId" text,
    "userId" text,
    action text NOT NULL,
    entity text NOT NULL,
    "entityId" text,
    details text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    hash text,
    "previousHash" text
);


--
-- Name: BankAccount; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."BankAccount" (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "accountName" text NOT NULL,
    "bankName" text NOT NULL,
    "accountNo" text,
    "routingNo" text,
    "glAccountId" text NOT NULL,
    balance numeric(18,2) DEFAULT 0 NOT NULL,
    "initialBalance" numeric(18,2) DEFAULT 0 NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: BankProfile; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."BankProfile" (
    id text NOT NULL,
    "bankId" text NOT NULL,
    "bankName" text NOT NULL,
    fingerprints text NOT NULL,
    "isActive" boolean DEFAULT true NOT NULL,
    "requiresReview" boolean DEFAULT false NOT NULL,
    config text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: BankRule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."BankRule" (
    id text NOT NULL,
    "companyId" text NOT NULL,
    name text NOT NULL,
    "conditionType" text NOT NULL,
    "conditionValue" text NOT NULL,
    "transactionDirection" text DEFAULT 'any'::text NOT NULL,
    "glAccountId" text,
    conditions jsonb,
    "debitGlAccountId" text,
    "creditGlAccountId" text,
    priority integer DEFAULT 10 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "entityContextId" text,
    "isManuallyEdited" boolean DEFAULT false NOT NULL,
    intent public."TransactionIntent",
    "isActive" boolean DEFAULT true NOT NULL
);


--
-- Name: BankStatement; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."BankStatement" (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "bankAccountId" text NOT NULL,
    "startDate" timestamp(3) without time zone NOT NULL,
    "endDate" timestamp(3) without time zone NOT NULL,
    "openingBalance" numeric(18,2) NOT NULL,
    "closingBalance" numeric(18,2) NOT NULL,
    "totalCredits" numeric(18,2) DEFAULT 0 NOT NULL,
    "totalDebits" numeric(18,2) DEFAULT 0 NOT NULL,
    format text NOT NULL,
    "fileName" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: BankTransaction; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."BankTransaction" (
    id text NOT NULL,
    "statementId" text NOT NULL,
    date timestamp(3) without time zone NOT NULL,
    description text NOT NULL,
    amount numeric(18,2) NOT NULL,
    reference text,
    "isReconciled" boolean DEFAULT false NOT NULL,
    "glAccountId" text,
    "matchedRuleId" text,
    "reconciledAt" timestamp(3) without time zone,
    "reconciliationPeriodId" text,
    status text DEFAULT 'posted'::text NOT NULL,
    "importHash" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "journalEntryId" text,
    "journalLineId" text,
    "isIgnored" boolean DEFAULT false NOT NULL
);


--
-- Name: Company; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Company" (
    id text NOT NULL,
    "legalName" text NOT NULL,
    "entityType" text DEFAULT 'BUSINESS'::text NOT NULL,
    "taxId" text,
    address text,
    phone text,
    email text,
    logo text,
    "streetLine1" text DEFAULT ''::text NOT NULL,
    "streetLine2" text DEFAULT ''::text NOT NULL,
    city text DEFAULT ''::text NOT NULL,
    state text DEFAULT ''::text NOT NULL,
    "zipCode" text DEFAULT ''::text NOT NULL,
    "isActive" boolean DEFAULT true NOT NULL,
    "isOnboardingComplete" boolean DEFAULT false NOT NULL,
    "entityFirstMode" boolean DEFAULT false NOT NULL,
    "maxApplyTransactions" integer,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "autoRoleAssignment" boolean DEFAULT false NOT NULL
);


--
-- Name: CompanyKnowledge; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CompanyKnowledge" (
    id text NOT NULL,
    "companyId" text NOT NULL,
    type public."EntityType" NOT NULL,
    "canonicalName" text NOT NULL,
    aliases text[],
    relationship text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    source text DEFAULT 'company_knowledge'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    "mergedIntoId" text,
    version integer DEFAULT 1 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: CompanyMember; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CompanyMember" (
    id text NOT NULL,
    "userId" text NOT NULL,
    "companyId" text NOT NULL,
    role text DEFAULT 'company_admin'::text NOT NULL,
    "joinedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: DetectionConfig; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."DetectionConfig" (
    "companyId" text NOT NULL,
    threshold double precision,
    "clusterMode" text,
    "minOccurrences" integer,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "updatedBy" text
);


--
-- Name: EntityContext; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."EntityContext" (
    id text NOT NULL,
    "companyId" text NOT NULL,
    pattern text NOT NULL,
    role text NOT NULL,
    roles text,
    "userDescription" text,
    "transactionDirection" text,
    "glAccountId" text,
    source text DEFAULT 'user'::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "autoAssignedAt" timestamp(3) without time zone
);


--
-- Name: FiscalPeriod; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."FiscalPeriod" (
    id text NOT NULL,
    "companyId" text NOT NULL,
    name text NOT NULL,
    "startDate" timestamp(3) without time zone NOT NULL,
    "endDate" timestamp(3) without time zone NOT NULL,
    "isLocked" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: GlAccount; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."GlAccount" (
    id text NOT NULL,
    "companyId" text NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    "accountType" text NOT NULL,
    "normalBalance" text NOT NULL,
    "parentId" text,
    "isActive" boolean DEFAULT true NOT NULL,
    "isSystem" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    balance numeric(18,2) DEFAULT 0 NOT NULL
);


--
-- Name: JournalEntry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."JournalEntry" (
    id text NOT NULL,
    "companyId" text NOT NULL,
    date timestamp(3) without time zone NOT NULL,
    description text NOT NULL,
    reference text,
    status text DEFAULT 'draft'::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    hash text,
    "previousHash" text
);


--
-- Name: JournalLine; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."JournalLine" (
    id text NOT NULL,
    "entryId" text NOT NULL,
    "glAccountId" text NOT NULL,
    description text,
    debit numeric(18,2) DEFAULT 0 NOT NULL,
    credit numeric(18,2) DEFAULT 0 NOT NULL
);


--
-- Name: KnowledgeAudit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."KnowledgeAudit" (
    id text NOT NULL,
    "knowledgeId" text NOT NULL,
    action text NOT NULL,
    version integer NOT NULL,
    "beforeValue" jsonb,
    "afterValue" jsonb,
    "changedByUserId" text NOT NULL,
    "timestamp" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    source text NOT NULL,
    reason text NOT NULL
);


--
-- Name: PendingApproval; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."PendingApproval" (
    id text NOT NULL,
    "knowledgeId" text,
    action text NOT NULL,
    payload jsonb NOT NULL,
    "requestedBy" text NOT NULL,
    "requestedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL
);


--
-- Name: RateLimit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."RateLimit" (
    id text NOT NULL,
    key text NOT NULL,
    hits integer DEFAULT 0 NOT NULL,
    "windowMs" integer DEFAULT 0 NOT NULL,
    "resetAt" timestamp(3) without time zone NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: ReconciliationPeriod; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ReconciliationPeriod" (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "bankAccountId" text NOT NULL,
    "userId" text NOT NULL,
    "statementBalance" numeric(18,2) DEFAULT 0 NOT NULL,
    "bookBalance" numeric(18,2) DEFAULT 0 NOT NULL,
    difference numeric(18,2) DEFAULT 0 NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    "startedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "completedAt" timestamp(3) without time zone,
    "transactionCount" integer DEFAULT 0 NOT NULL,
    notes text
);


--
-- Name: Session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Session" (
    id text NOT NULL,
    "userId" text NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: SystemConfig; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SystemConfig" (
    id text NOT NULL,
    key text NOT NULL,
    value text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: SystemMemory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SystemMemory" (
    id text NOT NULL,
    "companyId" text NOT NULL,
    type text NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    keywords text NOT NULL,
    importance integer DEFAULT 5 NOT NULL,
    "accessCount" integer DEFAULT 0 NOT NULL,
    "lastAccessedAt" timestamp(3) without time zone,
    embedding text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: User; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."User" (
    id text NOT NULL,
    email text NOT NULL,
    "passwordHash" text NOT NULL,
    "firstName" text NOT NULL,
    "lastName" text NOT NULL,
    role text DEFAULT 'company_admin'::text NOT NULL,
    "isActive" boolean DEFAULT true NOT NULL,
    phone text DEFAULT ''::text NOT NULL,
    "streetLine1" text DEFAULT ''::text NOT NULL,
    "streetLine2" text DEFAULT ''::text NOT NULL,
    city text DEFAULT ''::text NOT NULL,
    state text DEFAULT ''::text NOT NULL,
    "zipCode" text DEFAULT ''::text NOT NULL,
    avatar text DEFAULT ''::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


--
-- Name: _prisma_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public._prisma_migrations (
    id character varying(36) NOT NULL,
    checksum character varying(64) NOT NULL,
    finished_at timestamp with time zone,
    migration_name character varying(255) NOT NULL,
    logs text,
    rolled_back_at timestamp with time zone,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_steps_count integer DEFAULT 0 NOT NULL
);


--
-- Name: __drizzle_migrations id; Type: DEFAULT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations ALTER COLUMN id SET DEFAULT nextval('drizzle.__drizzle_migrations_id_seq'::regclass);


--
-- Name: __drizzle_migrations __drizzle_migrations_pkey; Type: CONSTRAINT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations
    ADD CONSTRAINT __drizzle_migrations_pkey PRIMARY KEY (id);


--
-- Name: AuditLog AuditLog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AuditLog"
    ADD CONSTRAINT "AuditLog_pkey" PRIMARY KEY (id);


--
-- Name: BankAccount BankAccount_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BankAccount"
    ADD CONSTRAINT "BankAccount_pkey" PRIMARY KEY (id);


--
-- Name: BankProfile BankProfile_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BankProfile"
    ADD CONSTRAINT "BankProfile_pkey" PRIMARY KEY (id);


--
-- Name: BankRule BankRule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BankRule"
    ADD CONSTRAINT "BankRule_pkey" PRIMARY KEY (id);


--
-- Name: BankStatement BankStatement_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BankStatement"
    ADD CONSTRAINT "BankStatement_pkey" PRIMARY KEY (id);


--
-- Name: BankTransaction BankTransaction_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BankTransaction"
    ADD CONSTRAINT "BankTransaction_pkey" PRIMARY KEY (id);


--
-- Name: CompanyKnowledge CompanyKnowledge_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CompanyKnowledge"
    ADD CONSTRAINT "CompanyKnowledge_pkey" PRIMARY KEY (id);


--
-- Name: CompanyMember CompanyMember_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CompanyMember"
    ADD CONSTRAINT "CompanyMember_pkey" PRIMARY KEY (id);


--
-- Name: Company Company_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Company"
    ADD CONSTRAINT "Company_pkey" PRIMARY KEY (id);


--
-- Name: DetectionConfig DetectionConfig_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DetectionConfig"
    ADD CONSTRAINT "DetectionConfig_pkey" PRIMARY KEY ("companyId");


--
-- Name: EntityContext EntityContext_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."EntityContext"
    ADD CONSTRAINT "EntityContext_pkey" PRIMARY KEY (id);


--
-- Name: FiscalPeriod FiscalPeriod_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FiscalPeriod"
    ADD CONSTRAINT "FiscalPeriod_pkey" PRIMARY KEY (id);


--
-- Name: GlAccount GlAccount_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GlAccount"
    ADD CONSTRAINT "GlAccount_pkey" PRIMARY KEY (id);


--
-- Name: JournalEntry JournalEntry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."JournalEntry"
    ADD CONSTRAINT "JournalEntry_pkey" PRIMARY KEY (id);


--
-- Name: JournalLine JournalLine_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."JournalLine"
    ADD CONSTRAINT "JournalLine_pkey" PRIMARY KEY (id);


--
-- Name: KnowledgeAudit KnowledgeAudit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."KnowledgeAudit"
    ADD CONSTRAINT "KnowledgeAudit_pkey" PRIMARY KEY (id);


--
-- Name: PendingApproval PendingApproval_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PendingApproval"
    ADD CONSTRAINT "PendingApproval_pkey" PRIMARY KEY (id);


--
-- Name: RateLimit RateLimit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."RateLimit"
    ADD CONSTRAINT "RateLimit_pkey" PRIMARY KEY (id);


--
-- Name: ReconciliationPeriod ReconciliationPeriod_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ReconciliationPeriod"
    ADD CONSTRAINT "ReconciliationPeriod_pkey" PRIMARY KEY (id);


--
-- Name: Session Session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Session"
    ADD CONSTRAINT "Session_pkey" PRIMARY KEY (id);


--
-- Name: SystemConfig SystemConfig_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SystemConfig"
    ADD CONSTRAINT "SystemConfig_pkey" PRIMARY KEY (id);


--
-- Name: SystemMemory SystemMemory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SystemMemory"
    ADD CONSTRAINT "SystemMemory_pkey" PRIMARY KEY (id);


--
-- Name: User User_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."User"
    ADD CONSTRAINT "User_pkey" PRIMARY KEY (id);


--
-- Name: _prisma_migrations _prisma_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._prisma_migrations
    ADD CONSTRAINT _prisma_migrations_pkey PRIMARY KEY (id);


--
-- Name: AuditLog_companyId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AuditLog_companyId_createdAt_idx" ON public."AuditLog" USING btree ("companyId", "createdAt");


--
-- Name: AuditLog_companyId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AuditLog_companyId_idx" ON public."AuditLog" USING btree ("companyId");


--
-- Name: AuditLog_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AuditLog_createdAt_idx" ON public."AuditLog" USING btree ("createdAt");


--
-- Name: AuditLog_userId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "AuditLog_userId_createdAt_idx" ON public."AuditLog" USING btree ("userId", "createdAt");


--
-- Name: BankAccount_companyId_accountNo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BankAccount_companyId_accountNo_idx" ON public."BankAccount" USING btree ("companyId", "accountNo");


--
-- Name: BankAccount_companyId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BankAccount_companyId_idx" ON public."BankAccount" USING btree ("companyId");


--
-- Name: BankAccount_glAccountId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BankAccount_glAccountId_idx" ON public."BankAccount" USING btree ("glAccountId");


--
-- Name: BankProfile_bankId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "BankProfile_bankId_key" ON public."BankProfile" USING btree ("bankId");


--
-- Name: BankProfile_isActive_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BankProfile_isActive_idx" ON public."BankProfile" USING btree ("isActive");


--
-- Name: BankProfile_requiresReview_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BankProfile_requiresReview_idx" ON public."BankProfile" USING btree ("requiresReview");


--
-- Name: BankRule_companyId_isActive_priority_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BankRule_companyId_isActive_priority_idx" ON public."BankRule" USING btree ("companyId", "isActive", priority);


--
-- Name: BankStatement_bankAccountId_endDate_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BankStatement_bankAccountId_endDate_idx" ON public."BankStatement" USING btree ("bankAccountId", "endDate");


--
-- Name: BankStatement_bankAccountId_startDate_endDate_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "BankStatement_bankAccountId_startDate_endDate_key" ON public."BankStatement" USING btree ("bankAccountId", "startDate", "endDate");


--
-- Name: BankTransaction_glAccountId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BankTransaction_glAccountId_idx" ON public."BankTransaction" USING btree ("glAccountId");


--
-- Name: BankTransaction_importHash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BankTransaction_importHash_idx" ON public."BankTransaction" USING btree ("importHash");


--
-- Name: BankTransaction_importHash_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "BankTransaction_importHash_key" ON public."BankTransaction" USING btree ("importHash");


--
-- Name: BankTransaction_isIgnored_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BankTransaction_isIgnored_idx" ON public."BankTransaction" USING btree ("isIgnored");


--
-- Name: BankTransaction_isReconciled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BankTransaction_isReconciled_idx" ON public."BankTransaction" USING btree ("isReconciled");


--
-- Name: BankTransaction_isReconciled_journalEntryId_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BankTransaction_isReconciled_journalEntryId_date_idx" ON public."BankTransaction" USING btree ("isReconciled", "journalEntryId", date);


--
-- Name: BankTransaction_journalEntryId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "BankTransaction_journalEntryId_key" ON public."BankTransaction" USING btree ("journalEntryId");


--
-- Name: BankTransaction_journalLineId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "BankTransaction_journalLineId_key" ON public."BankTransaction" USING btree ("journalLineId");


--
-- Name: BankTransaction_reference_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BankTransaction_reference_idx" ON public."BankTransaction" USING btree (reference);


--
-- Name: BankTransaction_statementId_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BankTransaction_statementId_date_idx" ON public."BankTransaction" USING btree ("statementId", date);


--
-- Name: BankTransaction_statementId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BankTransaction_statementId_idx" ON public."BankTransaction" USING btree ("statementId");


--
-- Name: BankTransaction_statementId_isReconciled_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BankTransaction_statementId_isReconciled_date_idx" ON public."BankTransaction" USING btree ("statementId", "isReconciled", date);


--
-- Name: BankTransaction_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "BankTransaction_status_idx" ON public."BankTransaction" USING btree (status);


--
-- Name: CompanyKnowledge_canonicalName_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "CompanyKnowledge_canonicalName_idx" ON public."CompanyKnowledge" USING btree ("canonicalName");


--
-- Name: CompanyKnowledge_companyId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "CompanyKnowledge_companyId_idx" ON public."CompanyKnowledge" USING btree ("companyId");


--
-- Name: CompanyKnowledge_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "CompanyKnowledge_type_idx" ON public."CompanyKnowledge" USING btree (type);


--
-- Name: CompanyMember_userId_companyId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "CompanyMember_userId_companyId_key" ON public."CompanyMember" USING btree ("userId", "companyId");


--
-- Name: EntityContext_companyId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "EntityContext_companyId_idx" ON public."EntityContext" USING btree ("companyId");


--
-- Name: EntityContext_companyId_pattern_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "EntityContext_companyId_pattern_key" ON public."EntityContext" USING btree ("companyId", pattern);


--
-- Name: FiscalPeriod_companyId_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "FiscalPeriod_companyId_name_key" ON public."FiscalPeriod" USING btree ("companyId", name);


--
-- Name: GlAccount_companyId_accountType_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "GlAccount_companyId_accountType_idx" ON public."GlAccount" USING btree ("companyId", "accountType");


--
-- Name: GlAccount_companyId_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "GlAccount_companyId_code_key" ON public."GlAccount" USING btree ("companyId", code);


--
-- Name: GlAccount_companyId_parentId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "GlAccount_companyId_parentId_idx" ON public."GlAccount" USING btree ("companyId", "parentId");


--
-- Name: JournalEntry_companyId_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "JournalEntry_companyId_date_idx" ON public."JournalEntry" USING btree ("companyId", date);


--
-- Name: JournalLine_entryId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "JournalLine_entryId_idx" ON public."JournalLine" USING btree ("entryId");


--
-- Name: JournalLine_glAccountId_entryId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "JournalLine_glAccountId_entryId_idx" ON public."JournalLine" USING btree ("glAccountId", "entryId");


--
-- Name: JournalLine_glAccountId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "JournalLine_glAccountId_idx" ON public."JournalLine" USING btree ("glAccountId");


--
-- Name: KnowledgeAudit_knowledgeId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "KnowledgeAudit_knowledgeId_idx" ON public."KnowledgeAudit" USING btree ("knowledgeId");


--
-- Name: KnowledgeAudit_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "KnowledgeAudit_timestamp_idx" ON public."KnowledgeAudit" USING btree ("timestamp");


--
-- Name: PendingApproval_knowledgeId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PendingApproval_knowledgeId_idx" ON public."PendingApproval" USING btree ("knowledgeId");


--
-- Name: PendingApproval_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "PendingApproval_status_idx" ON public."PendingApproval" USING btree (status);


--
-- Name: RateLimit_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "RateLimit_key_idx" ON public."RateLimit" USING btree (key);


--
-- Name: RateLimit_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "RateLimit_key_key" ON public."RateLimit" USING btree (key);


--
-- Name: ReconciliationPeriod_companyId_bankAccountId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ReconciliationPeriod_companyId_bankAccountId_idx" ON public."ReconciliationPeriod" USING btree ("companyId", "bankAccountId");


--
-- Name: ReconciliationPeriod_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "ReconciliationPeriod_status_idx" ON public."ReconciliationPeriod" USING btree (status);


--
-- Name: Session_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Session_token_idx" ON public."Session" USING btree (token);


--
-- Name: Session_token_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Session_token_key" ON public."Session" USING btree (token);


--
-- Name: Session_userId_expiresAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Session_userId_expiresAt_idx" ON public."Session" USING btree ("userId", "expiresAt");


--
-- Name: Session_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Session_userId_idx" ON public."Session" USING btree ("userId");


--
-- Name: SystemConfig_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SystemConfig_key_idx" ON public."SystemConfig" USING btree (key);


--
-- Name: SystemConfig_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "SystemConfig_key_key" ON public."SystemConfig" USING btree (key);


--
-- Name: SystemMemory_companyId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SystemMemory_companyId_idx" ON public."SystemMemory" USING btree ("companyId");


--
-- Name: SystemMemory_importance_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SystemMemory_importance_idx" ON public."SystemMemory" USING btree (importance);


--
-- Name: SystemMemory_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SystemMemory_type_idx" ON public."SystemMemory" USING btree (type);


--
-- Name: User_email_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "User_email_key" ON public."User" USING btree (email);


--
-- Name: AuditLog AuditLog_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AuditLog"
    ADD CONSTRAINT "AuditLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: AuditLog AuditLog_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AuditLog"
    ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: BankAccount BankAccount_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BankAccount"
    ADD CONSTRAINT "BankAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: BankAccount BankAccount_glAccountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BankAccount"
    ADD CONSTRAINT "BankAccount_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES public."GlAccount"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: BankRule BankRule_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BankRule"
    ADD CONSTRAINT "BankRule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: BankRule BankRule_creditGlAccountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BankRule"
    ADD CONSTRAINT "BankRule_creditGlAccountId_fkey" FOREIGN KEY ("creditGlAccountId") REFERENCES public."GlAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: BankRule BankRule_debitGlAccountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BankRule"
    ADD CONSTRAINT "BankRule_debitGlAccountId_fkey" FOREIGN KEY ("debitGlAccountId") REFERENCES public."GlAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: BankRule BankRule_entityContextId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BankRule"
    ADD CONSTRAINT "BankRule_entityContextId_fkey" FOREIGN KEY ("entityContextId") REFERENCES public."EntityContext"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: BankRule BankRule_glAccountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BankRule"
    ADD CONSTRAINT "BankRule_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES public."GlAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: BankStatement BankStatement_bankAccountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BankStatement"
    ADD CONSTRAINT "BankStatement_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES public."BankAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: BankStatement BankStatement_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BankStatement"
    ADD CONSTRAINT "BankStatement_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: BankTransaction BankTransaction_glAccountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BankTransaction"
    ADD CONSTRAINT "BankTransaction_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES public."GlAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: BankTransaction BankTransaction_journalEntryId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BankTransaction"
    ADD CONSTRAINT "BankTransaction_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES public."JournalEntry"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: BankTransaction BankTransaction_journalLineId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BankTransaction"
    ADD CONSTRAINT "BankTransaction_journalLineId_fkey" FOREIGN KEY ("journalLineId") REFERENCES public."JournalLine"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: BankTransaction BankTransaction_matchedRuleId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BankTransaction"
    ADD CONSTRAINT "BankTransaction_matchedRuleId_fkey" FOREIGN KEY ("matchedRuleId") REFERENCES public."BankRule"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: BankTransaction BankTransaction_reconciliationPeriodId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BankTransaction"
    ADD CONSTRAINT "BankTransaction_reconciliationPeriodId_fkey" FOREIGN KEY ("reconciliationPeriodId") REFERENCES public."ReconciliationPeriod"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: BankTransaction BankTransaction_statementId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."BankTransaction"
    ADD CONSTRAINT "BankTransaction_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES public."BankStatement"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CompanyKnowledge CompanyKnowledge_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CompanyKnowledge"
    ADD CONSTRAINT "CompanyKnowledge_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: CompanyKnowledge CompanyKnowledge_mergedIntoId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CompanyKnowledge"
    ADD CONSTRAINT "CompanyKnowledge_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES public."CompanyKnowledge"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: CompanyMember CompanyMember_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CompanyMember"
    ADD CONSTRAINT "CompanyMember_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: CompanyMember CompanyMember_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CompanyMember"
    ADD CONSTRAINT "CompanyMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: DetectionConfig DetectionConfig_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."DetectionConfig"
    ADD CONSTRAINT "DetectionConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: EntityContext EntityContext_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."EntityContext"
    ADD CONSTRAINT "EntityContext_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: EntityContext EntityContext_glAccountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."EntityContext"
    ADD CONSTRAINT "EntityContext_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES public."GlAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: FiscalPeriod FiscalPeriod_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."FiscalPeriod"
    ADD CONSTRAINT "FiscalPeriod_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: GlAccount GlAccount_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GlAccount"
    ADD CONSTRAINT "GlAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: GlAccount GlAccount_parentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."GlAccount"
    ADD CONSTRAINT "GlAccount_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES public."GlAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: JournalEntry JournalEntry_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."JournalEntry"
    ADD CONSTRAINT "JournalEntry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: JournalLine JournalLine_entryId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."JournalLine"
    ADD CONSTRAINT "JournalLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES public."JournalEntry"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: JournalLine JournalLine_glAccountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."JournalLine"
    ADD CONSTRAINT "JournalLine_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES public."GlAccount"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: KnowledgeAudit KnowledgeAudit_knowledgeId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."KnowledgeAudit"
    ADD CONSTRAINT "KnowledgeAudit_knowledgeId_fkey" FOREIGN KEY ("knowledgeId") REFERENCES public."CompanyKnowledge"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: PendingApproval PendingApproval_knowledgeId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."PendingApproval"
    ADD CONSTRAINT "PendingApproval_knowledgeId_fkey" FOREIGN KEY ("knowledgeId") REFERENCES public."CompanyKnowledge"(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: ReconciliationPeriod ReconciliationPeriod_bankAccountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ReconciliationPeriod"
    ADD CONSTRAINT "ReconciliationPeriod_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES public."BankAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ReconciliationPeriod ReconciliationPeriod_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ReconciliationPeriod"
    ADD CONSTRAINT "ReconciliationPeriod_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: ReconciliationPeriod ReconciliationPeriod_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ReconciliationPeriod"
    ADD CONSTRAINT "ReconciliationPeriod_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: Session Session_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Session"
    ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: SystemMemory SystemMemory_companyId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SystemMemory"
    ADD CONSTRAINT "SystemMemory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public."Company"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

