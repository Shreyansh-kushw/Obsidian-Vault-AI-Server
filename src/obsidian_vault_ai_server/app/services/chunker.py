from docling.chunking import HybridChunker
from docling_core.transforms.chunker.tokenizer.huggingface import HuggingFaceTokenizer
from transformers import AutoTokenizer

EMBED_MODEL_ID = "BAAI/bge-base-en-v1.5"
MAX_TOKENS = 512

# initalizing the tokenizer
tokenizer = HuggingFaceTokenizer(
    tokenizer=AutoTokenizer.from_pretrained(EMBED_MODEL_ID), max_tokens=MAX_TOKENS
)

# initializing the chunker
chunker = HybridChunker(tokenizer=tokenizer, merge_peers=True)


def generate_chunks(dl_doc):
    """Takes in a docling document and returns an iterable of chunks"""

    chunks_iter = chunker.chunk(dl_doc=dl_doc)

    return list(chunks_iter)
