---
name: cross-session-sync
description: Automatically sync important knowledge between the user's sessions on different messaging channels using the knowledge broker tools.
tools:
  - kb_publish
  - kb_subscribe
---

## Cross-Session Knowledge Synchronization

You are connected to a shared knowledge base that propagates important information across all of the user's messaging channels (WhatsApp, Slack, Telegram, Discord, etc.).

### Before every response

Call `kb_subscribe` silently before generating your response. This ensures you always have the latest facts from the user's other active channels — not just at session start, but throughout the entire conversation. Do not narrate this call or mention it to the user.

### After each user message

Check whether the message contains any of the following:

| Category | Examples |
|---|---|
| **scheduling** | meetings, appointments, deadlines, rescheduled events, calendar changes |
| **preference** | favorite things, settings, likes/dislikes, work style preferences |
| **contact** | names, roles, email addresses, phone numbers, where someone works |
| **project** | status updates, blockers, decisions, launches, feature changes |
| **task** | commitments, to-dos, reminders, follow-ups |
| **fact** | anything durable and cross-session relevant |

If any of the above are present, call `kb_publish` immediately with the extracted facts.

### Rules for fact extraction

- **INCLUDE** durable, standalone facts the user would expect to be remembered everywhere.
- **EXCLUDE** casual conversation, greetings, questions without clear answers, filler words.
- Each fact must be a complete, standalone sentence — clear enough to be understood with no prior context.
- Use a confidence score of 0.5–1.0 for publishable facts (higher = more certain this is a real, durable fact).

### Examples

**User says:** "My meeting with Acme Corp was moved to Thursday"
→ `kb_publish` with `[{"content": "Meeting with Acme Corp moved to Thursday", "category": "scheduling", "confidence": 0.95}]`

**User says:** "lol ok sure"
→ Do NOT publish. Pure noise.

**User says:** "I prefer dark mode in all my tools"
→ `kb_publish` with `[{"content": "User prefers dark mode in all tools", "category": "preference", "confidence": 0.9}]`

**User says:** "Sarah from Acme is their new lead designer"
→ `kb_publish` with `[{"content": "Sarah is the lead designer at Acme Corp", "category": "contact", "confidence": 0.85}]`

**User says:** "Can you remind me what time my Acme meeting is?"
→ Do NOT publish. It's a question, not a new fact. (Answer using existing shared knowledge instead.)

### When shared context arrives (bootstrap injection)

The system will automatically prepend shared facts from other sessions as an HTML comment block. Use these facts naturally when answering — do not read them aloud or copy them verbatim. If they are directly relevant to the user's question, incorporate them. If there is a conflict note, prefer the most recent information and mention the discrepancy only if it matters.
