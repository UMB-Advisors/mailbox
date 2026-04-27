<!-- GSD:project-start source:PROJECT.md -->
## Project

**MailBox One Dashboard**

Standalone Next.js 14 dashboard for the MailBox One T2 appliance. Exposes a human-in-the-loop approval queue for LLM-generated email drafts; on approve, triggers a real Gmail send via an n8n webhook.

This closes Phase 1 deliverable #6 (dashboard approval queue) and ships workflow #3 (send pipeline) of the MailBox One product roadmap.

**Core Value:** The operator can review, edit, approve, or reject LLM-drafted email replies on their phone in under 30 seconds, and approval results in a real Gmail reply going out. Without the dashboard, drafts sit in `mailbox.drafts` with no path to send.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:STACK.md -->
## Technology Stack

Technology stack not yet documented. Will populate after codebase mapping or first phase.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
