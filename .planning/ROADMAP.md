# Roadmap: MailBox One

## Overview

Four phases, each delivering a coherent capability. Phase 1 establishes the verified hardware and service foundation that everything else depends on — GPU passthrough confirmed, all five containers healthy. Phase 2 builds the complete email processing loop end-to-end: IMAP in, Qwen3 classification, RAG-augmented draft, approval queue, SMTP out — with persona tuning and history ingestion at first boot. Phase 3 hands control to the operator: graduated auto-send, classification correction, OTA updates, and email notifications. Phase 4 completes the dashboard UI as a polished, mobile-responsive appliance interface. Granularity: coarse.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Infrastructure Foundation** - Verified Docker Compose stack with GPU inference confirmed, all five services healthy on Jetson Orin Nano Super
- [ ] **Phase 2: Email Pipeline Core** - Complete end-to-end email loop: IMAP ingestion, classification, RAG-augmented drafting, approval queue, SMTP send, persona tuning at first boot
- [ ] **Phase 3: Operator Trust and Reliability** - Graduated auto-send, classification correction, OTA updates, email notifications, graceful degradation
- [ ] **Phase 4: Dashboard and Hardening** - Full dashboard UI with approval queue, history logs, knowledge base management, system status, mobile-responsive, auth

## Phase Details

### Phase 1: Infrastructure Foundation
**Goal**: The Jetson Orin Nano Super runs all five services with GPU inference verified and the appliance boots to fully operational in under 3 minutes
**Depends on**: Nothing (first phase)
**Requirements**: INFRA-01, INFRA-02, INFRA-03, INFRA-04, INFRA-05, INFRA-06, INFRA-07, INFRA-08, INFRA-09, INFRA-11, INFRA-12
**Success Criteria** (what must be TRUE):
  1. Jetson boots headless into JetPack 6.2, `docker compose up` brings all five services to healthy within 3 minutes
  2. `docker run --rm --runtime nvidia nvidia-smi` confirms GPU passthrough; Ollama reports `num_gpu_layers > 0` for Qwen3-4B
  3. Qwen3-4B generates a test completion in under 5 seconds; nomic-embed-text returns embeddings on request
  4. Qdrant starts without jemalloc ARM64 errors; Postgres persists data across a container restart
  5. Power mode set to MAXN (25W) at boot via systemd; NVMe encrypted with LUKS
**Plans**: 3 plans
Plans:
- [x] 01-01-PLAN.md — Docker Compose stack, env template, Postgres schema init, dashboard placeholder
- [ ] 01-02-PLAN.md — First-boot checkpoint script (JetPack validation through compose start)
- [ ] 01-03-PLAN.md — Smoke test script (all success criteria + boot time verification)

### Phase 2: Email Pipeline Core
**Goal**: A real inbound email flows from IMAP through classification and RAG-augmented drafting into an approval queue, and the approved draft sends via SMTP from the customer's address — with persona extracted from sent history at first boot
**Depends on**: Phase 1
**Requirements**: MAIL-01, MAIL-02, MAIL-03, MAIL-04, MAIL-05, MAIL-06, MAIL-07, MAIL-08, MAIL-09, MAIL-10, MAIL-11, MAIL-12, MAIL-13, MAIL-14, RAG-01, RAG-02, RAG-03, RAG-04, RAG-05, RAG-06, PERS-01, PERS-02, PERS-03, PERS-04, PERS-05, ONBR-01, ONBR-02, ONBR-03, ONBR-04, ONBR-05, ONBR-06, APPR-01, APPR-02
**Success Criteria** (what must be TRUE):
  1. An email arriving in the connected Gmail inbox appears in the approval queue within 90 seconds, classified into one of the 8 CPG categories with a confidence score
  2. Classification accuracy on a 100-email Heron Labs test set exceeds 80%; `<think>` tokens are stripped and invalid JSON falls back to "unknown" without crashing the pipeline
  3. Each draft shows its source label (Local / Qwen3 or Cloud / Claude Haiku), top-3 RAG context references, and the draft reflects the operator's voice extracted from sent history
  4. Approving a draft in the queue sends it from the customer's SMTP address; rejecting a draft discards it; complex emails queue with "awaiting cloud" status when the API is unreachable
  5. First-boot wizard connects email, ingests 6 months of sent history with a progress indicator, and surfaces a persona tuning session with 20 sample drafts before live email begins
**Plans**: TBD
**UI hint**: yes

### Phase 3: Operator Trust and Reliability
**Goal**: The operator has graduated auto-send controls they can unlock per category, visibility into classification accuracy over time, OTA updates with rollback, email notifications, and the pipeline handles outages without data loss
**Depends on**: Phase 2
**Requirements**: APPR-03, APPR-04, APPR-05, APPR-06, NOTF-01, NOTF-02, INFRA-10
**Success Criteria** (what must be TRUE):
  1. Auto-send is OFF by default for all categories; the operator can enable it per category after observing accuracy, and correctly classified emails at threshold confidence send without entering the queue
  2. The dashboard shows daily/weekly send volume, pending queue count, and time-in-queue per draft; the operator can view and correct any classification to improve accuracy over time
  3. An OTA update can be triggered from the dashboard; the previous image is retained on-device and can be rolled back if the post-update health check fails
  4. The operator receives an email alert when the queue exceeds the configured threshold, and a daily digest summarizing received/drafted/sent/pending/escalated counts
**Plans**: TBD
**UI hint**: yes

### Phase 4: Dashboard and Hardening
**Goal**: The dashboard is a complete, mobile-responsive appliance interface accessible at http://device.local:3000 — approval queue, history logs, knowledge base, persona settings, system status, and authentication all functional from a phone on the same Wi-Fi
**Depends on**: Phase 3
**Requirements**: DASH-01, DASH-02, DASH-03, DASH-04, DASH-05, DASH-06, DASH-07, DASH-08, DASH-09, DASH-10
**Success Criteria** (what must be TRUE):
  1. The dashboard loads at http://device.local:3000 on a phone browser over LAN, requires username/password set during first-boot, and all views render correctly at mobile viewport
  2. The approval queue shows pending drafts with original email, draft text, confidence score, source label (Local/Cloud), and approve/edit/reject/escalate actions
  3. Sent history, classification log, and knowledge base management (upload PDF/DOCX/CSV, view, remove) are all accessible and functional
  4. The system status view shows uptime, email connection health, model status, disk usage, queue depth, and API cost meter — all reflecting live appliance state
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Infrastructure Foundation | 0/3 | Not started | - |
| 2. Email Pipeline Core | 0/TBD | Not started | - |
| 3. Operator Trust and Reliability | 0/TBD | Not started | - |
| 4. Dashboard and Hardening | 0/TBD | Not started | - |
