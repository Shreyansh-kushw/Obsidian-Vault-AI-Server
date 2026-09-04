from app.models import Chunks

def reciprocal_rank_fusion(
    ranked_lists: list[list[Chunks]],
    k: int = 60, # constant used in the rrf formula
) -> list[Chunks]:
    
    """
    Performs Reciprocal Rank Fusion (RRF) to merge multiple ranked lists of chunks.

    RRF combines ranked results from different retrieval systems (or different
    retrieval strategies) by scoring each chunk based on its rank in each list.
    The formula used is `score = k / (rank + k)` for each chunk.

    This is particularly useful when you have multiple search results (e.g., from
    different embedding models or search methods) and want to combine them into a
    single ranked list that gives credit to chunks appearing early in any of the
    input lists.

    Args:
        ranked_lists: A list of already ranked chunk lists, sorted from most
            relevant to least relevant chunks in each list.
            
            e.g.,
            ranked_lists = [
                vector_search_results,
                keyword_search_results
            ]
            
        k: The constant used in the RRF formula. Higher values of k give
            more weight to the rank position (less aggressive discounting).
            Defaults to 60, a common value for RRF.

    Returns:
        A new list of Chunks sorted by their combined RRF score in descending
        order (most relevant first). Each chunk appears only once in the
        returned list.
    """

    scores: dict[int, float] = {}
    chunk_map:dict[int, Chunks] = {}

    for ranked_list in ranked_lists:
        for rank, chunk in enumerate(ranked_list):

            chunk_map[chunk.id] = chunk
            scores[chunk.id] = scores.get(chunk.id, 0.0) + (1.0 / (k + rank))

    sorted_chunks = sorted(
        scores.keys(), 
        key= lambda chunk_id: scores[chunk_id],
        reverse=True,
    )  

    return [chunk_map[c_id] for c_id in sorted_chunks]
