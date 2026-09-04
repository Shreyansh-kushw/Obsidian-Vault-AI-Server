from sentence_transformers import SentenceTransformer

model = SentenceTransformer("BAAI/bge-base-en-v1.5")


def generate_embeddings(chunk: str | list[str]):
    """Generates and returns a list of embeddings of all the chunks.
    Args:
        str | list[str]
    Output:
        str -> embedding
        list[str] -> list of embeddings
    """

    return model.encode(chunk)
