// dashboard/lib/rag/embed.ts
//
// STAQPRO-190 — wrap nomic-embed-text:v1.5 via Ollama's /api/embeddings.
// Returns a 768-dimension cosine-normalized vector. The Qdrant
// `email_messages` collection (STAQPRO-188) was created with size=768 /
// distance=Cosine to match this model exactly — do not swap the model
// without re-embedding the corpus.
//
// Failure mode: returns null on any error (Ollama unreachable, model not
// pulled, invalid payload). Callers should treat null as "skip indexing,
// don't fail the pipeline" — RAG is augmentation, not gate (per the issue).

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://ollama:11434';
const EMBED_MODEL = process.env.EMBED_MODEL ?? 'nomic-embed-text:v1.5';
const EMBED_TIMEOUT_MS = Number(process.env.EMBED_TIMEOUT_MS ?? 10000);

export const EMBED_VECTOR_SIZE = 768;

interface OllamaEmbeddingsResponse {
  embedding?: number[];
}

export async function embedText(input: string): Promise<number[] | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: trimmed }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[rag/embed] ollama returned ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = (await res.json()) as OllamaEmbeddingsResponse;
    if (!data.embedding || data.embedding.length !== EMBED_VECTOR_SIZE) {
      console.error(
        `[rag/embed] unexpected embedding shape: length=${data.embedding?.length ?? 'null'}`,
      );
      return null;
    }
    return data.embedding;
  } catch (error) {
    console.error('[rag/embed] embedding call threw:', error);
    return null;
  }
}
