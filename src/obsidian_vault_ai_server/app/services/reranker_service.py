from sentence_transformers import CrossEncoder

from obsidian_vault_ai_server.app.models import ObsidianChunks

model = CrossEncoder("cross-encoder/ms-marco-MiniLM-L6-v2")


def rerank(
    query: str, fused_chunks: list[ObsidianChunks], top_k: int = 5
) -> list[ObsidianChunks]:
    """Takes in the list of fused chunks and reranks them using the cross encoder model"""

    if not fused_chunks:
        return []

    candidate_chunks = fused_chunks[:20]
    pairs = [[query, chunk.chunk_text] for chunk in candidate_chunks]
    scores = model.predict(pairs)

    # sorting the chunks based on their scores descending
    reranked_chunks = [
        chunk
        for _, chunk in sorted(
            zip(scores, candidate_chunks), key=lambda x: x[0], reverse=True
        )
    ]

    return reranked_chunks[:top_k]