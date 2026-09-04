from sentence_transformers import CrossEncoder

from app.models import Chunks

model = CrossEncoder("cross-encoder/ms-marco-MiniLM-L6-v2")

def rerank(query:str, fused_chunks: list[Chunks]) -> list[Chunks]:
    """Takes in the list of fused chunks and reranks them using the cross encoder model"""

    pairs = [[query, chunk.chunk_text] for chunk in fused_chunks[:20]]
    scores = model.predict(pairs)

    # sorting the chunks based on their scores
    
    reranked_chunks = [chunk for _, chunk in sorted(zip(scores, fused_chunks[:20]), key= lambda x: x[0], reverse=True)]

    return reranked_chunks[:5]