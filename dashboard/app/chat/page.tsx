import { AppShell } from '@/components/AppShell';
import { ChatClient } from '@/components/ChatClient';
import { getConversationMessages, listConversations } from '@/lib/queries-chat';
import type { ChatConversation, ChatMessage } from '@/lib/types';

export const dynamic = 'force-dynamic';

// MBOX-287 — /dashboard/chat. Served under the /dashboard basePath (next.config
// BASE_PATH) behind Caddy basic_auth, same as every other operator surface. The
// page is the local-model conversational UI: the customer talks to their own
// on-device model (DR-53, no cloud path), augmented by their own indexed email
// corpus when retrieval clears the relevance floor (MBOX-283 / DR-56).
//
// Server component: SSR the conversation sidebar (listConversations) and, when
// a conversation is selected via ?c=<id>, its turns (getConversationMessages),
// so a reload / container restart replays history (MBOX-285 AC). The streaming
// turn loop, retrieval-gated sources, and the honest in-flight flag all live
// client-side in ChatClient.

interface ChatPageProps {
  searchParams?: { c?: string | string[] };
}

function parseConversationId(raw: string | string[] | undefined): number | null {
  if (Array.isArray(raw)) return parseConversationId(raw[0]);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export default async function ChatPage({ searchParams }: ChatPageProps) {
  const activeId = parseConversationId(searchParams?.c);

  let conversations: ChatConversation[] = [];
  let initialMessages: ChatMessage[] = [];
  let error: string | null = null;

  try {
    const [convs, msgs] = await Promise.all([
      listConversations(),
      activeId ? getConversationMessages(activeId) : Promise.resolve([] as ChatMessage[]),
    ]);
    conversations = convs;
    initialMessages = msgs;
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load conversations';
  }

  if (error) {
    return (
      <AppShell active={{ kind: 'surface', surface: 'chat' }}>
        <header className="flex h-12 shrink-0 items-center border-b border-border-subtle bg-bg-panel px-4">
          <h1 className="font-sans text-sm font-semibold tracking-tight">Chat</h1>
        </header>
        <div className="m-4 rounded-sm border border-accent-red/40 bg-accent-red/10 p-4 text-sm text-accent-red">
          <p className="mb-1 font-medium">Failed to load chat</p>
          <p className="font-mono text-xs">{error}</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell active={{ kind: 'surface', surface: 'chat' }}>
      <ChatClient
        conversations={conversations}
        activeConversationId={activeId}
        initialMessages={initialMessages}
      />
    </AppShell>
  );
}
