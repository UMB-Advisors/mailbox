// Synthetic fixtures for the sandbox UI. The original file (kept local-only on
// the dev workstation) contains real production message bodies pulled from M1.
// This file is a same-shape placeholder so the sandbox runs end-to-end without
// shipping customer data into the repo. Names, companies, and addresses below
// are fabricated.

export type DraftStatus = "pending" | "approved" | "sent" | "rejected";

export interface PriorMessage {
  direction: "inbound" | "outbound";
  from_addr: string;
  body: string;
  at: string;
}

export interface DraftRow {
  id: number;
  status: DraftStatus;
  created_at: string;
  draft_source: string;
  model: string;
  classification_confidence: number | null;
  classification_category: string;
  from_addr: string;
  subject: string;
  received_at: string | null;
  inbound_body_preview: string;
  draft_subject: string | null;
  draft_body: string;
  sent_at?: string | null;
  approved_at?: string | null;
  prior_messages?: PriorMessage[];
}

export const drafts: DraftRow[] = [
  {
    id: 1,
    status: "pending",
    created_at: "2026-05-14T15:02:11+00:00",
    draft_source: "cloud",
    model: "gpt-oss:120b",
    classification_confidence: 0.94,
    classification_category: "escalate",
    from_addr: "alex@northstarretail.example",
    subject: "Shipment arrived damaged — need to talk before EOD",
    received_at: "2026-05-14T14:48:02+00:00",
    inbound_body_preview:
      "Hi Jordan,\n\nThree of the twelve cases from last week's order showed up with crushed corners and visible product damage. Our store manager is asking whether we should keep ordering from you — I'd like to get on a call today to figure out a path forward before this turns into something bigger.\n\nCan you pull the carrier paperwork and call me back this afternoon?\n\n— Alex",
    draft_subject: null,
    draft_body:
      "Alex,\n\nAcknowledged — I'll have the carrier paperwork pulled within the hour and I'll call you back by 3pm your time.\n\nBefore we talk I'll have answers on:\n* the damage pattern (carrier vs packaging at our end),\n* immediate replacement timing for the three damaged cases,\n* what we can do on the next shipment to prevent a repeat.\n\nIf you'd prefer to escalate to my partner Sam directly, just say the word and I'll loop them in.\n\n— Jordan",
    prior_messages: [
      {
        direction: "inbound",
        from_addr: "alex@northstarretail.example",
        at: "2026-05-07T16:21:00+00:00",
        body: "Jordan,\n\nGot the latest PO ack — looks good, thanks. Will flag if anything looks off on receipt.\n\n— Alex",
      },
    ],
  },
  {
    id: 2,
    status: "pending",
    created_at: "2026-05-14T13:41:09+00:00",
    draft_source: "local",
    model: "qwen3:4b-ctx4k",
    classification_confidence: 0.91,
    classification_category: "reorder",
    from_addr: "purchasing@meadowgrocers.example",
    subject: "Reorder — same as last month, plus 2 cases of the citrus SKU",
    received_at: "2026-05-14T13:28:44+00:00",
    inbound_body_preview:
      "Hi team,\n\nReady to reorder. Same quantities as the April PO, plus an additional 2 cases of the citrus variety — it's been moving well at the front of the store.\n\nPlease send the PO ack and a target ship date when you have a minute.\n\nThanks,\nDana — Meadow Grocers Purchasing",
    draft_subject: null,
    draft_body:
      "Dana,\n\nThanks — got the reorder. I'll mirror the April PO and add 2 cases of the citrus SKU.\n\nTarget ship date is Friday this week pending warehouse confirmation; I'll send the PO ack with line items and the freight quote later today.\n\n— Jordan",
  },
  {
    id: 3,
    status: "pending",
    created_at: "2026-05-14T11:55:22+00:00",
    draft_source: "local",
    model: "qwen3:4b-ctx4k",
    classification_confidence: 0.88,
    classification_category: "scheduling",
    from_addr: "morgan@harborcoffee.example",
    subject: "Can we move Thursday's tasting to next week?",
    received_at: "2026-05-14T11:42:10+00:00",
    inbound_body_preview:
      "Hey Jordan,\n\nOur GM is going to be out Thursday — any chance we push the in-store tasting to the following Tuesday or Wednesday? Same time slot ideally.\n\n— Morgan",
    draft_subject: null,
    draft_body:
      "Morgan,\n\nNo problem — Tuesday the 26th at the same time works on my end. I'll update the calendar invite and re-confirm the sample list.\n\nIf Wednesday is easier for the GM, that's open for me too — just say the word.\n\n— Jordan",
  },
  {
    id: 4,
    status: "approved",
    created_at: "2026-05-14T10:12:00+00:00",
    approved_at: "2026-05-14T10:18:35+00:00",
    draft_source: "local",
    model: "qwen3:4b-ctx4k",
    classification_confidence: 0.86,
    classification_category: "follow_up",
    from_addr: "ravi@brightline.example",
    subject: "Following up on the sample request from last month",
    received_at: "2026-05-14T09:58:01+00:00",
    inbound_body_preview:
      "Jordan,\n\nCircling back on the sample request from April — did the kit ever go out? We're moving into our summer planning cycle and I want to make sure your line is on the consideration list.\n\n— Ravi",
    draft_subject: null,
    draft_body:
      "Ravi,\n\nThanks for the nudge — the kit shipped on the 3rd and the tracking shows delivered the 6th. Let me know if it didn't reach you and I'll get a replacement out same-day.\n\nHappy to set up a 20-min call once you've had a chance to taste through it.\n\n— Jordan",
  },
  {
    id: 5,
    status: "pending",
    created_at: "2026-05-14T09:30:14+00:00",
    draft_source: "cloud",
    model: "gpt-oss:120b",
    classification_confidence: 0.82,
    classification_category: "inquiry",
    from_addr: "priya@studiothree.example",
    subject: "Wholesale terms + lead time question",
    received_at: "2026-05-14T09:14:48+00:00",
    inbound_body_preview:
      "Hi — found you through a colleague. We run a small chain (4 locations) and are evaluating new vendors for Q3. Could you share your wholesale price list, MOQ, and typical lead time from PO to dock?\n\nThanks,\nPriya",
    draft_subject: null,
    draft_body:
      "Priya,\n\nGreat to hear from you. Attaching our current wholesale sheet with MOQ and lead time at the top (10 cases per SKU, 7–10 business days from PO).\n\nIf it's useful I can drop a sample kit in the mail this week — just send the address you'd like it sent to.\n\n— Jordan",
  },
  {
    id: 6,
    status: "sent",
    created_at: "2026-05-13T17:02:55+00:00",
    approved_at: "2026-05-13T17:09:12+00:00",
    sent_at: "2026-05-13T17:09:14+00:00",
    draft_source: "local",
    model: "qwen3:4b-ctx4k",
    classification_confidence: 0.93,
    classification_category: "internal",
    from_addr: "sam@example-co.example",
    subject: "warehouse coverage next Friday",
    received_at: "2026-05-13T16:50:21+00:00",
    inbound_body_preview:
      "Jordan — I'll be out next Friday for the dentist thing. Can you cover the morning inbound window so receiving doesn't stack up?\n\n— Sam",
    draft_subject: null,
    draft_body:
      "Sam,\n\nCovered — I'll be onsite 8–noon. Anything you want me to flag while I'm there?\n\n— Jordan",
  },
  {
    id: 7,
    status: "rejected",
    created_at: "2026-05-13T15:11:08+00:00",
    draft_source: "cloud",
    model: "gpt-oss:120b",
    classification_confidence: 0.61,
    classification_category: "unknown",
    from_addr: "promotions@vendorlist.example",
    subject: "Last chance — annual partner survey closes today",
    received_at: "2026-05-13T15:02:00+00:00",
    inbound_body_preview:
      "Hi Partner,\n\nOur annual partner survey closes today. Click here to share your feedback and be entered to win a $250 gift card!\n\nThanks,\nThe Vendorlist Team",
    draft_subject: null,
    draft_body:
      "Thanks — we'll take a look when we have a moment.\n\n— Jordan",
  },
  {
    id: 8,
    status: "pending",
    created_at: "2026-05-14T16:44:30+00:00",
    draft_source: "cloud",
    model: "gpt-oss:120b",
    classification_confidence: 0.72,
    classification_category: "escalate",
    from_addr: "legal@bigboxgrocer.example",
    subject: "Updated vendor compliance packet — signature required",
    received_at: "2026-05-14T16:30:11+00:00",
    inbound_body_preview:
      "Vendor,\n\nPlease find attached our updated compliance packet covering insurance minimums, traceability requirements, and recall procedures. Signature and return required within 14 days to remain an active vendor.\n\n— BigBox Grocer Legal",
    draft_subject: null,
    draft_body:
      "Hi —\n\nReceived; I'll route this to our partner Sam and our insurance broker for review and circle back with the signed packet inside the 14-day window. If anything in the new minimums creates a gap we'll flag it before signing.\n\n— Jordan",
  },
];
